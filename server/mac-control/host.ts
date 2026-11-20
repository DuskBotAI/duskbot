// "Your Mac" for a linked VPS's bots. The owner's Mac app long-polls this server through its own signed-in link (no
// port opens on the Mac); bot turns hand it jobs through the device MCP server, and every call is the engine's own tool
// call, so it shows in the chat like any other.
//
// Open risk, accepted by the owner when they leave the switches on: whoever controls this server (its root, or a bot
// turn that passes the owner test) can run anything on the owner's Mac as the owner, for as long as the Mac app is
// linked. Guarded by: only an admin, non-browser session that is not a team member's can take jobs; only the owner's own
// turns may call; a global switch and a per-bot one; the Mac app logs every action it runs.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import type { KeyObject } from "node:crypto";

import { isCloudMacMode, isMacRead, macApprovalReason, OUTSIDE_REASON } from "../../electron/cloud-mac-risk.mjs";
import type { CloudMacMode, CloudMacToolName } from "../../shared/cloud-mac.ts";
import { isMacToolName, type MacControlStatus, type MacToolName } from "../../shared/mac-control.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import type { PromptPart } from "../system-prompt.ts";
import { CLOUD_MAC_UNLINKED_PROMPT, cloudMacInstructions, cloudMacPrompt, MAC_INSTRUCTIONS, MAC_OFFLINE_TEXT, MAC_PROMPT, SCREEN_NEEDS_ACCESS_TEXT, SCREEN_OFF_TEXT } from "./instructions.ts";
import { macJobOutcome, MacJobs, MAC_RESULT_MAX_BYTES, type MacDownload } from "./jobs.ts";
import { isMacSealKey, openMacOutcome, readLinkSigningKey, sealMacJob } from "./seal.ts";
import { localComputerRelay } from "../local-computer-guidance.ts";
import type { ChildCalls } from "../mcp-bridge.ts";
import { maybeScreenTool, SCREEN_ACCESS_TOOL, screenCatalog, screenResult, withoutMacFileOutputs, type ScreenCatalog } from "./screen.ts";
import { CLOUD_MAC_TOOLS, MAC_TOOLS, macErrorResult, macJobTimeoutMs, macToolCallProblem, type MacToolResult } from "./tools.ts";

type Turn = { botId: string; threadId: string; generation: string };
type MacBot = { id: string; name: string; macControl?: boolean };

/** a Mac not seen for this long no longer gets the tools mounted */
const FORGET_MS = 30 * 24 * 60 * 60_000;
const SAVE_SEEN_MS = 10 * 60_000;
const NOT_HOST = "Only the owner's own dusk bot app on their Mac can serve this server's bots.";
const SCREEN_JOB_MS = 60_000;
const SCREEN_LIST_MS = 15_000;
const CLOUD = { id: "cloud", name: "dusk cloud" };
const OFF_TEXT = "Using the person's Mac is switched off for this bot or in Settings.";
const NOT_OWNER_TEXT = "This conversation can't use the person's Mac: only the owner's own turns can.";

export interface MacControlDeps {
  dataDir: string;
  /** One person owns this server (not a shared workspace, a team or a Cloud home) and loopback is the owner. */
  offered(): boolean;
  enabled(): boolean;
  setEnabled(enabled: boolean): void;
  ownerOrAdmin(auth: RequestAuth): boolean;
  live(auth: RequestAuth): boolean;
  bot(id: string): MacBot | null | undefined;
  /** Whose things the turn may use; null when it is not provably the owner's own turn. */
  turnOwner(turn: Turn): string | null;
  active(turn: Turn): boolean;
  /** A file in the bot's own folders or this conversation's attachments. */
  openFile(turn: Turn, source: string): Promise<MacDownload>;
  /** A file in the bot's cloud computer's home. */
  computerFile(botId: string, source: string): Promise<MacDownload>;
  /** Keeps a file the Mac sent (mac_send_file) in the bot's own files; where it went, as the bot attaches it. */
  saveFile(turn: Turn, name: string, bytes: Buffer): Promise<string>;
  /** A dusk cloud (docs/cloud-uses-mac.md): its own catalog, sealed jobs, and the person's answer first when the Mac asks for that. */
  cloud?: {
    /** null to go ahead, "task" to go ahead and allow the rest of this task's outside-content asks, else what the bot is told. */
    approve(bot: MacBot, turn: Turn, tool: CloudMacToolName | "mac_screen", args: Record<string, unknown>, reason: string): Promise<string | null | { task: true }>;
    /** The turn has read outside content (a page, an email, a message, another bot's words) since the person's last message. */
    tainted?(turn: Turn): boolean;
    /** The turn just read outside content on the Mac's screen; the rest of it counts as tainted. */
    readOutside?(turn: Turn): void;
    /** This cloud's link signing key; read from dashboard-link.json when not given. */
    linkKey?(): KeyObject | null;
  };
  now?(): number;
  log?(line: string): void;
}

