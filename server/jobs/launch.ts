// How a job's process starts: in a bot box of its own where turns are boxed (the same mounts, egress gate, harness gate
// and environment allow-list as a turn, docs/bot-box.md), otherwise as a plain process group on this computer. Either
// way it gets a fresh environment, never the server's: the names a shell needs, the job's own, its Vault secrets, and
// `dusk-notify` on PATH with this run's token.
import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveProxy } from "../proxy-paths.ts";
import type { BoxRequest } from "../bot-box/plan.ts";
import type { WrappedSpawn } from "../bot-box/box.ts";
import { BOX_ENV_NEVER, BOX_ENV_NEVER_PREFIXES } from "../bot-box/env.ts";
import { JobRefusal, type JobProcess, type JobRecord } from "./supervisor.ts";

export const JOB_NOTIFY_PATH = "/api/internal/jobs/notify";
export const NOTIFY_SCRIPT = resolveProxy("jobs/dusk-notify");
export const TELEGRAM_WATCH_SCRIPT = resolveProxy("jobs/telegram-watch");

/** What a job's environment starts from, taken from the server's own: never a key, a token or a dusk bot setting. */
const BASE_NAMES = ["PATH", "LANG", "LANGUAGE", "TZ", "TERM", "USER", "LOGNAME", "SHELL", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "DUSK_TELEGRAM_API_URL"];
/** Names a job may not set itself: its placement, its network path and dusk bot's own. */
const RESERVED = new Set(["PATH", "HOME", "PWD", "SHELL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Why a job may not set this environment name, or null. */
export function envNameRefusal(name: string): string | null {
  if (!ENV_NAME.test(name)) return `${name} is not a plain environment name (letters, digits and _).`;
  const upper = name.toUpperCase();
  if (RESERVED.has(upper) || upper.startsWith("DUSK_") || upper.startsWith("DYLD_") || BOX_ENV_NEVER.has(name) || BOX_ENV_NEVER_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
    return `${name} is set by dusk bot; pick another name.`;
  }
  return null;
}

export interface LaunchDeps {
  dataDir: string;
  /** The server's loopback port: a job reaches JOB_NOTIFY_PATH there (through the harness gate when boxed). */
  port: number;
  /** The box for a spawn, or null where turns run unboxed. Throws where the box is required and cannot start. */
  wrap(request: BoxRequest): WrappedSpawn | null;
  /** The value of a secret the person keeps in their Vault for this bot, or null. */
  secret(label: string, botId: string): string | null;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
}

/** The job's PATH: dusk-notify first, then the server's own, always with the system's folders. */
export function jobPath(bin: string, serverPath: string | undefined): string {
  const parts = [bin, ...(serverPath ?? "").split(":").filter(Boolean)];
  for (const system of ["/usr/local/bin", "/usr/bin", "/bin"]) if (!parts.includes(system)) parts.push(system);
  return parts.join(":");
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The bot's folder for its jobs: `bin` (dusk-notify), `home` (HOME in a box) and one state folder per job label. */
export function jobsFolder(dataDir: string, botId: string): string {
  return join(dataDir, "workspaces", botId, ".jobs");
}

export function labelSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "job";
}

/** The command line that runs a script of dusk bot's own with the node it runs on (Electron's binary, as node). */
export function nodeScriptCommand(script: string, execPath = process.execPath): string {
  return `${shellQuote(execPath)} ${shellQuote(script)}`;
}

export function createJobLauncher(deps: LaunchDeps) {
  const env = deps.env ?? process.env;
  const execPath = deps.execPath ?? process.execPath;
  return (job: JobRecord, token: string): { process: JobProcess; secrets: string[] } => {
    if (process.platform === "win32") throw new JobRefusal("Background jobs need a Mac or Linux computer; this one runs Windows.");
    if (!existsSync(job.cwd)) throw new JobRefusal(`The job's folder ${job.cwd} is gone.`);
    const folder = jobsFolder(deps.dataDir, job.botId), bin = join(folder, "bin"), home = join(folder, "home"), state = join(folder, "state", labelSlug(job.label));
    for (const dir of [bin, home, state]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const notify = join(bin, "dusk-notify");
    writeFileSync(notify, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(execPath)} ${shellQuote(NOTIFY_SCRIPT)} "$@"\n`, { mode: 0o755 });
    chmodSync(notify, 0o755);

    const secrets: Record<string, string> = {};
    for (const [name, label] of Object.entries(job.secrets)) {
      const value = deps.secret(label, job.botId);
      if (value === null) throw new JobRefusal(`${label} is not in the person's Vault for this bot any more. Ask for it again with request_credential, then start the job again.`);
      secrets[name] = value;
    }
    const base: Record<string, string> = {};
    for (const name of BASE_NAMES) if (env[name]) base[name] = env[name]!;
    const childEnv: Record<string, string> = {
      ...base, ...job.env, ...secrets,
      PATH: jobPath(bin, env.PATH),
      PYTHONUNBUFFERED: "1",
      ELECTRON_RUN_AS_NODE: "1",
      DUSK_JOB_ID: job.id,
      DUSK_JOB_DIR: state,
      DUSK_JOB_TOKEN: token,
      DUSK_JOB_NOTIFY_URL: `http://127.0.0.1:${deps.port}${JOB_NOTIFY_PATH}`,
    };
    const args = ["-n", "10", "sh", "-c", job.command];
    const boxed = deps.wrap({
      command: "nice", args, cwd: job.cwd, env: { ...childEnv, HOME: home }, botId: job.botId, home,
      allowEnv: [...Object.keys(job.env), ...Object.keys(secrets)],
    });
    const stdio = ["ignore", "pipe", "pipe", ...(boxed?.extraFds ?? [])] as const;
    let child;
    try {
      child = boxed
        ? spawn(boxed.command, boxed.args, { env: boxed.env, stdio: [...stdio], detached: true })
        : spawn(existsSync("/usr/bin/nice") ? "/usr/bin/nice" : "nice", args, { cwd: job.cwd, env: { ...childEnv, HOME: env.HOME ?? home }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } finally {
      for (const fd of boxed?.extraFds ?? []) try { closeSync(fd); } catch {}
    }
    if (boxed?.token) child.once("exit", boxed.release);
    return { process: child, secrets: Object.values(secrets) };
  };
}
