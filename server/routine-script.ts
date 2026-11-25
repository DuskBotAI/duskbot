// A routine's script check (RoutineProbe kind "script"): one command line run without any AI, its output compared
// with the last run's or, with `post`, posted as the bot's reply. Only dusk bot's base environment reaches it, never its
// keys. Security: under sandbox-exec on macOS and bubblewrap on Linux it writes only to a scratch folder and reads none
// of the person's keys; it runs bare only where neither exists, and a bwrap the kernel refuses fails the check instead.
// With `access: "full"` (set only through the person's card) it runs with no fence at all, as the server's user, able
// to read and write whatever that user can; a test run (dry run) still runs it inside the fence.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { WrappedSpawn } from "./bot-box/box.ts";
import { probeBwrap, whichOnPath } from "./bot-box/detect.ts";
import type { BoxRequest } from "./bot-box/plan.ts";
import type { Routine } from "./routines.ts";

export const SCRIPT_TIMEOUT_MS = 60_000;
export const SCRIPT_OUTPUT_MAX = 64 * 1024;
const BASE_NAMES = ["PATH", "LANG", "LANGUAGE", "LC_ALL", "TZ", "TERM", "USER", "LOGNAME", "SHELL", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR"];

export type ScriptResult = { ok: true; output: string } | { ok: false; error: string };

/** What a script's output asks for: `false` keeps the run asleep, `true` wakes it whatever changed, undefined compares. */
export function wakeAsked(output: string): boolean | undefined {
  const last = output.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
  if (!last.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(last) as unknown;
    const wake = value && typeof value === "object" && !Array.isArray(value) ? (value as { wakeAgent?: unknown }).wakeAgent : undefined;
    return typeof wake === "boolean" ? wake : undefined;
  } catch {
    return undefined;
  }
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** Under HOME: what a script check may never read. */
const PRIVATE_READS = [".ssh", ".gnupg", ".aws", ".config/duskbot", ".duskbot", ".netrc", "Library/Keychains", "Library/Cookies"];
const quoted = (path: string) => JSON.stringify(path);

/** The macOS sandbox profile (sandbox-exec, Seatbelt SBPL): everything allowed but writes outside `scratch` and reads
 * of the person's keys. Network stays open: a check reads pages and APIs. */
export function sandboxProfile(scratch: string, home: string): string {
  return [
    "(version 1)", "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${quoted(scratch)}) (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/(fd/|tty|stdout|stderr)"))`,
    `(deny file-read* ${PRIVATE_READS.map((part) => `(subpath ${quoted(join(home, part))})`).join(" ")})`,
  ].join("\n");
}

/** bubblewrap arguments for the same fence on Linux: the whole filesystem read-only, `scratch` writable, the person's
 * key folders hidden behind empty ones (key files behind /dev/null), its own pid namespace, the network shared. */
export function bwrapArgs(scratch: string, home: string, command: string, exists: (path: string) => "dir" | "file" | null = kindOf): string[] {
  const hidden = PRIVATE_READS.flatMap((part) => {
    const path = join(home, part), kind = exists(path);
    return kind === "dir" ? ["--tmpfs", path] : kind === "file" ? ["--ro-bind", "/dev/null", path] : [];
  });
  return ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--bind", scratch, scratch, ...hidden,
    "--unshare-pid", "--share-net", "--die-with-parent", "--chdir", scratch, "/bin/sh", "-c", command];
}

function kindOf(path: string): "dir" | "file" | null {
  try { return statSync(path).isDirectory() ? "dir" : "file"; } catch { return null; }
}

let linuxBox: { bwrap: string; works: boolean } | null | undefined;
/** bwrap when it is installed, and whether this kernel lets it make namespaces; checked once. */
const linuxFence = () => {
  if (linuxBox === undefined) { const found = whichOnPath("bwrap"); linuxBox = found ? { bwrap: found, works: probeBwrap(found) } : null; }
  return linuxBox;
};
export const BWRAP_REFUSED = "bubblewrap is installed but this computer will not let it make the namespaces a script check runs in (on Ubuntu 24.04 it needs an AppArmor profile for bwrap: https://github.com/DuskBotAI/duskbot/blob/main/docs/deploy-vps.md#ubuntu-2404-script-check-sandbox).";

/** A bot box for one spawn (server/bot-box, as background jobs use it on dusk cloud), or null where it is off. */
export type ScriptBox = (request: BoxRequest) => WrappedSpawn | null;
export const BOX_OFF = "Script checks on dusk cloud run in the bot's box, and the box isn't running on this home right now.";

export function runCheckScript(command: string, options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number; sandbox?: boolean;
  /** Runs it in this bot's box instead of the script fence; a box that is off fails the check. */
  box?: { wrap: ScriptBox; botId: string; home: string } } = {}): Promise<ScriptResult> {
  const source = options.env ?? process.env;
  const env: Record<string, string> = { HOME: source.HOME ?? homedir() };
  for (const name of BASE_NAMES) if (source[name]) env[name] = source[name]!;
  const windows = process.platform === "win32";
  // an app opened from the Dock or Finder gets launchd's short PATH, without Homebrew's tools
  if (!windows) env.PATH = [...new Set([...(env.PATH ?? "").split(":").filter(Boolean), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  if (options.box) return boxedScript(command, env, options.box, options.timeoutMs ?? SCRIPT_TIMEOUT_MS);
  const sandbox = options.sandbox ?? true;
  const seatbelt = sandbox && process.platform === "darwin" && existsSync(SANDBOX_EXEC);
  const fence = sandbox && process.platform === "linux" ? linuxFence() : null;
  if (fence && !fence.works) return Promise.resolve({ ok: false, error: BWRAP_REFUSED });
  const bwrap = fence?.bwrap ?? null;
  const boxed = seatbelt || bwrap !== null;
  let scratch: string | undefined;
  if (boxed) {
    scratch = join(tmpdir(), "dusk-script-checks");
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    scratch = realpathSync(scratch);
    env.TMPDIR = scratch;
  }
  const home = existsSync(env.HOME!) ? realpathSync(env.HOME!) : env.HOME!;
  const [file, args] = windows ? ["cmd.exe", ["/d", "/s", "/c", command]]
    : seatbelt ? [SANDBOX_EXEC, ["-p", sandboxProfile(scratch!, home), "/bin/sh", "-c", command]]
      : bwrap ? [bwrap, bwrapArgs(scratch!, home, command)]
        : ["/bin/sh", ["-c", command]];
  return collect(() => spawn(file, args, {
    cwd: options.cwd ?? scratch ?? env.HOME, env, stdio: ["ignore", "pipe", "pipe"], detached: !windows, windowsHide: true,
  }), options.timeoutMs ?? SCRIPT_TIMEOUT_MS);
}

function boxedScript(command: string, env: Record<string, string>, box: { wrap: ScriptBox; botId: string; home: string }, timeoutMs: number): Promise<ScriptResult> {
  mkdirSync(box.home, { recursive: true, mode: 0o700 });
  let wrapped: WrappedSpawn | null;
  try { wrapped = box.wrap({ command: "/bin/sh", args: ["-c", command], env: { ...env, HOME: box.home }, botId: box.botId, home: box.home }); }
  catch (error) { return Promise.resolve({ ok: false, error: `The bot's box could not start: ${error instanceof Error ? error.message : String(error)}` }); }
  if (!wrapped) return Promise.resolve({ ok: false, error: BOX_OFF });
  const boxed = wrapped;
  return collect(() => {
    try {
      const child = spawn(boxed.command, boxed.args, { env: boxed.env, stdio: ["ignore", "pipe", "pipe", ...boxed.extraFds], detached: true });
      child.once("exit", boxed.release);
      return child;
    } finally {
      for (const fd of boxed.extraFds) try { closeSync(fd); } catch { /* already closed */ }
    }
  }, timeoutMs);
}

function collect(start: () => ChildProcess, timeoutMs: number): Promise<ScriptResult> {
  const windows = process.platform === "win32";
  return new Promise((resolve) => {
    let out = "", err = "", settled = false;
    const done = (result: ScriptResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const child = start();
    const kill = () => { try { if (!windows && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => { kill(); done({ ok: false, error: `The script ran longer than ${Math.round(timeoutMs / 1000)} seconds.` }); }, timeoutMs);
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { if (out.length < SCRIPT_OUTPUT_MAX) out += chunk; });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { if (err.length < 2_000) err += chunk; });
    child.on("error", (error) => done({ ok: false, error: `The script could not start: ${error.message}` }));
    child.on("close", (code) => {
      if (code === 0) return done({ ok: true, output: out.slice(0, SCRIPT_OUTPUT_MAX) });
      const why = err.trim().split(/\r?\n/).at(-1)?.slice(0, 300);
      done({ ok: false, error: `The script stopped with exit code ${code ?? "unknown"}${why ? `: ${why}` : "."}` });
    });
  });
}

/** How a routine's script check runs: outside the fence only with `access: "full"` and never in a test run; a posting
 * script, and a full-access script outside a test run, for the routine's own time limit when it has one. */
export function scriptRunOptions(routine: Pick<Routine, "probe" | "timeoutMinutes">, dryRun = false): { sandbox: boolean; timeoutMs: number } {
  const sandbox = dryRun || routine.probe?.access !== "full";
  return { sandbox, timeoutMs: (routine.probe?.post || !sandbox) && routine.timeoutMinutes ? routine.timeoutMinutes * 60_000 : SCRIPT_TIMEOUT_MS };
}

export const SCRIPT_REFUSALS = {
  cloud: "On dusk cloud a script check runs in the bot's box, never with full access. Leave access out.",
  notPerson: "Only the person can have you set up a script check, in their own chat with you; work from a routine, an outside event, a room or another bot cannot. Use a page, feed or price check, or ask them.",
  owner: "Only this computer's owner can set up a script check.",
} as const;

export type ScriptGate = { refused: string } | { card: true } | { apply: true };

/** How this turn may give a routine a script check, which then runs a command with no AI: only on the owner's own
 * request; through the person's card (showing the command) at an ask-first level, for a script that runs outside the
 * fence (`unfenced`) at any level, or after the turn read anything from outside unless the bot has Full access, since
 * that text could have written the command. */
export function scriptCheckGate(
  turn: { owned: boolean; room: boolean; guest: boolean; depth: number; handedOff: boolean; outsideDriven: boolean; routineRun: boolean; personStarted: boolean; asksFirst: boolean },
  cloudHome: boolean,
  trust: { readOutside: boolean; fullAccess: boolean; unfenced: boolean },
): ScriptGate {
  if (cloudHome && trust.unfenced) return { refused: SCRIPT_REFUSALS.cloud };
  if (!turn.owned || turn.room || turn.guest || turn.depth > 0 || turn.handedOff || turn.outsideDriven || turn.routineRun || !turn.personStarted) return { refused: SCRIPT_REFUSALS.notPerson };
  return turn.asksFirst || trust.unfenced || (trust.readOutside && !trust.fullAccess) ? { card: true } : { apply: true };
}

type ProbeFields = { kind?: unknown; access?: unknown };

function setsProbe(value: unknown, matches: (probe: ProbeFields) => boolean): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as { probe?: ProbeFields | null; routine?: unknown; changes?: unknown };
  return (record.probe ? matches(record.probe) : false) || setsProbe(record.routine, matches) || setsProbe(record.changes, matches);
}

/** A routine, a change to one or a trigger request that sets a script check. */
export const setsScript = (value: unknown): boolean => setsProbe(value, (probe) => probe.kind === "script");

/** A routine, a change to one or a trigger request that lets a script check run outside the fence. */
export const setsFullAccess = (value: unknown): boolean => setsProbe(value, (probe) => probe.access === "full");

/** Why a person's own request may not set this routine's script check: only this computer's owner, and on dusk cloud
 * never with full access. */
export function scriptRoutineRefusal(body: unknown, cloudHome: boolean, owner: boolean): string | null {
  if (!setsScript(body)) return null;
  return cloudHome && setsFullAccess(body) ? SCRIPT_REFUSALS.cloud : owner ? null : SCRIPT_REFUSALS.owner;
}

/** The turn a confirmed script-check card starts, so the bot tells the person the watch is on. */
export const SCRIPT_CHECK_ON_NOTE = "[dusk bot: the person allowed the script check you asked for, and the automation is on now. Tell them so in one short line, nothing more.]";
