// What server/index.ts needs from a bot's own chat-app accounts (Telegram, Discord), in one object: the owner routes,
// the chat_app_bots tool's internal route, the public webhook door, log redaction and the background work.
// Security: tokens stay in this process and the encrypted store. Only the person who sends the pairing code, people
// they let in and group chats they let in reach the bot; everyone else is turned away and listed for the owner. Turns
// from anyone but the owner in a direct chat run as outside work. A messenger conversation never manages messengers.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { MESSENGER_LABELS, isMessengerPlatform, type MessengerPlatform, type MessengerStatus, type MessengersStatus } from "../../shared/messengers.ts";
import { MESSENGER_TOOL_PATH } from "../drivers/agents-messenger-tool.ts";
import type { json as sendJson } from "../harness/http.ts";
import { HELD_SECRET_MASK } from "../redact.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import type { UsageTrigger } from "../usage-ledger.ts";
import type { SavedSecretsKey } from "../saved-secrets.ts";
import { createMessengerBridge, personLetIn, type MessengerBridgeDeps, type MessengerTransport } from "./bridge.ts";
import { createDiscordApi, createDiscordGateway, createDiscordTransport, deferDiscordChoice, readDiscordInteraction, readDiscordReaction, discordInviteUrl, discordMe, DiscordError, DISCORD_TOKEN, readDiscordMessage, type DiscordApi } from "./discord.ts";
import { MessengerSecretStore, MessengerSecretsUnavailable, type MessengerLink } from "./secrets.ts";
import { MessengerState } from "./state.ts";
import {
  createTelegramApi, createTelegramPoller, createTelegramTransport, hookAnswer, readTelegramUpdate, telegramHookSecretMatches, telegramMe,
  TelegramError, TELEGRAM_HOOK_PATH, TELEGRAM_TOKEN, TELEGRAM_UPDATES, type TelegramApi,
} from "./telegram.ts";

const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_PAIR_MISSES = 20;
const HOOK_BODY_MAX = 1024 * 1024;

export interface MessengerHostDeps extends Pick<MessengerBridgeDeps, "createThread" | "threadExists" | "messages" | "saveAttachment" | "readAttachment"> {
  dataDir: string;
  key: SavedSecretsKey;
  bot(botId: string): { id: string; name: string } | null;
  send: MessengerBridgeDeps["send"];
  answerCard: MessengerBridgeDeps["answerCard"];
  onStoreChange(listener: (change: { type: string; botId?: string; threadId?: string }) => void): () => void;
  /** https origin Telegram can post to, on a Cloud home whose edge wakes it; null where this process polls instead. */
  hookBase(): string | null;
  /** A delivery came in through the public door (a Cloud home counts it as activity). */
  arrived?(): void;
  /** Why this conversation may not manage the bot's chat apps (a guest's, an automation's), or null. */
  toolRefusal?(botId: string, threadId: string): string | null;
  /** Why this conversation may not message the bot's owner on a chat app (a guest's), or null; an automation's may. */
  sendRefusal?(botId: string, threadId: string): string | null;
  env?: NodeJS.ProcessEnv;
  telegramApi?: TelegramApi;
  discordApi?: DiscordApi;
  WebSocket?: typeof WebSocket;
  log?: (line: string) => void;
  settleMs?: number;
}

export class MessengerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = "MessengerError"; this.status = status; }
}

type Runner = { stop(): unknown };
type Runtime = { state: MessengerStatus["state"]; error?: string; delivery?: MessengerStatus["delivery"] };

const pairCode = () => Array.from(randomBytes(8), (byte) => PAIR_ALPHABET[byte % PAIR_ALPHABET.length]).join("");
const runKey = (botId: string, platform: MessengerPlatform) => `${platform}:${botId}`;

