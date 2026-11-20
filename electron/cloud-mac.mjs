// "Let my cloud bots use this Mac" (docs/cloud-uses-mac.md): this app serves its own dusk cloud's bots through the
// same poller and executor a linked VPS uses (mac-control.mjs), with every job sealed to this Mac and signed by the
// cloud's link key, and checked here against the person's switch and allowed folders before it runs.
//
// Security invariants: on unless the person turned it off on this Mac (turning it back on asks here); only the app's own My Cloud is followed; a job
// that is not signed by that cloud's link key (from dusk.bot, never from the cloud's address), not sealed to this run's
// key, expired, repeated or outside the cloud's tools never runs. Once on, cloud bots act as the person; the person's
// limits (Auto asks for risky actions, or every action, or never; "Only these folders") are enforced here too.
// The screen has its own switch, on unless turned off: screen jobs run only while it is on, through this app's own
// computer control, and the indicator (onScreen) and its Stop stay up while one runs.
import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, verify } from "node:crypto";
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { isCloudMacMode, macApprovalReason, SCREEN_INPUTS, SCREEN_PAGE_READS, screenReadOutside } from "./cloud-mac-risk.mjs";
import { createMacControlHost } from "./mac-control.mjs";
import { createMacExecutor, folderName, jobSummary, macLogFile, resolveMacPath } from "./mac-control-tools.mjs";
import { screenOutcome } from "./cloud-screen.mjs";

export const CLOUD_MAC_TOOLS = Object.freeze(["mac_exec", "mac_read_file", "mac_write_file", "mac_list", "mac_open", "mac_download", "mac_send_file"]);
export const DEFAULT_CWD = "~/dusk bot";
export const DEFAULT_FOLDERS = Object.freeze(["~/Downloads", DEFAULT_CWD]);
const OPEN_SCHEMES = new Set(["https:", "http:", "mailto:"]);
const CONNECTED_MS = 60_000;
/** The indicator stays up this long after a screen action, so a bot's run of clicks reads as one session. */
export const ON_SCREEN_MS = 15_000;
export const SCREEN_OFF = "The person has not let cloud bots use this computer's screen. It did not run.";
export const SCREEN_NOT_READY = "Computer control is not on in dusk bot on this computer (it needs Accessibility and Screen Recording), so the screen is out of reach. It did not run.";
const KEY_RETRY_MS = 10 * 60_000;
const ACCESS_ASK_MS = 10 * 60_000;

export const CLOUD_MAC_SEAL_INFO = "dusk cloud mac v1";
export const cloudMacSignedBytes = (envelope) => `dusk-mac-job-v1\n${envelope.mac}\n${envelope.eph}\n${envelope.iv}\n${envelope.data}`;
export const cloudMacJobAad = (mac, eph) => `job\n${mac}\n${eph}`;
export const cloudMacOutcomeAad = (jobId) => `outcome\n${jobId}`;

const x25519 = (x) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" });
const LINK_KEY = /^[A-Za-z0-9+/]{40,120}={0,2}$/;
export const isLinkKey = (value) => typeof value === "string" && LINK_KEY.test(value);