/** The session the Mac app signed in with: an admin's own device, never a browser sign-in, a team member or a move-in. */
export function macHostSession(auth: RequestAuth): boolean {
  if (auth.kind !== "session") return false;
  const { session } = auth;
  return auth.scopes.includes("admin") && session.cookieOnly !== true && session.moveIn === undefined &&
    (session.teamRole === undefined || session.teamRole === "owner") && session.membershipAuthority === undefined;
}

const cleanName = (value: string | null) => (value ?? "").replace(/[^\p{L}\p{N} '._-]/gu, "").trim().slice(0, 60) || null;

export function createMacControl(deps: MacControlDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const file = join(deps.dataDir, "mac-control.json");
  let seen: { name: string | null; lastSeenAt: number | null } = { name: null, lastSeenAt: null };
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown; lastSeenAt?: unknown };
    seen = { name: typeof saved.name === "string" ? saved.name : null, lastSeenAt: typeof saved.lastSeenAt === "number" ? saved.lastSeenAt : null };
  } catch { /* never linked */ }
  let savedAt = seen.lastSeenAt ?? -Infinity;
  const remember = (name: string | null) => {
    const changed = name !== null && name !== seen.name;
    seen = { name: name ?? seen.name, lastSeenAt: now() };
    if (!changed && now() - savedAt < SAVE_SEEN_MS) return;
    savedAt = now();
    try { writeFileSync(file, JSON.stringify(seen), { mode: 0o600 }); }
    catch (error) { log(`mac control: could not record the Mac (${error instanceof Error ? error.message : String(error)})`); }
  };
  const forget = () => {
    seen = { name: seen.name, lastSeenAt: null };
    savedAt = -Infinity;
    try { writeFileSync(file, JSON.stringify(seen), { mode: 0o600 }); }
    catch (error) { log(`mac control: could not record the Mac (${error instanceof Error ? error.message : String(error)})`); }
  };
  const jobs = new MacJobs(now);
  const cloud = deps.cloud;
  const catalog = cloud ? CLOUD_MAC_TOOLS : MAC_TOOLS;
  const limits = () => ({ ...policy, screen: policy.screen && screen !== null && screen.tools.length > 0, screenAccess: policy.screenAccess });
  const prompt = () => (cloud ? cloudMacPrompt(limits()) : MAC_PROMPT);
  const linkKey = cloud?.linkKey ?? (() => readLinkSigningKey(deps.dataDir));
  /** The key each sealed job in the Mac's hands was sealed with, until its outcome comes back or it expires. */
  const jobKeys = new Map<string, { key: Buffer; expiresAt: number }>();
  /** What the Mac said in its last poll: when it asks first, its home folder, the folders it is limited to and where a
   * command runs by default. Only the card follows this: the Mac checks the same rules itself before it runs a job. */
  const noPolicy = () => ({ mode: "auto" as CloudMacMode, home: "", limited: false, folders: [] as string[], cwd: "~", screen: false, screenAccess: false, platform: "darwin", driver: "" });
  let policy = noPolicy();
  /** The Mac's driver tools, while the person lets cloud bots use its screen; asked for in a sealed job. */
  let screen: ScreenCatalog | null = null;
  let listing: Promise<void> | null = null;
  const listScreen = (): Promise<void> => {
    if (!cloud || !policy.screen || (screen && (!policy.driver || screen.driver === policy.driver))) return Promise.resolve();
    listing ??= jobs.request({ tool: "mac_screen_tools", args: {}, bot: CLOUD, timeoutMs: SCREEN_LIST_MS, active: () => policy.screen, offlineText: MAC_OFFLINE_TEXT })
      .then((outcome) => {
        const next = outcome.ok ? screenCatalog(outcome.result.text) : null;
        if (next && policy.screen) screen = next;
        else if (!outcome.ok) log(`mac control: the Mac did not list its screen tools (${outcome.error})`);
      })
      .finally(() => { listing = null; });
    return listing;
  };
  const screenTools = () => (!cloud ? [] : policy.screen && screen ? screen.tools : policy.screenAccess ? [SCREEN_ACCESS_TOOL] : []);
  const available = () => deps.offered() && seen.lastSeenAt !== null && now() - seen.lastSeenAt < FORGET_MS;
  const allowed = (bot: MacBot | null | undefined, turn: Turn): string | null => {
    if (!bot) return "This bot no longer exists.";
    if (!available()) return MAC_OFFLINE_TEXT;
    if (!deps.enabled() || bot.macControl === false) return OFF_TEXT;
    return deps.turnOwner(turn) === null ? NOT_OWNER_TEXT : null;
  };

  function status(): MacControlStatus {
    return { available: available(), enabled: deps.enabled(), online: jobs.online(), name: seen.name, lastSeenAt: seen.lastSeenAt, ...(cloud ? { cloud: { folders: policy.folders, mode: policy.mode, limited: policy.limited, screen: limits().screen } } : {}) };
  }

  /** Turns (thread and generation) whose person chose Allow for this task on an outside-content card. */
  const taskAllowed = new Set<string>();
  const turnKey = (turn: Turn) => `${turn.threadId}\0${turn.generation}`;
  const allowTask = (turn: Turn) => {
    taskAllowed.add(turnKey(turn));
    if (taskAllowed.size > 500) taskAllowed.delete(taskAllowed.values().next().value!);
  };

  /** The rule that needs the person's Allow first, or null: the Mac's rules, and under Auto any action but a look once
   * this turn has read outside content. */
  function cardReason(turn: Turn, tool: string, args: Record<string, unknown>): string | null {
    const rule = macApprovalReason(policy.mode, tool, args, policy.home || "/Users/person");
    if (rule !== null || policy.mode !== "auto" || isMacRead(tool, args)) return rule;
    return cloud?.tainted?.(turn) && !taskAllowed.has(turnKey(turn)) ? OUTSIDE_REASON : null;
  }

  /** null once the person allowed it on a card, else what the bot is told. */
  async function askFirst(bot: MacBot, turn: Turn, tool: CloudMacToolName | "mac_screen", args: Record<string, unknown>, reason: string, assertActive: () => void): Promise<string | null> {
    const answer = await cloud!.approve(bot, turn, tool, args, reason);
    assertActive();
    if (answer !== null && typeof answer === "object") allowTask(turn);
    return typeof answer === "string" ? answer : allowed(deps.bot(turn.botId), turn);
  }

  async function callScreen(name: string, given: Record<string, unknown>, turn: Turn, assertActive: () => void): Promise<MacToolResult> {
    if (!given || typeof given !== "object" || Array.isArray(given)) return macErrorResult("Tool arguments must be an object.");
    const args = withoutMacFileOutputs(given);
    assertActive();
    const bot = deps.bot(turn.botId);
    const refusal = allowed(bot, turn);
    if (refusal || !bot) return macErrorResult(refusal ?? "This bot no longer exists.");
    if (name === SCREEN_ACCESS_TOOL.name) {
      if (!policy.screenAccess && !policy.screen) return macErrorResult(SCREEN_OFF_TEXT);
      if (!jobs.online()) return macErrorResult(MAC_OFFLINE_TEXT);
      const access = { name: "request_screen_access", arguments: {} };
      const reason = cardReason(turn, "mac_screen", access);
      const no = reason === null ? null : await askFirst(bot, turn, "mac_screen", access, reason, assertActive);
      if (no) return macErrorResult(no);
      const outcome = await jobs.request({ tool: "mac_screen_access", args: {}, bot: { id: bot.id, name: bot.name }, timeoutMs: 120_000,
        active: () => deps.active(turn) && allowed(deps.bot(turn.botId), turn) === null, offlineText: MAC_OFFLINE_TEXT, ...(reason !== null ? { approved: true as const } : {}) });
      if (outcome.ok && outcome.result.structured?.screenReady === true && !policy.screen) {
        policy = { ...policy, screen: true, screenAccess: false };
        void listScreen();
      }
      assertActive();
      return outcome.ok ? { content: [{ type: "text", text: outcome.result.text }] } : macErrorResult(outcome.error);
    }
    if (!policy.screen) return macErrorResult(policy.screenAccess ? SCREEN_NEEDS_ACCESS_TEXT : SCREEN_OFF_TEXT);
    if (!jobs.online()) return macErrorResult(MAC_OFFLINE_TEXT);
    await listScreen();
    const driverName = screen?.driverName.get(name);
    if (!driverName) return macErrorResult(`Unknown Mac screen tool. Use one of ${screenTools().map((tool) => tool.name).join(", ") || "none: the Mac listed no screen tools"}.`);
    const reason = cardReason(turn, "mac_screen", { name: driverName, arguments: args });
    let approved = false;
    if (reason !== null) {
      const no = await askFirst(bot, turn, "mac_screen", { name: driverName, arguments: args }, reason, assertActive) ?? (policy.screen ? null : SCREEN_OFF_TEXT);
      if (no) return macErrorResult(no);
      approved = true;
    }
    const send = (tool: string, input: Record<string, unknown>) => jobs.request({
      tool: "mac_screen", args: { name: tool, arguments: input }, bot: { id: bot.id, name: bot.name }, timeoutMs: SCREEN_JOB_MS,
      active: () => deps.active(turn) && allowed(deps.bot(turn.botId), turn) === null && policy.screen, offlineText: MAC_OFFLINE_TEXT,
      ...(approved ? { approved: true as const } : {}),
    });
    const child: ChildCalls = {
      call: async (tool, input) => {
        let outcome = await send(tool, input);
        // the Mac knows which app a window belongs to; when that makes the action need a card, ask once and send again
        if (!outcome.ok && outcome.ask && !approved) {
          const no = await askFirst(bot, turn, "mac_screen", { name: tool, arguments: input }, outcome.ask, assertActive);
          if (no) return screenResult({ ok: false, error: no }) as unknown as Record<string, unknown>;
          approved = true;
          outcome = await send(tool, input);
        }
        if (outcome.ok && outcome.result.outside) cloud?.readOutside?.(turn);
        return screenResult(outcome) as unknown as Record<string, unknown>;
      },
      get driverVersion() { return screen?.driver || undefined; },
    };
    const call = { name: driverName, arguments: args };
    const result = await (localComputerRelay(policy.platform)(call, child) ?? child.call(driverName, args));
    assertActive();
    return result as unknown as MacToolResult;
  }

  async function received(turn: Turn, file: { name: string; data: string } | undefined): Promise<MacToolResult> {
    if (!file) return macErrorResult("The Mac sent no file: update dusk bot on the Mac.");
    try {
      const bytes = Buffer.from(file.data, "base64");
      const saved = await deps.saveFile(turn, file.name, bytes);
      return { content: [{ type: "text", text: `Saved ${bytes.length} bytes from the Mac to ${saved} in your files. To give it to the person, attach that file to your reply (agents_attach_file).` }] };
    } catch (error) {
      return macErrorResult(`Got the file from the Mac but could not keep it: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function call(params: unknown, turn: Turn, assertActive: () => void): Promise<MacToolResult> {
    const { name, arguments: raw } = (params && typeof params === "object" ? params : {}) as { name?: unknown; arguments?: unknown };
    const args = (raw ?? {}) as Record<string, unknown>;
    if (cloud && maybeScreenTool(name)) return callScreen(name, args, turn, assertActive);
    const problem = macToolCallProblem(name, args, catalog);
    if (problem || !isMacToolName(name)) return macErrorResult(problem ?? "Unknown Mac tool.");
    assertActive();
    const bot = deps.bot(turn.botId);
    const refusal = allowed(bot, turn);
    if (refusal || !bot) return macErrorResult(refusal ?? "This bot no longer exists.");
    if (!jobs.online()) return macErrorResult(MAC_OFFLINE_TEXT);
    const reason = cloud ? cardReason(turn, name, args) : null;
    const asks = reason !== null;
    if (cloud && asks) {
      const no = await askFirst(bot, turn, name as CloudMacToolName, name === "mac_exec" && !args.cwd ? { ...args, cwd: policy.cwd } : args, reason, assertActive);
      if (no) return macErrorResult(no);
    }
    let download: MacDownload | undefined;
    if (name === "mac_save_from_cloud") {
      try {
        download = args.from === "computer" ? await deps.computerFile(bot.id, String(args.source)) : await deps.openFile(turn, String(args.source));
      } catch (error) {
        return macErrorResult(`Could not read ${String(args.source)}: ${error instanceof Error ? error.message : String(error)}`);
      }
      assertActive();
    }
    const outcome = await jobs.request({
      tool: name as MacToolName, args, bot: { id: bot.id, name: bot.name }, timeoutMs: macJobTimeoutMs(name, args),
      active: () => deps.active(turn) && allowed(deps.bot(turn.botId), turn) === null, offlineText: MAC_OFFLINE_TEXT, ...(download ? { file: download } : {}),
      ...(asks ? { approved: true as const } : {}),
    });
    assertActive();
    if (!outcome.ok) return macErrorResult(outcome.error);
    if (name === "mac_send_file") return received(turn, outcome.result.file);
    return { content: [{ type: "text", text: outcome.result.text }, ...(outcome.result.image ? [{ type: "image" as const, ...outcome.result.image }] : [])] };
  }

  const routes: RouteHandler = async ({ req, res, path, method, auth, json, readBody, url }) => {
    if (path !== "/api/mac" && !path.startsWith("/api/mac/")) return PASS;
    res.setHeader("cache-control", "no-store");
    if (path === "/api/mac") {
      if (!deps.ownerOrAdmin(auth)) return json(res, 403, { error: "Only the owner can change what bots may do on their Mac." });
      if (method === "GET") return json(res, 200, status());
      if (method === "PUT") {
        const body = await readBody(req, 1024) as Record<string, unknown> | null;
        if (typeof body?.enabled !== "boolean") return json(res, 400, { error: "enabled must be true or false" });
        deps.setEnabled(body.enabled);
        return json(res, 200, status());
      }
      return json(res, 405, { error: "method not allowed" });
    }
    if (path !== "/api/mac/self" && !path.startsWith("/api/mac/self/")) return json(res, 404, { error: "not found" });
    if (!deps.offered() || !macHostSession(auth)) return json(res, 403, { error: NOT_HOST });
    if (!deps.live(auth)) return json(res, 401, { error: "Session expired" });
    if (path === "/api/mac/self") {
      if (method !== "DELETE") return json(res, 405, { error: "method not allowed" });
      forget();
      policy = noPolicy();
      screen = null;
      return json(res, 200, status());
    }
    if (path === "/api/mac/self/jobs" && method === "GET") {
      const macKey = url.searchParams.get("key");
      if (cloud && !isMacSealKey(macKey)) return json(res, 400, { error: "Send this Mac's sealing key: update dusk bot on the Mac." });
      const signer = cloud ? linkKey() : null;
      if (cloud && !signer) return json(res, 503, { error: "This cloud has no link key yet, so it cannot reach your Mac safely." });
      remember(cleanName(url.searchParams.get("name")));
      if (cloud) {
        const folders = url.searchParams.getAll("folder").map((folder) => folder.trim().slice(0, 1024)).filter(Boolean).slice(0, 20);
        const mode = url.searchParams.get("mode");
        const home = (url.searchParams.get("home") ?? "").trim();
        const platform = url.searchParams.get("platform");
        policy = { mode: isCloudMacMode(mode) ? mode : "auto", home: /^\/[^\0]{1,1023}$/.test(home) ? home.replace(/\/+$/, "") : "", limited: folders.length > 0, folders,
          cwd: (url.searchParams.get("cwd") ?? "").trim().slice(0, 1024) || "~", screen: url.searchParams.get("screen") === "1", screenAccess: url.searchParams.get("screen") === "grant",
          platform: platform === "win32" ? "win32" : "darwin", driver: (url.searchParams.get("driver") ?? "").trim().slice(0, 40) };
        if (!policy.screen) screen = null;
        void listScreen();
      }
      const gone = new AbortController();
      res.once("close", () => { if (!res.writableEnded) gone.abort(); });
      const job = await jobs.poll(gone.signal);
      if (!deps.live(auth)) {
        if (job) jobs.complete(job.id, { ok: false, error: "The Mac's session expired before it took this. It did not run." });
        return json(res, 401, { error: "Session expired" });
      }
      if (!cloud || !job) return json(res, 200, { job, ...(cloud ? { sealed: null } : {}), enabled: deps.enabled() });
      for (const [id, entry] of jobKeys) if (entry.expiresAt < now()) jobKeys.delete(id);
      try {
        const { envelope, key } = sealMacJob(job, macKey!, signer!);
        jobKeys.set(job.id, { key, expiresAt: job.expiresAt });
        return json(res, 200, { job: null, sealed: envelope, enabled: deps.enabled() });
      } catch (error) {
        jobs.complete(job.id, { ok: false, error: "This cloud could not seal the job for the Mac. It did not run." });
        log(`mac control: could not seal a job (${error instanceof Error ? error.message : String(error)})`);
        return json(res, 200, { job: null, sealed: null, enabled: deps.enabled() });
      }
    }
    const one = /^\/api\/mac\/self\/jobs\/([\w-]{1,64})\/(result|file)$/.exec(path);
    if (one?.[2] === "result" && method === "POST") {
      let body = await readBody(req, MAC_RESULT_MAX_BYTES * 2 + 65_536) as unknown;
      if (cloud) {
        const sealed = jobKeys.get(one[1]!);
        if (!sealed) return json(res, 409, { error: "This job expired; it will not be replayed." });
        try { body = openMacOutcome((body as { sealed?: unknown } | null)?.sealed, sealed.key, one[1]!); }
        catch { return json(res, 400, { error: "The outcome did not open with this job's key." }); }
        jobKeys.delete(one[1]!);
      }
      const outcome = macJobOutcome.safeParse(body);
      if (!outcome.success) return json(res, 400, { error: "Send { ok: true, result: { text } } or { ok: false, error }." });
      return jobs.complete(one[1]!, outcome.data) ? json(res, 200, { ok: true }) : json(res, 409, { error: "This job expired; it will not be replayed." });
    }
    if (one?.[2] === "file" && method === "GET" && !cloud) {
      const download = jobs.file(one[1]!);
      if (!download) return json(res, 404, { error: "no such file" });
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(download.bytes) });
      await pipeline(download.open(), res).catch((error) => log(`mac control: a download stopped (${error instanceof Error ? error.message : String(error)})`));
      return;
    }
    return json(res, 404, { error: "not found" });
  };

  return {
    status,
    routes,
    /** The device server mounts for this turn because of the Mac (it may also mount for the phone). */
    mounts: (bot: MacBot, turn: Turn) => allowed(bot, turn) === null,
    promptPart: (bot: MacBot, turn: Turn): PromptPart => ({ id: "mac", label: "Your Mac", text: allowed(bot, turn) === null ? prompt() : "" }),
    /** A dusk cloud's owner's turn when their Mac never linked: how to let the bot use it. */
    unlinkedPart: (bot: MacBot, turn: Turn): PromptPart => ({ id: "mac", label: "Your Mac", text:
      cloud && deps.offered() && !available() && deps.enabled() && bot.macControl !== false && deps.turnOwner(turn) !== null ? CLOUD_MAC_UNLINKED_PROMPT : "" }),
    /** The bot settings preview: the Mac as the owner's own turn would see it. */
    previewPart: (bot: MacBot): PromptPart => ({ id: "mac", label: "Your Mac", text: available() && deps.enabled() && bot.macControl !== false ? prompt() : "" }),
    tools: (turn: Turn) => (allowed(deps.bot(turn.botId), turn) === null ? [...catalog, ...screenTools()] : []),
    /** The Mac's screen tools, once it has listed them (a moment after it starts polling with its screen allowed). */
    screenReady: () => (listing ? Promise.race([listing, new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref())]) : Promise.resolve()),
    instructions: () => (cloud ? cloudMacInstructions(limits()) : MAC_INSTRUCTIONS),
    handles: (name: unknown): name is string => isMacToolName(name) || (cloud !== undefined && maybeScreenTool(name)),
    call,
    close: () => jobs.close(),
  };
}

export type MacControl = ReturnType<typeof createMacControl>;
