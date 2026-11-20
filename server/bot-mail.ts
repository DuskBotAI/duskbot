// A bot's own inbound address (<handle>@in.dusk.bot, and <handle>+<alias>@ for each route). Mail reaches the mail edge
// (apps/cloudflare/inbound-mail), which posts it to this server's /hooks/mail/<id> door with the secret it registered;
// each route names an automation and the senders it takes mail from, and a message becomes that automation's run
// with the mail as outside event data.
//
// Security invariant: a From header can be forged. A sender is taken only when it is on the route's list and the
// receiving side found no failed DMARC, or failed SPF and DKIM together; mail from anyone else is dropped without a
// reply, so the address never answers spam.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { header, json } from "./webhook-ingress.ts";

export const MAIL_PATH = /^\/hooks\/mail\/(mb_[A-Za-z0-9_-]{8,64})$/;
export const MAX_MAIL_BODY_BYTES = 300 * 1024;
const MAX_TEXT = 20_000;
const MAX_ROUTES = 20;
const MAX_SENDERS = 50;
const ALIAS = /^[a-z0-9][a-z0-9._-]{0,30}$/;
const SENDER = /^(?:[^\s@<>()",;:]{1,64}@|@)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const REGISTER_TIMEOUT_MS = 20_000;

const routeSchema = z.object({ alias: z.string(), targetId: z.string().min(1), from: z.array(z.string()) });
const mailboxSchema = z.object({
  botId: z.string().min(1),
  id: z.string().regex(/^mb_[A-Za-z0-9_-]{8,64}$/),
  handle: z.string().min(1),
  /** Proves this server owns the handle at the edge; kept so a moved home keeps its address. */
  key: z.string().min(32),
  secretHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  registeredUrl: z.string().optional(),
  problem: z.string().optional(),
  received: z.number().int().nonnegative().default(0),
  dropped: z.number().int().nonnegative().default(0),
  routes: z.array(routeSchema),
});
const fileSchema = z.object({ version: z.literal(1), mailboxes: z.array(mailboxSchema) });
const deliverySchema = z.object({ from: z.string().max(400).optional(), to: z.string().max(400), raw: z.string().max(MAX_MAIL_BODY_BYTES) });

type Mailbox = z.output<typeof mailboxSchema>;
export type MailRoute = z.output<typeof routeSchema>;

export interface MailEvent {
  payload: { from: string; fromName?: string; to: string; subject: string; date?: string; text: string; attachments?: string[]; truncated?: true };
  eventName: "email";
  contentType: "message/rfc822";
  userAgent: string;
  deliveryId: string;
}

export interface BotMailDeps {
  file: string;
  /** Where this server's addresses start, e.g. https://you.dusk.cloud; anything else cannot be reached by the edge. */
  hooksBase(): string;
  edge: { url: string; domain: string };
  fetch?: typeof fetch;
  bot(botId: string): { name: string } | null;
  /** The automation a route names, or why it can't take mail. */
  target(botId: string, targetId: string): { ok: true; name: string } | { ok: false; error: string };
  deliver(botId: string, targetId: string, event: MailEvent): void;
  arrived?(): void;
  log?(line: string): void;
}

export interface MailboxView {
  address: string;
  reachable: boolean;
  problem?: string;
  received: number;
  dropped: number;
  routes: Array<MailRoute & { address: string; name: string }>;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const slug = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "bot";

function sameSecret(given: string, hash: string | undefined): boolean {
  if (!given || !hash) return false;
  const a = Buffer.from(sha256(given), "hex"), b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** "@vendor.com" takes the whole domain; anything else is one address. */
export function senderAllowed(list: readonly string[], address: string): boolean {
  const lower = address.trim().toLowerCase();
  const domain = lower.slice(lower.lastIndexOf("@"));
  return list.some((entry) => entry === lower || (entry.startsWith("@") && entry === domain));
}

/** The receiving side's verdict, from the topmost Authentication-Results it added. */
export function failedAuthentication(results: string | undefined): boolean {
  if (!results) return false;
  const text = results.toLowerCase();
  if (/\bdmarc=fail\b/.test(text)) return true;
  return /\bspf=(?:fail|softfail)\b/.test(text) && !/\bdkim=pass\b/.test(text);
}

export function cleanSenders(values: readonly unknown[]): string[] | string {
  const out: string[] = [];
  for (const value of values) {
    const entry = String(value ?? "").trim().toLowerCase();
    if (!SENDER.test(entry)) return `"${String(value).slice(0, 80)}" is not an email address or an @domain.`;
    if (!out.includes(entry)) out.push(entry);
  }
  return out.length > MAX_SENDERS ? `At most ${MAX_SENDERS} senders.` : out;
}

export function createBotMail(deps: BotMailDeps) {
  const doFetch = deps.fetch ?? fetch;
  let mailboxes: Mailbox[] = load();
  let syncing: Promise<void> | null = null;
  let again = false;

  function load(): Mailbox[] {
    try {
      return fileSchema.parse(JSON.parse(readFileSync(deps.file, "utf8"))).mailboxes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") deps.log?.("bot-mail: ignoring an unreadable bot-mail.json");
      return [];
    }
  }

  function save(): void {
    mkdirSync(dirname(deps.file), { recursive: true });
    writeFileAtomic(deps.file, JSON.stringify({ version: 1, mailboxes }), { mode: 0o600 });
  }

  const address = (box: Mailbox, alias = "") => `${box.handle}${alias ? `+${alias}` : ""}@${deps.edge.domain}`;
  const urlOf = (box: Mailbox) => `${deps.hooksBase().replace(/\/+$/, "")}/hooks/mail/${box.id}`;
  const reachableBase = () => deps.hooksBase().startsWith("https://");

  function view(box: Mailbox): MailboxView {
    return {
      address: address(box),
      reachable: Boolean(box.secretHash && box.registeredUrl === urlOf(box)),
      ...(box.problem ? { problem: box.problem } : {}),
      received: box.received,
      dropped: box.dropped,
      routes: box.routes.map((route) => {
        const target = deps.target(box.botId, route.targetId);
        return { ...route, address: address(box, route.alias), name: target.ok ? target.name : "(deleted)" };
      }),
    };
  }

  function ensure(botId: string): Mailbox {
    const held = mailboxes.find((box) => box.botId === botId);
    if (held) return held;
    const bot = deps.bot(botId);
    if (!bot) throw Object.assign(new Error("No bot with that id"), { status: 404 });
    const box: Mailbox = {
      botId, id: `mb_${randomBytes(12).toString("base64url")}`,
      handle: `${slug(bot.name)}-${randomBytes(5).toString("hex")}`,
      key: randomBytes(32).toString("base64url"), received: 0, dropped: 0, routes: [],
    };
    mailboxes.push(box);
    save();
    return box;
  }

  /** Tells the edge where this mailbox's mail goes, with a fresh secret; the edge checks the door answers first. */
  async function register(box: Mailbox): Promise<void> {
    if (!reachableBase()) {
      box.problem = "This computer can't receive mail from the internet yet. Turn on Remote access in Settings, or use dusk cloud.";
      return;
    }
    const url = urlOf(box);
    const secret = randomBytes(32).toString("base64url");
    const previous = box.secretHash;
    box.secretHash = sha256(secret);
    try {
      const response = await doFetch(`${deps.edge.url.replace(/\/+$/, "")}/v1/mailboxes/${encodeURIComponent(box.handle)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, secret, key: box.key }),
        signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
      });
      if (response.status === 409) {
        box.handle = `${slug(deps.bot(box.botId)?.name ?? "bot")}-${randomBytes(5).toString("hex")}`;
        box.problem = "Its address was taken elsewhere, so it has a new one.";
        box.secretHash = previous;
        return;
      }
      if (!response.ok) throw new Error(`the mail edge answered ${response.status}`);
      box.registeredUrl = url;
      delete box.problem;
    } catch (error) {
      box.secretHash = previous;
      box.problem = "Mail can't reach this bot right now; dusk bot tries again on its own.";
      deps.log?.(`bot-mail: could not register a mailbox: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Registers every mailbox with a route whose address moved or never reached the edge. One pass at a time. */
  function sync(): Promise<void> {
    if (syncing) { again = true; return syncing; }
    syncing = (async () => {
      do {
        again = false;
        for (const box of mailboxes) {
          if (!box.routes.length || (box.secretHash && box.registeredUrl === urlOf(box) && !box.problem)) continue;
          await register(box);
        }
        save();
      } while (again);
    })().finally(() => { syncing = null; });
    return syncing;
  }

  async function door(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const match = MAIL_PATH.exec(url.pathname);
    if (!match) return false;
    if (req.method !== "POST") { json(res, 405, { error: "POST only" }); return true; }
    deps.arrived?.();
    const box = mailboxes.find((candidate) => candidate.id === match[1]);
    const given = /^Bearer\s+(.+)$/i.exec(header(req, "authorization") ?? "")?.[1]?.trim() ?? "";
    if (!box || !sameSecret(given, box.secretHash)) { json(res, 401, { error: "Unknown mailbox" }); return true; }
    const nonce = header(req, "x-dusk-mail-check");
    if (nonce) {
      json(res, 200, { check: createHmac("sha256", given).update(nonce.slice(0, 200)).digest("hex") });
      return true;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readCapped(req));
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 400, { error: "Expected the mail edge's JSON" });
      return true;
    }
    const delivery = deliverySchema.safeParse(body);
    if (!delivery.success) { json(res, 400, { error: "Expected the mail edge's JSON" }); return true; }
    try {
      const outcome = await receive(box, delivery.data);
      json(res, 202, outcome);
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      json(res, status, { error: status >= 500 ? "The bot could not take this mail" : (error as Error).message });
    }
    return true;
  }

  async function receive(box: Mailbox, delivery: z.output<typeof deliverySchema>): Promise<{ accepted: boolean; ignored?: string }> {
    const local = delivery.to.toLowerCase().split("@")[0] ?? "";
    const plus = local.indexOf("+");
    const alias = plus === -1 ? "" : local.slice(plus + 1);
    const route = box.routes.find((candidate) => candidate.alias === alias);
    const drop = (why: string) => { box.dropped += 1; save(); return { accepted: false, ignored: why }; };
    if (!route) return drop("no route");
    const { simpleParser } = await import("mailparser");
    const raw = Buffer.from(delivery.raw, "base64");
    const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextLinks: true, skipHtmlToText: false });
    const sender = parsed.from?.value[0];
    const fromAddress = sender?.address?.toLowerCase() ?? "";
    if (!fromAddress || !senderAllowed(route.from, fromAddress)) return drop("sender not allowed");
    const results = parsed.headers.get("authentication-results") ?? parsed.headers.get("arc-authentication-results");
    if (failedAuthentication(typeof results === "string" ? results : Array.isArray(results) ? String(results[0]) : undefined)) return drop("failed authentication");
    const text = (parsed.text ?? "").trim();
    const attachments = parsed.attachments.map((file) => file.filename).filter((name): name is string => Boolean(name)).slice(0, 20);
    deps.deliver(box.botId, route.targetId, {
      payload: {
        from: fromAddress,
        ...(sender?.name ? { fromName: sender.name.slice(0, 200) } : {}),
        to: delivery.to.slice(0, 200),
        subject: (parsed.subject ?? "").slice(0, 500),
        ...(parsed.date ? { date: parsed.date.toISOString() } : {}),
        text: text.slice(0, MAX_TEXT),
        ...(attachments.length ? { attachments } : {}),
        ...(text.length > MAX_TEXT ? { truncated: true as const } : {}),
      },
      eventName: "email",
      contentType: "message/rfc822",
      userAgent: "email",
      deliveryId: `mail:${(parsed.messageId ?? sha256(delivery.raw)).slice(0, 180)}`,
    });
    box.received += 1;
    save();
    return { accepted: true };
  }

  return {
    door,
    sync,
    view(botId: string): MailboxView | null {
      const box = mailboxes.find((candidate) => candidate.botId === botId);
      return box ? view(box) : null;
    },
    /** The bot's address, made the first time; registering happens in the background once it has a route. */
    open(botId: string): MailboxView {
      return view(ensure(botId));
    },
    /** Mail to <handle>+<alias> (or the bare address for "") runs `targetId`, from these senders only. No senders
     *  removes the route. */
    async setRoute(botId: string, input: { alias: string; targetId: string; from: readonly unknown[] }): Promise<MailboxView> {
      const alias = input.alias.trim().toLowerCase();
      if (alias && !ALIAS.test(alias)) throw Object.assign(new Error("An alias is up to 31 letters, digits, dots, dashes or underscores."), { status: 400 });
      const senders = cleanSenders(input.from);
      if (typeof senders === "string") throw Object.assign(new Error(senders), { status: 400 });
      const box = ensure(botId);
      const kept = box.routes.filter((route) => route.alias !== alias);
      if (senders.length) {
        const target = deps.target(botId, input.targetId);
        if (!target.ok) throw Object.assign(new Error(target.error), { status: 400 });
        if (kept.length >= MAX_ROUTES) throw Object.assign(new Error(`A bot has at most ${MAX_ROUTES} mail routes.`), { status: 400 });
        kept.push({ alias, targetId: input.targetId, from: senders });
      }
      box.routes = kept;
      save();
      await sync();
      return view(box);
    },
    /** The automation went: its routes go too. */
    forgetTarget(targetId: string): void {
      let changed = false;
      for (const box of mailboxes) {
        const kept = box.routes.filter((route) => route.targetId !== targetId);
        if (kept.length !== box.routes.length) { box.routes = kept; changed = true; }
      }
      if (changed) save();
    },
    async removeForBot(botId: string): Promise<void> {
      const box = mailboxes.find((candidate) => candidate.botId === botId);
      if (!box) return;
      mailboxes = mailboxes.filter((candidate) => candidate !== box);
      save();
      try {
        await doFetch(`${deps.edge.url.replace(/\/+$/, "")}/v1/mailboxes/${encodeURIComponent(box.handle)}`, {
          method: "DELETE", headers: { authorization: `Bearer ${box.key}` }, signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
        });
      } catch {}
    },
    addressesMoved(): void { void sync(); },
  };
}

async function readCapped(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_MAIL_BODY_BYTES + 1024) throw Object.assign(new Error("Mail is too large"), { status: 413 });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type BotMail = ReturnType<typeof createBotMail>;