function platformError(platform: MessengerPlatform, error: unknown): MessengerError {
  if (error instanceof MessengerError) return error;
  if (error instanceof MessengerSecretsUnavailable) return new MessengerError(503, error.message);
  const label = MESSENGER_LABELS[platform];
  const code = error instanceof TelegramError || error instanceof DiscordError ? error.code : -1;
  if (code === 401 || code === 404) return new MessengerError(422, `${label} didn't accept that token. Copy it again and paste the whole thing.`);
  if (code === 0) return new MessengerError(502, `${label} couldn't be reached. Try again in a moment.`);
  if (code === 429) return new MessengerError(429, `${label} is busy. Try again in a minute.`);
  if (code === 400 && error instanceof Error) return new MessengerError(422, error.message);
  return new MessengerError(502, `${label} refused that. Try again in a moment.`);
}

/** How a chat-app line enters the conversation. The owner's own direct chat is the owner at the keyboard (full trust,
 * memory, their own details); anyone else, or any group, is a relayed outsider. */
export function messengerSendAs(outside: boolean, name: string): { trigger: UsageTrigger; personPresent: boolean } & ({ sender: { name: string }; relayed: true } | Record<never, never>) {
  return outside ? { sender: { name }, trigger: { kind: "user", label: name }, personPresent: false, relayed: true } : { trigger: { kind: "owner" }, personPresent: true };
}

