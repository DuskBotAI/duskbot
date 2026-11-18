import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

import { stripWorkspaceCredentialEnv } from "./credential-env.ts";
import { augmentedPath } from "./env-path.ts";
import { killCliTree, spawnCli } from "./procs.ts";

export const HOST_SHELL_SERVER = "shell";
export const HOST_SHELL_TOOL = "run_command";
export const HOST_SHELL_DEFAULT_SECONDS = 120;
export const HOST_SHELL_MAX_SECONDS = 300;
export const HOST_SHELL_OUTPUT_BYTES = 200 * 1024;
export const HOST_SHELL_COMMAND_CHARS = 20_000;
const KILL_GRACE_MS = 3_000;
const PIPE_GRACE_MS = 2_000;

export interface HostShellLaunch {
  command: string;
  args: string[];
}

export function hostShellLaunch(command: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): HostShellLaunch {
  if (platform === "win32") return { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
  const own = env.SHELL?.trim();
  const shell = own && isAbsolute(own) && !/\s/u.test(own) && existsSync(own) ? own : "/bin/sh";
  return { command: shell, args: ["-l", "-c", command] };
}

export function resolveHostShellCwd(value: unknown, base: string, home: string = homedir()): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return base;
  if (text === "~") return home;
  if (text.startsWith("~/") || text.startsWith("~\\")) return join(home, text.slice(2));
  return isAbsolute(text) ? normalize(text) : join(base, text);
}

export function hostShellEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, PATH: augmentedPath(), TERM: "dumb" };
  stripWorkspaceCredentialEnv(env);
  return env;
}

function outputTail(limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let cut = false;
  return {
    push(chunk: Buffer) {
      chunks.push(chunk);
      size += chunk.length;
      while (chunks.length > 1 && size - chunks[0]!.length >= limit) {
        size -= chunks.shift()!.length;
        cut = true;
      }
    },
    text() {
      const all = Buffer.concat(chunks);
      return (all.length > limit ? all.subarray(all.length - limit) : all).toString("utf8");
    },
    cut: () => cut || size > limit,
  };
}

export interface HostCommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
  stopped: boolean;
  cut: boolean;
  failed?: string;
}

export interface HostCommandRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  outputBytes?: number;
}

export interface HostCommandDeps {
  start(launch: HostShellLaunch, options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess;
  stop(child: ChildProcess): unknown;
}

const hostProcesses: HostCommandDeps = {
  start: (launch, options) => spawnCli(launch.command, launch.args, { ...options, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, box: true, botWork: true }),
  stop: (child) => killCliTree(child, KILL_GRACE_MS),
};

export function runHostCommand(request: HostCommandRequest, deps: HostCommandDeps = hostProcesses): Promise<HostCommandResult> {
  return new Promise((resolve) => {
    const output = outputTail(request.outputBytes ?? HOST_SHELL_OUTPUT_BYTES);
    const none = { code: null, signal: null, output: "", timedOut: false, stopped: false, cut: false };
    if (request.signal.aborted) return resolve({ ...none, stopped: true });
    let child: ChildProcess;
    try { child = deps.start(hostShellLaunch(request.command, process.platform, request.env), { cwd: request.cwd, env: request.env }); }
    catch (error) { return resolve({ ...none, failed: error instanceof Error ? error.message : String(error) }); }
    let timedOut = false;
    let stopped = false;
    let settled = false;
    const finish = (result: HostCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const outcome = (code: number | null, signal: NodeJS.Signals | null): HostCommandResult => ({ code, signal, output: output.text(), timedOut, stopped, cut: output.cut() });
    const halt = () => {
      void Promise.resolve(deps.stop(child)).catch(() => {}).then(() => setTimeout(() => finish(outcome(child.exitCode, child.signalCode)), PIPE_GRACE_MS).unref());
    };
    const abort = () => { stopped = true; halt(); };
    const timer = setTimeout(() => { timedOut = true; halt(); }, request.timeoutMs);
    request.signal.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", output.push);
    child.stderr?.on("data", output.push);
    child.once("error", (error) => finish({ ...none, failed: error.message }));
    child.once("close", (code, signal) => finish(outcome(code, signal)));
  });
}

export function hostCommandText(result: HostCommandResult, seconds: number): string {
  if (result.failed !== undefined) return `The command could not start: ${result.failed}`;
  const head = result.timedOut ? `stopped after ${seconds} s (it may have changed things already); output so far:`
    : result.stopped ? "stopped with the turn (it may have changed things already); output so far:"
    : result.code === null ? `ended by ${result.signal ?? "a signal"}` : `exit code ${result.code}`;
  return `${head}${result.cut ? " (last 200 KB of output)" : ""}\n${result.output}`;
}

function toolDefinition(platform: NodeJS.Platform) {
  const shell = platform === "win32" ? "Windows PowerShell" : "the person's login shell (zsh or bash)";
  return {
    name: HOST_SHELL_TOOL,
    description: `Run a command on the person's own computer in ${shell}, starting in your working folder unless cwd is given. Returns the exit code and the output `
      + "(stdout and stderr together, the last 200 KB). Use this for all command-line work here: never open Terminal, Command Prompt or PowerShell on the screen "
      + "and type a command into it. Start anything that keeps running (a server, a watcher) detached with its output sent to a file, and read that file with a "
      + "later call. A command that was stopped at its time limit may still have changed things; check before repeating it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string", minLength: 1, maxLength: HOST_SHELL_COMMAND_CHARS, description: "The command line." },
        cwd: { type: "string", minLength: 1, maxLength: 2048, description: "Folder to run in; ~ is the home folder and a relative path starts at your working folder." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: HOST_SHELL_MAX_SECONDS, description: `Stop it after this long; default ${HOST_SHELL_DEFAULT_SECONDS}.` },
      },
      required: ["command"],
    },
  };
}