/** One run's key: opens the cloud's sealed jobs and seals their outcomes. */
export function createCloudMacSeal({ now = Date.now } = {}) {
  const pair = generateKeyPairSync("x25519");
  const mine = pair.publicKey.export({ format: "jwk" }).x;
  const seen = new Map();
  return {
    key: () => mine,
    /** @returns {{ job: any, wrap(outcome: unknown): { sealed: { v: 1, iv: string, data: string } } }} */
    open(envelope, linkKey) {
      if (!isLinkKey(linkKey)) throw new Error("no link key for this cloud");
      const parts = envelope && typeof envelope === "object" ? envelope : {};
      if (parts.v !== 1 || ["mac", "eph", "iv", "data", "sig"].some((name) => typeof parts[name] !== "string")) throw new Error("not a sealed job");
      if (parts.mac !== mine) throw new Error("a job sealed to another key");
      const signer = createPublicKey({ key: Buffer.from(linkKey, "base64"), format: "der", type: "spki" });
      if (signer.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(cloudMacSignedBytes(parts)), signer, Buffer.from(parts.sig, "base64url"))) {
        throw new Error("a job not signed by this person's cloud");
      }
      const key = Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey: pair.privateKey, publicKey: x25519(parts.eph) }), Buffer.alloc(0), CLOUD_MAC_SEAL_INFO, 32));
      const bytes = Buffer.from(parts.data, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts.iv, "base64url"));
      decipher.setAAD(Buffer.from(cloudMacJobAad(mine, parts.eph)));
      decipher.setAuthTag(bytes.subarray(bytes.length - 16));
      const job = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]).toString("utf8"));
      if (!job || typeof job.id !== "string" || typeof job.expiresAt !== "number") throw new Error("not a job");
      const at = now();
      for (const [id, until] of seen) if (until < at) seen.delete(id);
      if (job.expiresAt < at) throw new Error("an expired job");
      if (seen.has(job.id)) throw new Error("a job it already ran");
      seen.set(job.id, job.expiresAt);
      return {
        job,
        wrap(outcome) {
          const iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", key, iv);
          cipher.setAAD(Buffer.from(cloudMacOutcomeAad(job.id)));
          const data = Buffer.concat([cipher.update(JSON.stringify(outcome), "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64url");
          return { sealed: { v: 1, iv: iv.toString("base64url"), data } };
        },
      };
    },
  };
}

/** `~/x` for a path under home, else the path. */
export function tildePath(value, home = homedir()) {
  const full = resolveMacPath(value, home);
  return full === home ? "~" : full.startsWith(`${home}${path.sep}`) ? `~/${full.slice(home.length + 1)}` : full;
}

/** The path as it really is, links followed for the part that exists. */
async function realTarget(full) {
  const rest = [];
  let at = full;
  for (;;) {
    try { return path.join(await fsp.realpath(at), ...rest.reverse()); }
    catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(at);
      if (parent === at) return full;
      rest.push(path.basename(at));
      at = parent;
    }
  }
}

/** The real path when it lies inside one of the folders, else null. */
export async function insideFolders(value, folders, home = homedir()) {
  const target = await realTarget(resolveMacPath(value, home));
  for (const folder of folders) {
    const root = await realTarget(resolveMacPath(folder, home));
    if (target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)) return target;
  }
  return null;
}

/** Where a command runs without a cwd: the home folder, or the first allowed folder under "Only these folders". */
export const defaultCwd = (folders) => (folders ? folders[0] ?? DEFAULT_CWD : "~");

/** Why this Mac will not run a cloud job, or null; fills in the defaults it checked (list, cwd, download folder).
 * `folders`: null when not limited; `mode`: what must have been allowed on a card (cloud-mac-risk.mjs). */
export async function cloudJobRefusal(job, { folders = null, mode = "auto", home = homedir() }) {
  if (!CLOUD_MAC_TOOLS.includes(job?.tool)) return "This Mac does not let cloud bots do that.";
  const a = job.arguments ?? (job.arguments = {});
  const reason = macApprovalReason(mode, job.tool, a, home);
  if (reason && job.approved !== true) return `This ${reason}, so the person must allow it on a card first; it did not run.`;
  if (job.tool === "mac_exec") a.cwd ??= defaultCwd(folders);
  if (job.tool === "mac_download") a.to ??= "~/Downloads/";
  if (job.tool === "mac_list") a.path ??= folders?.[0] ?? "~";
  if (!folders) return null;
  const outside = (where) => `${where} is outside the folders the person limited this Mac to (${folders.join(", ")}). Ask them to add a folder in Settings, or use one of these.`;
  const check = async (value) => ((await insideFolders(value, folders, home)) ? null : outside(String(value)));
  switch (job.tool) {
    case "mac_list":
    case "mac_read_file":
    case "mac_write_file":
    case "mac_send_file":
      return check(a.path);
    case "mac_exec":
      return check(a.cwd);
    case "mac_download":
      return check(a.to);
    case "mac_open": {
      const target = String(a.target ?? "").trim();
      const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(target)?.[0]?.toLowerCase();
      if (scheme && !target.startsWith("/")) return OPEN_SCHEMES.has(scheme) ? null : `This Mac only opens https, http and mailto links for cloud bots, not ${scheme}.`;
      const file = resolveMacPath(target, home);
      const exists = await fsp.stat(file).then(() => true, () => false);
      if (exists || a.app) return exists ? check(target) : `${target} is not on this Mac.`;
      return /[/\\]/.test(target) ? `${target} is not on this Mac.` : null;
    }
    default:
      return "This Mac does not let cloud bots do that.";
  }
}

