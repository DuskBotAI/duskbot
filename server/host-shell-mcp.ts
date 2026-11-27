// stdout is the MCP transport. Never log there.
// The shell of the person's own computer for a bot whose engine has none of its own (the chat-completions engines):
// run_command runs one command in the bot's working folder, find_files asks the system's own file index (Spotlight on
// macOS, Windows Search on Windows). Every call reaches here only after the engine's approval flow allowed it.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, posix, resolve, win32 } from "node:path";
import { createInterface } from "node:readline";

import { WORKSPACE_CREDENTIAL_ENV } from "./credential-env.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "./proxy-paths.ts";

export const HOST_SHELL_SERVER = "shell";
export const HOST_SHELL_CWD_ENV = "DUSK_SHELL_CWD";
export const HOST_SHELL_HIDDEN_ENV = "DUSK_SHELL_HIDDEN";
/** Set by `duskbot serve` for the server it starts on the person's own computer. */
export const SELF_HOSTED_ENV = "DUSK_SELF_HOSTED";

const DEFAULT_SECONDS = 60;
const MAX_SECONDS = 300;
const FIND_SECONDS = 20;
const OUTPUT_LIMIT = 30_000;
const COMMAND_LIMIT = 20_000;
const FIND_DEFAULT = 50;
const FIND_MAX = 200;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const HOST_SHELL_TOOLS = [
  {
    name: "run_command",
    description:
      "Run a shell command on the person's own computer, the one dusk bot runs on, and get its exit code, stdout and stderr back as text. It starts in your working folder, so files you make there can be attached to the chat. Use it for all command-line work: listing or reading files, moving or renaming them, converting a file, running a script with python3 or node, git, curl. On macOS and Linux it runs in a sh-compatible shell, on Windows in PowerShell. For a long job raise timeout_seconds (default 60, at most 300), or start it in the background with its output in a file and read that file later.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string", description: "The command to run, for example: ls -la ~/Downloads | head -50" },
        timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_SECONDS, description: "How long it may run before it is stopped. Default 60." },
      },
      required: ["command"],
    },
  },
  {
    name: "find_files",
    description:
      "Find files and folders on the person's computer: the system's own search index first (Spotlight on macOS, Windows Search on Windows), then a walk of their home folder, iCloud Drive included, when the index finds nothing. The way to find a file the person names or describes. Matches every word of the query in the file name (any order) by default; set in_content to match a phrase inside the files instead. Returns full paths. Never scan the whole disk with a command instead.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Part of the file name, for example: invoice 2026 or resume.pdf" },
        in_content: { type: "boolean", description: "Also match words inside documents. Default false." },
        folder: { type: "string", description: "Optional: only search inside this folder, as a full path or starting with ~." },
        limit: { type: "integer", minimum: 1, maximum: FIND_MAX, description: `How many paths at most. Default ${FIND_DEFAULT}.` },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
] as const;