type Frame = Record<string, unknown>;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const refused = (text: string) => ({ content: [{ type: "text", text }], isError: true });

function workingFolder(folder: string): string {
  try {
    mkdirSync(folder, { recursive: true });
    return folder;
  } catch {
    return homedir();
  }
}

async function callTool(params: unknown, mount: { cwd: string }, stop: AbortSignal, run: typeof runHostCommand, env: () => NodeJS.ProcessEnv) {
  const { name, arguments: args } = (isObject(params) ? params : {}) as { name?: unknown; arguments?: unknown };
  if (name !== HOST_SHELL_TOOL) return refused(`Unknown tool. Use ${HOST_SHELL_TOOL}.`);
  if (!isObject(args) || typeof args.command !== "string" || !args.command.trim() || args.command.length > HOST_SHELL_COMMAND_CHARS) {
    return refused("Pass the command line as `command`.");
  }
  const seconds = Number.isInteger(args.timeout_seconds) ? Math.min(Math.max(args.timeout_seconds as number, 1), HOST_SHELL_MAX_SECONDS) : HOST_SHELL_DEFAULT_SECONDS;
  const cwd = resolveHostShellCwd(args.cwd, workingFolder(mount.cwd));
  let folder = false;
  try { folder = statSync(cwd).isDirectory(); } catch { folder = false; }
  if (!folder) return refused(`${cwd} is not a folder.`);
  const result = await run({ command: args.command, cwd, timeoutMs: seconds * 1000, env: env(), signal: stop });
  return { content: [{ type: "text", text: hostCommandText(result, seconds) }], isError: result.failed !== undefined || result.timedOut || result.stopped || result.code !== 0 };
}

export function hostShellAnswer(mount: { cwd: string }, options: { run?: typeof runHostCommand; env?: () => NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}):
  (stop: AbortSignal) => (frame: Frame) => Promise<unknown> {
  const run = options.run ?? runHostCommand;
  const env = options.env ?? (() => hostShellEnvironment());
  const tool = toolDefinition(options.platform ?? process.platform);
  return (stop) => async (frame) => {
    if (frame.id === undefined) return undefined;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: frame.id, result });
    if (frame.method === "initialize") return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "duskbot-host-shell", version: "1" } });
    if (frame.method === "tools/list") return reply({ tools: [tool] });
    if (frame.method === "tools/call") return reply(await callTool(frame.params, mount, stop, run, env));
    return { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Method not found" } };
  };
}