/**
 * @param {{
 *   fetch: typeof fetch, name(): string, home?: string, log?(line: string): void, now?(): number,
 *   prefs: { read(): { enabled?: boolean, folders?: string[] } | null, write(value: { enabled: boolean, folders: string[] }): void },
 *   cloud(): { origin: string | null, awake: boolean },
 *   linkKey(): Promise<string | null>,
 *   reauth?(origin: string): Promise<boolean>,
 *   onChange?(view: import("../shared/cloud-mac.ts").CloudMacState): void,
 *   execute?: ReturnType<typeof createMacExecutor>,
 *   screen?: { available(): boolean, version(): string, tools(): Promise<unknown>, call(name: string, args: unknown, signal: AbortSignal): Promise<unknown>, close(): void, requestAccess?(): Promise<unknown> },
 *   wait?(ms: number, signal: AbortSignal): Promise<void>,
 * }} deps
 */
// the prefs file is missing until the first save: a fresh install starts from defaults. Security invariant: a file
// that is there but cannot be read turns everything off, since the defaults are on.
function readPrefs(prefs, log) {
  try { return prefs.read() ?? {}; }
  catch (error) {
    if (error?.code === "ENOENT") return {};
    log(`cloud mac: settings unreadable, cloud bots stay off this Mac until turned on again (${error?.message ?? error})`);
    return { enabled: false, screen: false };
  }
}

const needsCard = (reason) => ({ error: `This ${reason}, so the person must allow it on a card first; it did not run.`, ask: reason });

/** Why this Mac will not run a cloud screen job, or null; `ask` when a card from the person would let it run.
 * `target`: the app behind an input action's window, as this Mac found it (cloud-mac-risk.mjs screenRisk). */
export function screenJobRefusal(job, { screen, ready, mode, home, target }) {
  if (!screen) return { error: SCREEN_OFF };
  if (job.tool === "mac_screen_access") {
    const reason = macApprovalReason(mode, "mac_screen", { name: "request_screen_access", arguments: {} }, home);
    return reason && job.approved !== true ? needsCard(reason) : null;
  }
  if (!ready) return { error: SCREEN_NOT_READY };
  if (job.tool === "mac_screen_tools") return null;
  const a = job.arguments ?? {};
  if (typeof a.name !== "string" || !a.arguments || typeof a.arguments !== "object" || Array.isArray(a.arguments)) return { error: "Not a screen action this computer knows." };
  const reason = macApprovalReason(mode, "mac_screen", { ...a, ...(target ? { target } : {}) }, home);
  return reason && job.approved !== true ? needsCard(reason) : null;
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** cua-driver 0.28.2's text form of list_apps: "- Finder (pid 685) [com.apple.finder]" per running app. */
function textApp(result, pid) {
  const text = (Array.isArray(result?.content) ? result.content : []).filter((part) => part?.type === "text").map((part) => part.text).join("\n");
  for (const [, name, found, bundle] of text.matchAll(/^- (.+) \(pid (\d+)\) \[([^\]]+)\]$/gm)) if (Number(found) === pid) return { name, bundle_id: bundle };
  return undefined;
}