export function createMessengerHost(deps: MessengerHostDeps) {
  const log = deps.log ?? ((line: string) => console.warn(`Chat apps: ${line}`));
  const env = deps.env ?? process.env;
  const telegram = deps.telegramApi ?? createTelegramApi({ env });
  const discord = deps.discordApi ?? createDiscordApi({ env });
  const secrets = new MessengerSecretStore({ dataDir: deps.dataDir, key: deps.key });
  const state = new MessengerState(deps.dataDir);
  const runners = new Map<string, Runner>();
  const runtime = new Map<string, Runtime>();
  const channelNames = new Map<string, string>();
  const link = (botId: string, platform: MessengerPlatform): MessengerLink | null => (secrets.ready() ? secrets.link(botId, platform) : null);
  const token = (platform: MessengerPlatform) => (botId: string) => link(botId, platform)?.token ?? null;
  const transports: Record<MessengerPlatform, MessengerTransport> = {
    telegram: createTelegramTransport(telegram, token("telegram")),
    discord: createDiscordTransport(discord, token("discord")),
  };

  const bridge = createMessengerBridge({
    state, log, transport: (platform) => transports[platform], link, bot: deps.bot,
    createThread: deps.createThread, threadExists: deps.threadExists, send: deps.send, messages: deps.messages, answerCard: deps.answerCard,
    onChange: deps.onStoreChange, saveAttachment: deps.saveAttachment, readAttachment: deps.readAttachment,
    ...(deps.settleMs !== undefined ? { settleMs: deps.settleMs } : {}),
    claim: (botId, platform, owner) => {
      secrets.patch(botId, platform, { owner: { id: owner.id, kind: "person", name: owner.name }, pairCode: undefined, pairMisses: undefined });
      state.forgetKnock(botId, platform, owner.id);
    },
    pairMiss: (botId, platform) => {
      const one = link(botId, platform);
      if (!one?.pairCode) return;
      const misses = (one.pairMisses ?? 0) + 1;
      secrets.patch(botId, platform, misses >= MAX_PAIR_MISSES ? { pairCode: undefined, pairMisses: undefined } : { pairMisses: misses });
    },
  });

  const setRuntime = (botId: string, platform: MessengerPlatform, value: Runtime) => runtime.set(runKey(botId, platform), value);

  async function telegramUpdate(botId: string, update: Record<string, unknown>): Promise<void> {
    const one = link(botId, "telegram");
    if (!one) return;
    const read = readTelegramUpdate(update, {
      botId, account: one.account,
      file: async (fileId) => {
        const key = link(botId, "telegram")?.token;
        if (!key) throw new TelegramError(401, "No token.");
        const file = await telegram.call<{ file_path?: string }>(key, "getFile", { file_id: fileId });
        if (!file.file_path) throw new TelegramError(413, "Telegram keeps files over 20 MB from bots.");
        return telegram.download(key, file.file_path, 20 * 1024 * 1024);
      },
    });
    if (!read) return;
    if ("choice" in read) { await bridge.choose(read.choice); return; }
    if ("reaction" in read) { await bridge.react(read.reaction); return; }
    if ("added" in read) {
      const { chatId, title, by } = read.added;
      if (!personLetIn(one, by.id) || one.allowed.some((entry) => entry.kind === "chat" && entry.id === chatId)) return;
      secrets.patch(botId, "telegram", { allowed: [...one.allowed, { id: chatId, kind: "chat", name: title }] });
      await transports.telegram.sendText(botId, chatId, `Hi. Mention @${one.account.username} or reply to me to talk to ${deps.bot(botId)?.name ?? "me"} here.`).catch(() => {});
      return;
    }
    await bridge.receive(read.message);
  }

  async function discordMessage(botId: string, data: Record<string, unknown>): Promise<void> {
    const one = link(botId, "discord");
    if (!one) return;
    const message = readDiscordMessage(data, { botId, account: one.account, download: (url) => discord.download(url, 20 * 1024 * 1024) });
    if (!message) return;
    if (message.chatKind === "group" && message.addressed) {
      const cached = channelNames.get(message.chatId);
      const name = cached ?? await discord.call<{ name?: string }>(one.token, "GET", `/channels/${encodeURIComponent(message.chatId)}`).then((channel) => channel.name ?? "", () => "");
      if (name) { channelNames.set(message.chatId, name); message.chatTitle = `#${name}`; }
    }
    await bridge.receive(message);
  }

  async function discordInteraction(botId: string, data: Record<string, unknown>): Promise<void> {
    const one = link(botId, "discord");
    const choice = one ? readDiscordInteraction(data, { botId }) : null;
    if (!one || !choice) return;
    await deferDiscordChoice(discord, one.token, choice.ack).catch(() => log("A Discord button press could not be acknowledged."));
    await bridge.choose(choice);
  }

  function stopRunner(botId: string, platform: MessengerPlatform): void {
    runners.get(runKey(botId, platform))?.stop();
    runners.delete(runKey(botId, platform));
  }

  async function startTelegram(botId: string, explicit: boolean): Promise<void> {
    stopRunner(botId, "telegram");
    const one = link(botId, "telegram");
    if (!one) return;
    const base = deps.hookBase();
    if (base) {
      const secret = one.webhookSecret ?? randomBytes(32).toString("base64url");
      if (!one.webhookSecret) secrets.patch(botId, "telegram", { webhookSecret: secret });
      try {
        await telegram.call(one.token, "setWebhook", { url: `${base}/hooks/telegram/${botId}`, secret_token: secret, allowed_updates: TELEGRAM_UPDATES, max_connections: 4 });
        setRuntime(botId, "telegram", { state: "online", delivery: "webhook" });
      } catch (error) {
        setRuntime(botId, "telegram", { state: "error", delivery: "webhook", error: platformError("telegram", error).message });
        if (explicit) throw platformError("telegram", error);
        const timer = setTimeout(() => void startTelegram(botId, false), 60_000);
        timer.unref();
        runners.set(runKey(botId, "telegram"), { stop: () => clearTimeout(timer) });
      }
      return;
    }
    try {
      const info = await telegram.call<{ url?: string }>(one.token, "getWebhookInfo");
      if (info.url) {
        if (!explicit && !info.url.endsWith(`/hooks/telegram/${botId}`)) {
          setRuntime(botId, "telegram", { state: "error", delivery: "polling", error: "Another app receives this Telegram bot's messages. Connect it again here to take it over." });
          return;
        }
        await telegram.call(one.token, "deleteWebhook", { drop_pending_updates: false });
      }
    } catch (error) {
      if (explicit) throw platformError("telegram", error);
    }
    const poller = createTelegramPoller({
      api: telegram, log,
      token: () => link(botId, "telegram")?.token ?? null,
      offset: () => state.offset(botId), setOffset: (offset) => state.setOffset(botId, offset),
      onUpdate: (update) => telegramUpdate(botId, update),
      onState: (value, error) => setRuntime(botId, "telegram", { state: value, delivery: "polling", ...(error ? { error } : {}) }),
      ...(env.DUSK_TELEGRAM_POLL_SECONDS ? { pollSeconds: Number(env.DUSK_TELEGRAM_POLL_SECONDS) } : {}),
    });
    runners.set(runKey(botId, "telegram"), poller);
    poller.start();
  }

  function startDiscord(botId: string): void {
    stopRunner(botId, "discord");
    if (!link(botId, "discord")) return;
    const gateway = createDiscordGateway({
      api: discord, log, ...(deps.WebSocket ? { WebSocket: deps.WebSocket } : {}),
      token: () => link(botId, "discord")?.token ?? null,
      onMessage: (data) => { void discordMessage(botId, data).catch(() => log("A Discord message could not be handled.")); },
      onInteraction: (data) => { void discordInteraction(botId, data).catch(() => log("A Discord button press could not be handled.")); },
      onReaction: (data) => { const one = link(botId, "discord"), reaction = one ? readDiscordReaction(data, { botId, account: one.account }) : null; if (reaction) void bridge.react(reaction); },
      onState: (value, error) => setRuntime(botId, "discord", { state: value, delivery: "gateway", ...(error ? { error } : {}) }),
    });
    runners.set(runKey(botId, "discord"), gateway);
    gateway.start();
  }

  async function start(botId: string, platform: MessengerPlatform, explicit: boolean): Promise<void> {
    if (platform === "telegram") await startTelegram(botId, explicit);
    else startDiscord(botId);
  }

  function status(botId: string, platform: MessengerPlatform): MessengerStatus {
    const one = link(botId, platform);
    if (!one) return { platform, state: "not_connected", allowed: [], knocked: [] };
    const run = runtime.get(runKey(botId, platform)) ?? { state: "connecting" as const };
    const handle = platform === "telegram" ? `@${one.account.username}` : one.account.name;
    const openUrl = platform === "telegram" ? `https://t.me/${one.account.username}` : discordInviteUrl(one.account.appId ?? one.account.id);
    const pairing = one.pairCode && !one.owner ? (platform === "telegram" ? { pairUrl: `https://t.me/${one.account.username}?start=${one.pairCode}`, pairCode: one.pairCode } : { pairCode: one.pairCode }) : {};
    return {
      platform, state: run.state, handle, openUrl, ...pairing,
      ...(one.owner ? { owner: one.owner } : {}), allowed: one.allowed,
      knocked: state.knocks(botId, platform).map(({ id, kind, name, at }) => ({ id, kind, name, at })).sort((a, b) => b.at - a.at),
      ...(run.delivery ? { delivery: run.delivery } : {}), ...(run.state === "error" && run.error ? { error: run.error } : {}),
    };
  }
  const statuses = (botId: string): MessengersStatus => ({ botId, platforms: (["telegram", "discord"] as const).map((platform) => status(botId, platform)) });

  async function connect(botId: string, platform: MessengerPlatform, raw: string, carried: { allowed?: MessengerLink["allowed"] } = {}): Promise<MessengerStatus> {
    if (!deps.bot(botId)) throw new MessengerError(404, "No such bot.");
    const value = raw.trim();
    const shape = platform === "telegram" ? TELEGRAM_TOKEN : DISCORD_TOKEN;
    if (!shape.test(value)) {
      throw new MessengerError(400, platform === "telegram"
        ? "That isn't a Telegram bot token. BotFather gives one like 123456789:AA… when you create a bot with /newbot."
        : "That isn't a Discord bot token. Copy it from the Developer Portal, your app, Bot, Reset Token.");
    }
    let account;
    try { account = platform === "telegram" ? await telegramMe(telegram, value) : await discordMe(discord, value); }
    catch (error) { throw platformError(platform, error); }
    const taken = secrets.links().find((one) => one.platform === platform && one.account.id === account.id && one.botId !== botId);
    if (taken) throw new MessengerError(409, `That ${MESSENGER_LABELS[platform]} bot already answers for ${deps.bot(taken.botId)?.name ?? "another bot"}. Disconnect it there first, or make a new one.`);
    const old = link(botId, platform);
    const same = old?.account.id === account.id;
    // one person let in where the bot came from is its owner there: they need no pairing here
    const carriedPeople = (carried.allowed ?? []).filter((one) => one.kind === "person");
    const soleCarried = carriedPeople.length === 1 ? carriedPeople[0] : undefined;
    const allowed = [...(same ? old!.allowed : []), ...(carried.allowed ?? []).filter((one) => one !== soleCarried)].filter((one, index, all) => all.findIndex((other) => other.id === one.id) === index).slice(0, 200);
    stopRunner(botId, platform);
    if (old && !same) bridge.forgetBot(botId, platform);
    secrets.put({
      botId, platform, token: value, account, allowed, connectedAt: Date.now(),
      ...(same && old!.owner ? { owner: old!.owner } : soleCarried ? { owner: soleCarried } : { pairCode: pairCode() }),
      ...(same && old!.webhookSecret ? { webhookSecret: old!.webhookSecret } : {}),
    });
    setRuntime(botId, platform, { state: "connecting" });
    try { await start(botId, platform, true); }
    catch (error) { throw platformError(platform, error); }
    return status(botId, platform);
  }

  async function disconnect(botId: string, platform: MessengerPlatform): Promise<MessengerStatus> {
    const one = link(botId, platform);
    stopRunner(botId, platform);
    runtime.delete(runKey(botId, platform));
    bridge.forgetBot(botId, platform);
    secrets.remove(botId, platform);
    if (one?.platform === "telegram" && one.webhookSecret) await telegram.call(one.token, "deleteWebhook", {}).catch(() => {});
    return status(botId, platform);
  }

  function allow(botId: string, platform: MessengerPlatform, who: string, kind?: "person" | "chat"): MessengerStatus {
    const one = link(botId, platform);
    if (!one) throw new MessengerError(409, `This bot has no ${MESSENGER_LABELS[platform]} bot connected.`);
    const wanted = who.trim().replace(/^@/, "").toLowerCase();
    const knocked = state.knocks(botId, platform).find((entry) => entry.id === who.trim() || entry.name.toLowerCase() === wanted || entry.name.toLowerCase().replace(/^#/, "") === wanted);
    const id = knocked?.id ?? who.trim();
    if (!/^-?\d{1,24}$/.test(id)) throw new MessengerError(400, `No one called "${who}" has messaged the bot yet. Ask them to message it once, then let them in by name, or give their numeric ${MESSENGER_LABELS[platform]} id.`);
    const entryKind = knocked?.kind ?? kind ?? (platform === "telegram" && id.startsWith("-") ? "chat" : "person");
    if (!one.allowed.some((entry) => entry.id === id)) {
      secrets.patch(botId, platform, { allowed: [...one.allowed, { id, kind: entryKind, ...(knocked ? { name: knocked.name } : {}) }].slice(-200) });
    }
    state.forgetKnock(botId, platform, id);
    return status(botId, platform);
  }

  function disallow(botId: string, platform: MessengerPlatform, who: string): MessengerStatus {
    const one = link(botId, platform);
    if (!one) throw new MessengerError(409, `This bot has no ${MESSENGER_LABELS[platform]} bot connected.`);
    const wanted = who.trim().replace(/^@/, "").toLowerCase();
    if (one.owner && (one.owner.id === who.trim() || one.owner.name?.toLowerCase() === wanted)) {
      secrets.patch(botId, platform, { owner: undefined, pairCode: pairCode() });
      return status(botId, platform);
    }
    secrets.patch(botId, platform, { allowed: one.allowed.filter((entry) => entry.id !== who.trim() && entry.name?.toLowerCase() !== wanted) });
    return status(botId, platform);
  }

  async function hookDoor(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const match = TELEGRAM_HOOK_PATH.exec(url.pathname);
    if (!match) return false;
    if (req.method !== "POST") { hookAnswer(res, 405); return true; }
    const one = link(match[1]!, "telegram");
    if (!one || !telegramHookSecretMatches(req, one.webhookSecret)) { req.resume(); hookAnswer(res, 401); return true; }
    deps.arrived?.();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > HOOK_BODY_MAX) { hookAnswer(res, 413); return true; }
      chunks.push(chunk as Buffer);
    }
    let update: Record<string, unknown>;
    try { update = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
    catch { hookAnswer(res, 400); return true; }
    try { await telegramUpdate(match[1]!, update); } catch { log("A Telegram update could not be handled."); }
    hookAnswer(res, 200);
    return true;
  }

  const tokenBody = z.strictObject({ token: z.string().min(1).max(400) });
  const allowBody = z.strictObject({ id: z.string().min(1).max(200), kind: z.enum(["person", "chat"]).optional() });
  const ROUTE = /^\/api\/bots\/([\w-]{1,128})\/messengers(?:\/(telegram|discord)(?:\/allowed(?:\/([^/]{1,200}))?)?)?$/;

  const routes: RouteHandler = async ({ req, res, path, method, auth, json, readBody }) => {
    const match = ROUTE.exec(path);
    if (!match) return PASS;
    res.setHeader("cache-control", "no-store");
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Only the owner or an admin can manage a bot's chat apps." });
    const botId = match[1]!, platform = match[2] as MessengerPlatform | undefined;
    if (!deps.bot(botId)) return json(res, 404, { error: "No such bot." });
    try {
      if (!platform) return method === "GET" ? json(res, 200, statuses(botId)) : json(res, 405, { error: "method not allowed" });
      const allowedPath = path.includes("/allowed");
      if (allowedPath) {
        if (match[3] !== undefined) {
          if (method !== "DELETE") return json(res, 405, { error: "method not allowed" });
          return json(res, 200, disallow(botId, platform, decodeURIComponent(match[3])));
        }
        if (method !== "POST") return json(res, 405, { error: "method not allowed" });
        const body = allowBody.safeParse(await readBody(req, 4096));
        if (!body.success) return json(res, 400, { error: "Send the person's or group's id." });
        return json(res, 200, allow(botId, platform, body.data.id, body.data.kind));
      }
      if (method === "GET") return json(res, 200, status(botId, platform));
      if (method === "DELETE") return json(res, 200, await disconnect(botId, platform));
      if (method !== "PUT") return json(res, 405, { error: "method not allowed" });
      const body = tokenBody.safeParse(await readBody(req, 4096));
      if (!body.success) return json(res, 400, { error: "Paste the bot token." });
      return json(res, 200, await connect(botId, platform, body.data.token));
    } catch (error) {
      const answer = platform ? platformError(platform, error) : new MessengerError(500, "Something went wrong.");
      return json(res, answer.status, { error: answer.message });
    }
  };

  const toolBody = z.strictObject({
    action: z.enum(["status", "connect", "allow", "remove_access", "disconnect", "send"]),
    platform: z.string().optional(),
    token: z.string().max(400).optional(),
    who: z.string().max(200).optional(),
    text: z.string().max(4000).optional(),
  });

  /** The owner's own direct chat with this chat-app bot. */
  async function ownerChat(platform: MessengerPlatform, one: MessengerLink & { owner: NonNullable<MessengerLink["owner"]> }): Promise<string> {
    if (platform === "telegram") return one.owner.id;
    const channel = await discord.call<{ id?: string }>(one.token, "POST", "/users/@me/channels", { recipient_id: one.owner.id });
    if (!channel?.id) throw new DiscordError(502, "Discord did not open a direct message with the owner.");
    return channel.id;
  }

  async function sendToOwner(ctx: { res: ServerResponse; json: typeof sendJson; botId: string; threadId: string }, platform: string | undefined, text: string | undefined): Promise<void> {
    const refused = state.isMessengerThread(ctx.threadId)
      ? "This conversation already is a chat-app chat: answer here and it reaches them."
      : deps.sendRefusal?.(ctx.botId, ctx.threadId) ?? null;
    if (refused) return ctx.json(ctx.res, 403, { error: refused });
    if (!isMessengerPlatform(platform)) return ctx.json(ctx.res, 400, { error: "platform is telegram or discord." });
    if (!text?.trim()) return ctx.json(ctx.res, 400, { error: "send needs text: the message for the person." });
    const label = MESSENGER_LABELS[platform];
    const one = link(ctx.botId, platform);
    if (!one) return ctx.json(ctx.res, 409, { error: `No ${label} bot is connected. Ask the person for its token, then connect it.` });
    if (!one.owner) return ctx.json(ctx.res, 409, { error: `Not sent: the person has not claimed the ${label} bot yet, so it has no chat with them. ${describe(ctx.botId)}` });
    try {
      await transports[platform].sendText(ctx.botId, await ownerChat(platform, { ...one, owner: one.owner }), text.trim());
    } catch (error) {
      const answer = platformError(platform, error);
      return ctx.json(ctx.res, answer.status, { error: `Not sent: ${answer.message}` });
    }
    return ctx.json(ctx.res, 200, { text: `Sent to ${one.owner.name ?? "the person"} on ${label}.` });
  }

  /** The newest token of the platform's shape in the person's own lines of this conversation. */
  function pastedToken(threadId: string, platform: MessengerPlatform): string | null {
    const shape = new RegExp(`(?<![\\w:.-])(${(platform === "telegram" ? TELEGRAM_TOKEN : DISCORD_TOKEN).source.slice(1, -1)})(?![\\w.-])`, "g");
    for (const message of [...deps.messages(threadId)].reverse()) {
      if (message.role !== "user" || typeof message.text !== "string") continue;
      const found = [...message.text.matchAll(shape)].at(-1)?.[1];
      if (found) return found;
    }
    return null;
  }

  function describe(botId: string): string {
    return statuses(botId).platforms.map((one) => {
      const label = MESSENGER_LABELS[one.platform];
      if (one.state === "not_connected") return `${label}: not connected.`;
      const lines = [`${label}: ${one.handle}, ${one.state === "error" ? `not working: ${one.error}` : one.state === "online" ? "working" : "starting"}.`];
      if (one.pairUrl) lines.push(`Not claimed yet. Give the person this link to open on the phone or computer they use ${label} on: ${one.pairUrl}`);
      else if (one.pairCode) lines.push(`Not claimed yet. The person sends this code to the bot in a direct message on ${label}: ${one.pairCode}. Add it to a server with ${one.openUrl}`);
      else lines.push(`Owner: ${one.owner?.name ?? "someone"}. Open: ${one.openUrl}`);
      if (one.allowed.length) lines.push(`Also let in: ${one.allowed.map((entry) => `${entry.name ?? entry.id} (${entry.kind}, ${entry.id})`).join("; ")}.`);
      if (one.knocked.length) lines.push(`Turned away recently: ${one.knocked.map((entry) => `${entry.name} (${entry.kind}, ${entry.id})`).join("; ")}.`);
      return lines.join("\n");
    }).join("\n\n");
  }

  async function internal(ctx: { method: string; path: string; res: ServerResponse; json: typeof sendJson; botId: string; threadId: string; readBody(): Promise<unknown> }): Promise<typeof PASS | void> {
    if (ctx.path !== MESSENGER_TOOL_PATH) return PASS;
    if (ctx.method !== "POST") return ctx.json(ctx.res, 405, { error: "method not allowed" });
    const parsed = toolBody.safeParse(await ctx.readBody());
    if (!parsed.success) return ctx.json(ctx.res, 400, { error: "Use chat_app_bots with action and the fields it lists." });
    const { action, platform, token: raw, who, text } = parsed.data;
    if (action === "status") return ctx.json(ctx.res, 200, { text: describe(ctx.botId) });
    if (action === "send") return sendToOwner(ctx, platform, text);
    const refused = state.isMessengerThread(ctx.threadId)
      ? "A conversation that came in from a chat app can't change the bot's chat apps. The owner does it in dusk bot."
      : deps.toolRefusal?.(ctx.botId, ctx.threadId) ?? null;
    if (refused) return ctx.json(ctx.res, 403, { error: refused });
    if (!isMessengerPlatform(platform)) return ctx.json(ctx.res, 400, { error: "platform is telegram or discord." });
    try {
      if (action === "connect") {
        const pasted = raw ?? pastedToken(ctx.threadId, platform);
        if (!pasted) return ctx.json(ctx.res, 400, { error: `No ${MESSENGER_LABELS[platform]} bot token is in the person's messages here. Ask them to paste it.` });
        await connect(ctx.botId, platform, pasted);
        return ctx.json(ctx.res, 200, { text: `Connected. Never repeat the token. ${describe(ctx.botId)}` });
      }
      if (action === "disconnect") { await disconnect(ctx.botId, platform); return ctx.json(ctx.res, 200, { text: `Disconnected from ${MESSENGER_LABELS[platform]}.` }); }
      if (!who) return ctx.json(ctx.res, 400, { error: `${action} needs who: a name from the turned-away list, or an id.` });
      if (action === "allow") allow(ctx.botId, platform, who);
      else disallow(ctx.botId, platform, who);
      return ctx.json(ctx.res, 200, { text: describe(ctx.botId) });
    } catch (error) {
      const answer = platformError(platform, error);
      return ctx.json(ctx.res, answer.status, { error: answer.message });
    }
  }

  let stopWatching: (() => void) | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let stopReadyWait: (() => void) | null = null;
  function begin(): void {
    if (!secrets.ready()) {
      if (deps.key.onReady) {
        if (!stopReadyWait) {
          stopReadyWait = deps.key.onReady(() => {
            stopReadyWait = null;
            if (stopWatching && secrets.ready()) begin();
          });
        }
        return;
      }
      readyTimer = setTimeout(begin, 2_000);
      readyTimer.unref();
      return;
    }
    readyTimer = null;
    stopReadyWait?.();
    stopReadyWait = null;
    for (const one of secrets.links()) if (deps.bot(one.botId)) void start(one.botId, one.platform, false).catch(() => {});
    bridge.resume();
  }

  return {
    routes,
    internal,
    door: hookDoor,
    /** A conversation the bridge made for a chat-app chat. */
    isMessengerThread: (threadId: string) => state.isMessengerThread(threadId),
    platformOf: (threadId: string) => state.platformOf(threadId),
    connect,
    disconnect,
    status: statuses,
    scrub(text: string): string {
      if (!text || !secrets.ready()) return text;
      let out = text;
      for (const value of secrets.secretValues()) if (value.length >= 12 && out.includes(value)) out = out.replaceAll(value, HELD_SECRET_MASK);
      return out;
    },
    start(): void {
      if (stopWatching) return;
      stopWatching = deps.onStoreChange((change) => {
        if (change.type === "thread.deleted" && change.threadId) bridge.forgetThread(change.threadId);
        if (change.type === "bot.deleted" && change.botId) {
          for (const platform of ["telegram", "discord"] as const) if (secrets.ready() && link(change.botId, platform)) void disconnect(change.botId, platform);
        }
      });
      begin();
    },
    async stop(): Promise<void> {
      if (readyTimer) clearTimeout(readyTimer);
      stopReadyWait?.();
      stopReadyWait = null;
      stopWatching?.();
      stopWatching = null;
      await Promise.all([...runners.values()].map((runner) => runner.stop()));
      runners.clear();
      bridge.stop();
    },
  };
}
export type MessengerHost = ReturnType<typeof createMessengerHost>;