export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function clip(text: string, limit = OUTPUT_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…(cut at ${limit} characters)` : text;
}

/** The environment a command sees: the server's, without dusk bot's own variables or the workspace's API keys. */
export function commandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const dropped = new Set<string>(WORKSPACE_CREDENTIAL_ENV.map((name) => name.toUpperCase()));
  for (const [key, value] of Object.entries(source)) {
    const name = key.toUpperCase();
    if (name.startsWith("DUSK_") || name === "ELECTRON_RUN_AS_NODE" || dropped.has(name)) continue;
    env[key] = value;
  }
  return env;
}

export function shellInvocation(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): { file: string; args: string[] } {
  if (platform === "win32") return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command] };
  const shell = env.SHELL && /\/(?:zsh|bash|sh)$/.test(env.SHELL) && existsSync(env.SHELL) ? env.SHELL : "/bin/sh";
  return { file: shell, args: ["-c", command] };
}

export type Runner = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ExecResult>;

/** Stops the whole process group at the limit, so a command's children do not outlive it. */
export const runProcess: Runner = (file, args, { cwd, env, timeoutMs }) => new Promise((done) => {
  const posix = process.platform !== "win32";
  const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: posix, windowsHide: true });
  let stdout = "", stderr = "", timedOut = false;
  const take = (into: "out" | "err") => (chunk: Buffer) => {
    if (into === "out") { if (stdout.length <= OUTPUT_LIMIT) stdout += chunk.toString("utf8"); }
    else if (stderr.length <= OUTPUT_LIMIT) stderr += chunk.toString("utf8");
  };
  child.stdout.on("data", take("out"));
  child.stderr.on("data", take("err"));
  const stop = () => {
    timedOut = true;
    try {
      if (posix && child.pid) process.kill(-child.pid, "SIGKILL");
      else if (child.pid) execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], () => {});
    } catch { child.kill("SIGKILL"); }
  };
  const timer = setTimeout(stop, timeoutMs);
  child.on("error", (error) => { clearTimeout(timer); done({ code: null, stdout, stderr: stderr + error.message, timedOut }); });
  child.on("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr, timedOut }); });
});

export async function runCommand(
  args: Json,
  options: { cwd: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: Runner },
): Promise<{ text: string; isError?: true }> {
  const command = typeof args.command === "string" ? args.command : "";
  if (!command.trim()) return { text: "command is required.", isError: true };
  if (command.length > COMMAND_LIMIT) return { text: "That command is too long; put it in a script file in your working folder and run the file.", isError: true };
  const seconds = Math.min(Math.max(Math.floor(typeof args.timeout_seconds === "number" && Number.isFinite(args.timeout_seconds) ? args.timeout_seconds : DEFAULT_SECONDS), 1), MAX_SECONDS);
  const platform = options.platform ?? process.platform;
  const env = commandEnvironment(options.env ?? process.env);
  const { file, args: argv } = shellInvocation(command, platform, env);
  const result = await (options.run ?? runProcess)(file, argv, { cwd: options.cwd, env, timeoutMs: seconds * 1000 });
  const lines = [result.timedOut ? `The command was stopped: it ran past its ${seconds}-second limit.` : `exit code ${result.code ?? "unknown"}`];
  if (result.stdout) lines.push("--- stdout ---", clip(result.stdout).replace(/\s+$/, ""));
  if (result.stderr) lines.push("--- stderr ---", clip(result.stderr).replace(/\s+$/, ""));
  if (!result.stdout && !result.stderr && !result.timedOut) lines.push("(no output)");
  return { text: lines.join("\n"), ...(result.code !== 0 || result.timedOut ? { isError: true as const } : {}) };
}

/** Windows Search's SQL dialect reads the query from the environment, never from the script text, and quotes it there. */
const WINDOWS_SEARCH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$q = $env:FIND_QUERY -replace \"'\", \"''\"",
  "$like = $q -replace '([%_\\[])', '[$1]'",
  "$where = if ($env:FIND_CONTENT -eq '1') { \"(System.FileName LIKE '%$like%' OR CONTAINS(*, '\"\"$($q -replace '\"', '')\"\"'))\" } else { \"System.FileName LIKE '%$like%'\" }",
  "if ($env:FIND_FOLDER) { $where += \" AND SCOPE='file:$($env:FIND_FOLDER -replace \"'\", \"''\")'\" }",
  "$c = New-Object -ComObject ADODB.Connection",
  "$c.Open(\"Provider=Search.CollatorDSO;Extended Properties='Application=Windows';\")",
  "$rs = $c.Execute(\"SELECT TOP $([int]$env:FIND_LIMIT) System.ItemPathDisplay FROM SYSTEMINDEX WHERE $where ORDER BY System.DateModified DESC\")",
  "while (-not $rs.EOF) { $rs.Fields.Item('System.ItemPathDisplay').Value; $rs.MoveNext() }",
].join("; ");

export function expandFolder(folder: unknown, home: string): string | undefined {
  if (typeof folder !== "string" || !folder.trim()) return undefined;
  const trimmed = folder.trim();
  const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") || trimmed.startsWith("~\\") ? resolve(home, trimmed.slice(2)) : trimmed;
  return isAbsolute(expanded) ? resolve(expanded) : undefined;
}

/** One search a find_files call can run. An index search (Spotlight, Windows Search, locate) that answers with nothing
 * hands over to the walk after it, as one that could not run does; a walk's answer is final. */
export interface FindStep { file: string; args: string[]; env?: Record<string, string>; index?: true }

const WALK_DEPTH = "8";

/** Spotlight skips ~/Library (iCloud Drive's local copy lives there), a folder it was told to leave out, and anything
 * outside an indexed volume, so a walk of the person's own folders stands in when it finds nothing. */
function walkInvocation(query: string, opts: { content: boolean; folder?: string; home: string; platform: NodeJS.Platform }): FindStep {
  const roots = opts.folder ? [opts.folder] : [opts.home, ...(opts.platform === "darwin" ? [posix.join(opts.home, "Library", "Mobile Documents")] : [])];
  const skipped = ["-name", ".*", "-o", "-name", "node_modules", ...(opts.folder ? [] : ["-o", "-path", posix.join(opts.home, "Library")])];
  if (opts.content) {
    return { file: "grep", args: ["-rIlsi", "-F", "--exclude-dir=.*", "--exclude-dir=node_modules", ...(opts.folder ? [] : ["--exclude-dir=Library"]), "-e", query, "--", ...roots] };
  }
  const words = query.replace(/[*?[\]\\]/g, "").split(/\s+/).filter(Boolean);
  return { file: "find", args: [...roots, "-maxdepth", WALK_DEPTH, "(", ...skipped, ")", "-prune", "-o", ...words.flatMap((word) => ["-iname", `*${word}*`]), "-print"] };
}

/** The searches, in order: the first that finds something answers. */
export function findInvocations(query: string, opts: { content: boolean; folder?: string; limit: number; platform: NodeJS.Platform; home: string }): FindStep[] {
  if (opts.platform === "darwin") {
    return [
      { file: "mdfind", args: [...(opts.folder ? ["-onlyin", opts.folder] : []), ...(opts.content ? [query] : ["-name", query])], index: true },
      walkInvocation(query, opts),
    ];
  }
  if (opts.platform === "win32") {
    return [
      { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SEARCH_SCRIPT],
        env: { FIND_QUERY: query, FIND_CONTENT: opts.content ? "1" : "0", FIND_FOLDER: opts.folder ?? "", FIND_LIMIT: String(opts.limit) }, index: true },
      { file: "where.exe", args: ["/r", opts.folder ?? opts.home, `*${query.replace(/[*?]/g, "")}*`] },
    ];
  }
  return [
    ...(opts.content ? [] : [{ file: "locate", args: ["-i", "-l", String(opts.limit), query], index: true as const }]),
    walkInvocation(query, opts),
  ];
}

function hiddenBy(hidden: readonly string[], path: string, separator: string): boolean {
  return hidden.some((root) => path === root || path.startsWith(root.endsWith(separator) ? root : root + separator));
}

export async function findFiles(
  args: Json,
  options: { platform?: NodeJS.Platform; home?: string; hidden?: readonly string[]; env?: NodeJS.ProcessEnv; run?: Runner },
): Promise<{ text: string; isError?: true }> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { text: "query is required.", isError: true };
  if (query.length > 300) return { text: "That query is too long.", isError: true };
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const folder = args.folder === undefined ? undefined : expandFolder(args.folder, home);
  if (args.folder !== undefined && !folder) return { text: "folder must be a full path or start with ~.", isError: true };
  const limit = Math.min(Math.max(Math.floor(typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : FIND_DEFAULT), 1), FIND_MAX);
  const env = commandEnvironment(options.env ?? process.env);
  const run = options.run ?? runProcess;
  const style = platform === "win32" ? win32 : posix;
  let failure = "";
  let empty = false;
  for (const step of findInvocations(query, { content: args.in_content === true, folder, limit, platform, home })) {
    const result = await run(step.file, step.args, { cwd: home, env: { ...env, ...step.env }, timeoutMs: FIND_SECONDS * 1000 });
    const paths = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && style.isAbsolute(line) && !hiddenBy(options.hidden ?? [], line, style.sep));
    // where.exe and grep answer 1 when nothing matched, find answers 1 when a folder could not be read: answers, not
    // failures; a walk stopped at its time limit still answers with what it found by then
    const answered = result.code === 0 || (!step.index && result.code === 1 && !result.timedOut) || paths.length > 0;
    if (!answered) { failure = (result.stderr || (result.timedOut ? "the search ran past its time limit" : "the search could not run")).trim(); continue; }
    if (!paths.length) { empty = true; if (step.index) continue; break; }
    const shown = paths.slice(0, limit);
    return { text: `${shown.join("\n")}${paths.length > shown.length ? `\n…(${paths.length - shown.length} more; narrow the query or pass a folder)` : ""}` };
  }
  if (empty) return { text: `No files matched "${query}"${folder ? ` in ${folder}` : ""}. Try one distinctive word of the name, or in_content for a word inside the file.` };
  return { text: `The file search could not run on this computer (${clip(failure, 300)}). Use run_command to look in a likely folder instead, with a depth limit.`, isError: true };
}

/** The desktop app's own server lends its computer's shell, a dusk cloud home its own and a server the person runs on a
 * computer of theirs with `duskbot serve` its own (where Claude Code and Codex run their shell too), only to an engine
 * that has none, in a turn that works on this computer: never Off, a VPS or team computer, a policy that bars this
 * computer, a guest's or a confined turn, or an automation's test run. */
export function mountsHostShell(input: {
  engineHasShell: boolean; desktopApp: boolean; cloudHome: boolean; worksOn: "off" | string | undefined;
  /** Started by `duskbot serve` on the person's own server: not the desktop app, a cloud home or a copy run from source. */
  selfHosted?: boolean;
  remoteComputer: boolean; thisComputerRefused: boolean; guest: boolean; testRun: boolean;
  /** Where the model runs (agents-bridge-switch modelPlace). */
  model: "hosted" | "loopback" | "network";
  platform: NodeJS.Platform;
  /** A person's own request or its continuation: not a routine, webhook, Bot API call or a teammate's hand-off. */
  watched: boolean;
  /** The server lets people other than its owner in (a sign-in allow list or a team). */
  shared?: boolean;
}): boolean {
  // security: a self-hosted server's shell is unsandboxed and runs as the server's user, so only its owner's own turns get it
  const selfHosted = input.selfHosted === true && input.watched && input.shared !== true;
  const lent = !input.engineHasShell && (input.desktopApp || input.cloudHome || selfHosted) && input.worksOn !== "off"
    && !input.remoteComputer && !input.thisComputerRefused && !input.guest && !input.testRun;
  if (input.model === "hosted") return lent;
  // a local model gets it only from this machine, off Windows (the safety floor is inert there) and with a person behind the turn
  return lent && input.model === "loopback" && input.platform !== "win32" && input.watched;
}

/** The server's launch line, working in `folder`, its search never listing what lies under `hidden`; where the bot box
 * is on (a dusk cloud home) it runs boxed with `folder` and the bot's own folder writable, as the bot's engine would. */
export function hostShellLaunch(folder: string | undefined, hidden: readonly string[], botId?: string): { command: string; args: string[]; env: Record<string, string>; box: { rw: string[]; botId?: string } } | null {
  if (!folder || !isAbsolute(folder)) return null;
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return { command: process.execPath, args: [SPAWNED_PROXIES.hostShell], env: { ...AGENTS_NODE_FLAG, [HOST_SHELL_CWD_ENV]: folder, [HOST_SHELL_HIDDEN_ENV]: JSON.stringify(hidden) },
    box: { rw: [folder], ...(botId ? { botId } : {}) } };
}

export interface HostShellOptions { cwd: string; hidden: readonly string[] }

/** One JSON-RPC message; undefined for a notification, which gets no answer. */
export async function handleHostShellRpc(message: unknown, options: HostShellOptions & { run?: Runner; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): Promise<Json | undefined> {
  const rpc = isRecord(message) ? message : {};
  const id = rpc.id;
  if (id === undefined) return undefined;
  const reply = (body: Json) => ({ jsonrpc: "2.0", id, ...body });
  switch (rpc.method) {
    case "initialize":
      return reply({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "dusk-bot-shell", version: "1" } } });
    case "ping":
      return reply({ result: {} });
    case "tools/list":
      return reply({ result: { tools: HOST_SHELL_TOOLS } });
    case "tools/call": {
      const params = isRecord(rpc.params) ? rpc.params : {};
      const args = isRecord(params.arguments) ? params.arguments : {};
      const answer = params.name === "run_command" ? await runCommand(args, options)
        : params.name === "find_files" ? await findFiles(args, options)
        : null;
      if (!answer) return reply({ error: { code: -32602, message: "Unknown tool. The tools are run_command and find_files." } });
      return reply({ result: { content: [{ type: "text", text: answer.text }], ...(answer.isError ? { isError: true } : {}) } });
    }
    default:
      return reply({ error: { code: -32601, message: "Method not found" } });
  }
}

function main(): void {
  const cwd = process.env[HOST_SHELL_CWD_ENV] ?? "";
  if (!cwd || !isAbsolute(cwd) || !existsSync(cwd)) {
    process.stderr.write("host-shell-mcp: invalid working folder\n");
    process.exit(2);
  }
  let hidden: string[] = [];
  try { hidden = JSON.parse(process.env[HOST_SHELL_HIDDEN_ENV] ?? "[]"); } catch { hidden = []; }
  const options: HostShellOptions = { cwd, hidden: Array.isArray(hidden) ? hidden.filter((path): path is string => typeof path === "string" && isAbsolute(path)) : [] };
  let pending = 0, ended = false;
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    let message: unknown;
    try { message = JSON.parse(line); } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } })}\n`);
      return;
    }
    pending++;
    void handleHostShellRpc(message, options).then((answer) => { if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`); })
      .finally(() => { if (--pending === 0 && ended) process.exit(0); });
  });
  process.stdin.on("end", () => { ended = true; if (pending === 0) process.exit(0); });
}

if (process.argv[1] && /host-shell-mcp\.(?:ts|js)$/.test(process.argv[1])) main();