/** The app owning `pid` in a list_apps answer: its name and bundle id joined, or null. */
export function appForPid(result, pid) {
  let apps = isObject(result?.structuredContent) ? result.structuredContent.apps : undefined;
  if (!Array.isArray(apps)) {
    const text = (Array.isArray(result?.content) ? result.content : []).filter((part) => part?.type === "text").map((part) => part.text).join("\n");
    try { const parsed = JSON.parse(text); apps = Array.isArray(parsed) ? parsed : parsed?.apps; } catch { apps = undefined; }
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const app = Array.isArray(apps) ? apps.find((entry) => isObject(entry) && entry.running !== false && Number(entry.pid) === pid) : textApp(result, pid);
  if (!app) return null;
  const words = [app.name, app.app_name, app.localizedName, app.bundle_id, app.bundleId, app.bundle_identifier].filter((word) => typeof word === "string" && word);
  return words.length ? words.join(" ") : null;
}

const SCREEN_JOBS = new Set(["mac_screen", "mac_screen_tools", "mac_screen_access"]);

export function createCloudMac(deps) {
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const saved = readPrefs(deps.prefs, deps.log ?? (() => {}));
  let enabled = saved.enabled !== false;
  let mode = isCloudMacMode(saved.mode) ? saved.mode : "auto";
  let limitFolders = saved.limitFolders === true;
  let screenOn = saved.screen !== false;
  let folders =Array.isArray(saved.folders) && saved.folders.every((folder) => typeof folder === "string") ? [...saved.folders] : [...DEFAULT_FOLDERS];
  const busy = new Map();
  let seal = createCloudMacSeal({ now });
  let lastScreen = null, accessAskedAt = -Infinity;
  let origin = null, linkKey = null, keyCheckedAt = -Infinity, keyOrigin = null, lastOkAt = -Infinity, refused = null;
  const limit = () => (limitFolders ? folders : null);
  const execute = deps.execute ?? createMacExecutor({ home, log, source: "cloud", defaultCwd: () => defaultCwd(limit()) });

  const view = () => {
    const place = deps.cloud();
    const cloud = !place.origin ? "none" : !place.awake ? "asleep" : refused ? "refused" : now() - lastOkAt < CONNECTED_MS ? "connected" : "connecting";
    const problem = !enabled ? null
      : cloud === "none" ? "You have no dusk cloud on this account yet."
        : cloud === "asleep" ? "Your dusk cloud is asleep; it reaches this Mac again once it wakes."
          : cloud === "refused" ? refused : null;
    const screenReady = deps.screen?.available() === true;
    const onScreen = [...busy.values()].find((entry) => entry.work.tool === "mac_screen")?.work.bot
      ?? (enabled && screenOn && lastScreen && now() - lastScreen.at < ON_SCREEN_MS ? lastScreen.bot : null);
    return { enabled, mode, limitFolders, folders: [...folders], cloud, problem, busy: [...busy.values()].map((entry) => entry.work),
      screen: screenOn, screenReady, onScreen: onScreen ? { bot: onScreen } : null };
  };
  const changed = () => deps.onChange?.(view());
  const save = () => deps.prefs.write({ enabled, mode, limitFolders, folders, screen: screenOn });

  async function logLine(job, ending, approved = false) {
    const line = `${new Date(now()).toISOString()} cloud ${folderName(job?.bot?.name)} ${job?.tool} ${jobSummary(job ?? {})}${approved ? " (allowed in chat)" : ""} -> ${ending}\n`;
    try {
      await fsp.mkdir(path.dirname(macLogFile(home)), { recursive: true, mode: 0o700 });
      await fsp.appendFile(macLogFile(home), line, { mode: 0o600 });
    } catch (error) { log(`cloud mac: could not write the log (${error?.message ?? error})`); }
  }
  const audit = (job, refusal) => logLine(job, `refused: ${refusal}`);
  const record = (job, outcome) => logLine(job, outcome.ok && outcome.result?.isError !== true ? "ok" : `failed: ${String(outcome.ok ? outcome.result.text : outcome.error).slice(0, 300)}`, job?.approved === true);

  /** For an input action under Auto: the app behind its window, so a sensitive one asks first. */
  async function screenTarget(job) {
    const a = job.arguments ?? {};
    if (mode !== "auto" || job.tool !== "mac_screen" || !deps.screen?.available()) return undefined;
    const reads = SCREEN_PAGE_READS.includes(a.name);
    if (!reads && (job.approved === true || !SCREEN_INPUTS.includes(a.name))) return undefined;
    const pid = Number(a.arguments?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) return { app: null };
    return { app: appForPid(await deps.screen.call("list_apps", {}), pid) };
  }

  async function runScreen(job) {
    const target = await screenTarget(job);
    const refusal = screenJobRefusal(job, { screen: screenOn, ready: deps.screen?.available() === true, mode, home, target });
    if (refusal) {
      if (job.tool === "mac_screen") await audit(job, refusal.error);
      return { ok: false, error: refusal.error, ...(refusal.ask ? { ask: refusal.ask } : {}) };
    }
    if (job.tool === "mac_screen_access") {
      const ready = { ok: true, result: { structured: { screenReady: true } } };
      if (deps.screen.available()) return { ...ready, result: { ...ready.result, text: "Computer control is already on here; the screen tools are on their way." } };
      if (now() - accessAskedAt < ACCESS_ASK_MS) return { ok: true, result: { text: "Already asked on the Mac a moment ago: the person needs to allow dusk bot under Accessibility and Screen Recording there. Carry on without the screen until they have." } };
      accessAskedAt = now();
      const asked = await deps.screen.requestAccess?.().then(() => deps.screen.available(), () => false);
      return asked ? { ...ready, result: { ...ready.result, text: "Computer control is on now. The screen tools appear on your next turn." } }
        : { ok: true, result: { text: "Asked on the Mac: the person needs to allow dusk bot under Accessibility and Screen Recording in System Settings there. Tell them, then carry on without the screen until they have." } };
    }
    if (job.tool === "mac_screen_tools") {
      try { return { ok: true, result: { text: JSON.stringify(await deps.screen.tools()) } }; }
      catch (error) { return { ok: false, error: String(error?.message ?? error).slice(0, 2000) }; }
    }
    const abort = new AbortController();
    const bot = String(job.bot?.name ?? "A bot");
    busy.set(job.id, { abort, work: { id: job.id, bot, tool: job.tool, summary: jobSummary(job), startedAt: now() } });
    lastScreen = { bot, at: now() };
    changed();
    try {
      const outcome = screenOutcome(await deps.screen.call(job.arguments.name, job.arguments.arguments, abort.signal));
      if (mode === "auto" && screenReadOutside(job.arguments.name, target)) outcome.result.outside = true;
      await record(job, outcome);
      return outcome;
    } finally {
      busy.delete(job.id);
      lastScreen = { bot, at: now() };
      changed();
      const settle = setTimeout(changed, ON_SCREEN_MS + 100);
      settle.unref?.();
    }
  }

  async function run(job, io) {
    if (!enabled) { await audit(job, "switched off"); return { ok: false, error: "The person turned off cloud bots on this Mac. It did not run." }; }
    if (SCREEN_JOBS.has(job?.tool)) return runScreen(job);
    const refusal = await cloudJobRefusal(job, { folders: limit(), mode, home });
    if (refusal) { await audit(job, refusal); return { ok: false, error: refusal }; }
    const abort = new AbortController();
    busy.set(job.id, { abort, work: { id: job.id, bot: String(job.bot?.name ?? "A bot"), tool: job.tool, summary: jobSummary(job), startedAt: now() } });
    changed();
    try { return await execute(job, { ...io, signal: abort.signal }); }
    finally { busy.delete(job.id); changed(); }
  }

  const host = createMacControlHost({
    fetch: deps.fetch, name: deps.name, log, execute: run, ...(deps.wait ? { wait: deps.wait } : {}),
    query: () => [["key", seal.key()], ["cwd", defaultCwd(limit())], ["mode", mode], ["home", home], ...(limit() ?? []).map((folder) => ["folder", folder]),
      ["platform", process.platform], ...(!screenOn || !deps.screen ? [] : deps.screen.available() ? [["screen", "1"], ["driver", deps.screen.version()]]
        : deps.screen.requestAccess ? [["screen", "grant"]] : [])],
    ready: () => enabled && deps.cloud().awake && linkKey !== null,
    ...(deps.reauth ? { reauth: () => (origin ? deps.reauth(origin) : Promise.resolve(false)) } : {}),
    open: (body) => seal.open(body?.sealed, linkKey),
    state: (state, why) => {
      if (state === "connected") { lastOkAt = now(); if (refused) { refused = null; changed(); } }
      else if (state === "refused") { refused = why || "Your dusk cloud does not take this Mac's work yet; it may need an update."; changed(); }
    },
  });

  async function forgetAt(target) {
    try {
      await deps.fetch(`${target}/api/mac/self`, { method: "DELETE", redirect: "error", credentials: "include", cache: "no-store", headers: { accept: "application/json", origin: target } });
    } catch (error) { log(`cloud mac: could not tell ${target} to forget this Mac (${error?.message ?? error})`); }
  }

  /** Follows My Cloud while the switch is on, its key known; call whenever the switch or the cloud changes. */
  async function sync() {
    const place = deps.cloud();
    const target = enabled ? place.origin : null;
    if (target !== keyOrigin) { linkKey = null; keyOrigin = target; keyCheckedAt = -Infinity; }
    if (target && linkKey === null && place.awake && now() - keyCheckedAt > KEY_RETRY_MS) {
      keyCheckedAt = now();
      const key = await deps.linkKey().catch(() => null);
      if (keyOrigin !== target) return;
      if (isLinkKey(key)) { linkKey = key; refused = null; }
      else refused = "Your dusk cloud needs an update before it can use this Mac.";
      changed();
    }
    if (origin && origin !== target) {
      const left = origin;
      origin = null;
      host.follow(null);
      if (!enabled) void forgetAt(left);
    }
    if (target && linkKey && origin !== target) {
      origin = target;
      seal = createCloudMacSeal({ now });
      host.follow(target);
    }
  }

  return {
    view,
    sync,
    async setEnabled(on) {
      enabled = on === true;
      save();
      if (!enabled) for (const entry of busy.values()) entry.abort.abort();
      await sync();
      changed();
      return view();
    },
    /** "Let them use this Mac's screen"; off also stops what runs on the screen now. */
    setScreen(on) {
      screenOn = on === true;
      if (!screenOn) {
        for (const entry of busy.values()) if (entry.work.tool === "mac_screen") entry.abort.abort();
        lastScreen = null;
        deps.screen?.close();
      }
      save();
      changed();
      return view();
    },
    /** The indicator's Stop: what runs on the screen stops and the screen switch turns off. */
    stopScreen() { return this.setScreen(false); },
    setMode(next) { if (isCloudMacMode(next)) { mode = next; save(); changed(); } return view(); },
    setLimitFolders(on) {
      limitFolders = on === true;
      if (limitFolders) void fsp.mkdir(resolveMacPath(DEFAULT_CWD, home), { recursive: true }).catch(() => {});
      save();
      changed();
      return view();
    },
    addFolder(folder) {
      const shown = tildePath(folder, home);
      if (shown === "/" || folders.includes(shown)) return view();
      folders = [...folders, shown].slice(0, 20);
      save();
      changed();
      return view();
    },
    removeFolder(folder) {
      folders = folders.filter((entry) => entry !== folder);
      save();
      changed();
      return view();
    },
    /** The kill switch: stops what runs now and turns the switch off. */
    stop() { return this.setEnabled(false); },
    close() { host.close(); for (const entry of busy.values()) entry.abort.abort(); deps.screen?.close(); },
  };
}
