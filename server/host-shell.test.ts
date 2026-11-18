import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderAdapter, SendTurnInput } from "./contracts.ts";
import {
  HOST_SHELL_DEFAULT_SECONDS, HOST_SHELL_MAX_SECONDS, HOST_SHELL_TOOL, hostCommandText, hostShellAnswer, hostShellEnvironment, hostShellLaunch,
  resolveHostShellCwd, runHostCommand, type HostCommandRequest, type HostCommandResult,
} from "./host-shell.ts";
import { offerHostShell } from "./local-computer.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const posix = process.platform !== "win32";
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await removeTempDir(folder); });

function folder(): string {
  const made = realpathSync(mkdtempSync(join(tmpdir(), "dusk-host-shell-")));
  folders.push(made);
  return made;
}

const request = (command: string, cwd: string, extra: Partial<HostCommandRequest> = {}): HostCommandRequest =>
  ({ command, cwd, timeoutMs: 20_000, env: { ...process.env, SHELL: "/bin/sh" }, signal: new AbortController().signal, ...extra });

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function gone(pid: number): Promise<boolean> {
  for (let tries = 0; tries < 100 && alive(pid); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  return !alive(pid);
}

describe("which shell a command runs in", () => {
  it("is Windows PowerShell on Windows, with no profile and no prompt, the command as one argument", () => {
    expect(hostShellLaunch('Get-ChildItem "$HOME\\Downloads" | Select-Object -First 3', "win32", {})).toEqual({
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", 'Get-ChildItem "$HOME\\Downloads" | Select-Object -First 3'],
    });
  });

  it.skipIf(!posix)("is the person's login shell elsewhere, and /bin/sh when that is missing or not a plain path", () => {
    expect(hostShellLaunch("ls", "darwin", { SHELL: "/bin/sh" })).toEqual({ command: "/bin/sh", args: ["-l", "-c", "ls"] });
    expect(hostShellLaunch("ls", "linux", { SHELL: "/nowhere/zsh" })).toEqual({ command: "/bin/sh", args: ["-l", "-c", "ls"] });
    expect(hostShellLaunch("ls", "linux", { SHELL: "zsh" })).toEqual({ command: "/bin/sh", args: ["-l", "-c", "ls"] });
    expect(hostShellLaunch("ls", "linux", {})).toEqual({ command: "/bin/sh", args: ["-l", "-c", "ls"] });
  });
});

describe("where a command starts", () => {
  it("is the working folder, with ~ for home and a relative path under the working folder", () => {
    expect(resolveHostShellCwd(undefined, "/work", "/home/me")).toBe("/work");
    expect(resolveHostShellCwd("  ", "/work", "/home/me")).toBe("/work");
    expect(resolveHostShellCwd("~", "/work", "/home/me")).toBe("/home/me");
    expect(resolveHostShellCwd("~/Downloads", "/work", "/home/me")).toBe(join("/home/me", "Downloads"));
    expect(resolveHostShellCwd("reports/q3", "/work", "/home/me")).toBe(join("/work", "reports/q3"));
    expect(resolveHostShellCwd("/tmp/../etc", "/work", "/home/me")).toBe(join("/etc"));
  });
});

describe("what a command's environment holds", () => {
  it("leaves out the workspace's provider keys and the operator's secrets, and keeps the rest", () => {
    const env = hostShellEnvironment({ HOME: "/home/me", DUSK_OPENAI_API_KEY: "k", COMPOSIO_API_KEY: "k", DUSK_LICENSE_KEY: "k", DUSK_CLOUD_VOICE_TOKEN: "k", KEPT: "yes" });
    expect(env).toMatchObject({ HOME: "/home/me", KEPT: "yes", TERM: "dumb" });
    expect(Object.keys(env).filter((name) => /KEY|TOKEN/u.test(name))).toEqual([]);
    expect(env.PATH).toBeTruthy();
  });
});

describe.skipIf(!posix)("running a command on this machine", () => {
  it("returns the exit code and stdout and stderr together, from the folder it was given", async () => {
    const cwd = folder();
    const result = await runHostCommand(request("echo out; echo err >&2; pwd; exit 3", cwd));
    expect(result).toMatchObject({ code: 3, timedOut: false, stopped: false, cut: false });
    expect(result.output.split("\n").filter(Boolean).sort()).toEqual([cwd, "err", "out"].sort());
    expect(hostCommandText(result, 120)).toMatch(/^exit code 3\n/u);
  });

  it("gives the command no stdin to wait on", async () => {
    const result = await runHostCommand(request("cat; echo after", folder()));
    expect(result).toMatchObject({ code: 0, output: "after\n" });
  });

  it("keeps only the end of a long output and says so", async () => {
    const result = await runHostCommand(request("i=0; while [ $i -lt 400 ]; do echo line-$i; i=$((i+1)); done", folder(), { outputBytes: 256 }));
    expect(result.cut).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(256);
    expect(result.output.endsWith("line-399\n")).toBe(true);
    expect(hostCommandText(result, 120)).toMatch(/^exit code 0 \(last 200 KB of output\)\n/u);
  });

  it("stops the whole process tree at the time limit", async () => {
    const cwd = folder();
    const result = await runHostCommand(request("sleep 60 & echo $! > child.pid; echo started; wait", cwd, { timeoutMs: 400 }));
    expect(result).toMatchObject({ timedOut: true, stopped: false });
    expect(result.output).toContain("started");
    expect(hostCommandText(result, 1)).toMatch(/^stopped after 1 s \(it may have changed things already\); output so far:\nstarted/u);
    expect(await gone(Number(readFileSync(join(cwd, "child.pid"), "utf8").trim()))).toBe(true);
  }, 30_000);

  it("stops the whole process tree when the turn ends", async () => {
    const cwd = folder();
    const turn = new AbortController();
    const running = runHostCommand(request("sleep 60 & echo $! > child.pid; wait", cwd, { signal: turn.signal }));
    for (let tries = 0; tries < 100 && !existsSync(join(cwd, "child.pid")); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    turn.abort();
    expect(await running).toMatchObject({ stopped: true, timedOut: false });
    expect(await gone(Number(readFileSync(join(cwd, "child.pid"), "utf8").trim()))).toBe(true);
  }, 30_000);

  it("starts nothing for a turn that has already ended", async () => {
    const cwd = folder();
    const turn = new AbortController();
    turn.abort();
    expect(await runHostCommand(request("touch ran", cwd, { signal: turn.signal }))).toMatchObject({ stopped: true, code: null });
    expect(existsSync(join(cwd, "ran"))).toBe(false);
  });
});

describe("a command that cannot be followed to its end", () => {
  function fakeChild(): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, pid: 4242 });
    return child;
  }

  it("reports a shell that will not start", async () => {
    const result = await runHostCommand(request("ls", "/"), { start: () => { throw new Error("spawn powershell.exe ENOENT"); }, stop: () => {} });
    expect(hostCommandText(result, 120)).toBe("The command could not start: spawn powershell.exe ENOENT");
  });

  it("still answers when a stopped command's pipes never close", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const stop = vi.fn(() => Promise.resolve(true));
      const running = runHostCommand(request("serve", "/", { timeoutMs: 1_000 }), { start: () => child, stop });
      child.stdout!.emit("data", Buffer.from("listening\n"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stop).toHaveBeenCalledWith(child);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await running).toMatchObject({ timedOut: true, output: "listening\n", code: null });
    } finally { vi.useRealTimers(); }
  });
});

describe("the shell tool a turn is given", () => {
  const call = async (answer: ReturnType<ReturnType<typeof hostShellAnswer>>, method: string, params?: unknown) =>
    (await answer({ jsonrpc: "2.0", id: 7, method, params }) as { id: number; result: Record<string, unknown> });
  const ran = (result: Partial<HostCommandResult> = {}): HostCommandResult => ({ code: 0, signal: null, output: "ok\n", timedOut: false, stopped: false, cut: false, ...result });

  it("lists one tool that names the platform's shell and tells the model not to type into a terminal window", async () => {
    const windows = hostShellAnswer({ cwd: "/" }, { platform: "win32" })(new AbortController().signal);
    const { result } = await call(windows, "tools/list");
    const tools = result.tools as Array<{ name: string; description: string; inputSchema: { required: string[]; properties: Record<string, { maximum?: number }> } }>;
    expect(tools.map((tool) => tool.name)).toEqual([HOST_SHELL_TOOL]);
    expect(tools[0]!.description).toContain("Windows PowerShell");
    expect(tools[0]!.description).toContain("never open Terminal, Command Prompt or PowerShell on the screen");
    expect(tools[0]!.inputSchema.required).toEqual(["command"]);
    expect(tools[0]!.inputSchema.properties.timeout_seconds!.maximum).toBe(HOST_SHELL_MAX_SECONDS);
    const mac = hostShellAnswer({ cwd: "/" }, { platform: "darwin" })(new AbortController().signal);
    expect(((await call(mac, "tools/list")).result.tools as Array<{ description: string }>)[0]!.description).toContain("login shell");
    expect(await mac({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    expect((await call(mac, "initialize")).result).toMatchObject({ capabilities: { tools: {} } });
  });

  it("runs the command in the working folder with the default limit, and marks a failing one as an error", async () => {
    const cwd = folder();
    const run = vi.fn<typeof runHostCommand>(async () => ran({ code: 2, output: "no such file\n" }));
    const turn = new AbortController();
    const answer = hostShellAnswer({ cwd }, { run, env: () => ({ ONLY: "this" }) })(turn.signal);
    const { result } = await call(answer, "tools/call", { name: HOST_SHELL_TOOL, arguments: { command: "ls missing" } });
    expect(run).toHaveBeenCalledWith({ command: "ls missing", cwd, timeoutMs: HOST_SHELL_DEFAULT_SECONDS * 1000, env: { ONLY: "this" }, signal: turn.signal });
    expect(result).toEqual({ content: [{ type: "text", text: "exit code 2\nno such file\n" }], isError: true });
  });

  it("holds the time limit to its ceiling and resolves the folder it is given", async () => {
    const cwd = folder();
    writeFileSync(join(cwd, "file"), "");
    const run = vi.fn<typeof runHostCommand>(async () => ran());
    const answer = hostShellAnswer({ cwd }, { run, env: () => ({}) })(new AbortController().signal);
    const ok = await call(answer, "tools/call", { name: HOST_SHELL_TOOL, arguments: { command: "pwd", cwd: "~", timeout_seconds: 9_999 } });
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: homedir(), timeoutMs: HOST_SHELL_MAX_SECONDS * 1000 }));
    expect(ok.result).toEqual({ content: [{ type: "text", text: "exit code 0\nok\n" }], isError: false });
    const notFolder = await call(answer, "tools/call", { name: HOST_SHELL_TOOL, arguments: { command: "pwd", cwd: "file" } });
    expect(notFolder.result).toEqual({ content: [{ type: "text", text: `${join(cwd, "file")} is not a folder.` }], isError: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("makes the working folder when the bot has not used it yet, and never a folder the call names", async () => {
    const root = folder();
    const run = vi.fn<typeof runHostCommand>(async () => ran());
    const answer = hostShellAnswer({ cwd: join(root, "workspaces", "bot-1") }, { run, env: () => ({}) })(new AbortController().signal);
    await call(answer, "tools/call", { name: HOST_SHELL_TOOL, arguments: { command: "pwd" } });
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: join(root, "workspaces", "bot-1") }));
    expect(existsSync(join(root, "workspaces", "bot-1"))).toBe(true);
    const missing = await call(answer, "tools/call", { name: HOST_SHELL_TOOL, arguments: { command: "pwd", cwd: join(root, "elsewhere") } });
    expect(missing.result.isError).toBe(true);
    expect(existsSync(join(root, "elsewhere"))).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs nothing for another tool name or a call with no command", async () => {
    const run = vi.fn<typeof runHostCommand>(async () => ran());
    const answer = hostShellAnswer({ cwd: folder() }, { run, env: () => ({}) })(new AbortController().signal);
    expect((await call(answer, "tools/call", { name: "write_file", arguments: { command: "ls" } })).result.isError).toBe(true);
    expect((await call(answer, "tools/call", { name: HOST_SHELL_TOOL, arguments: { command: "  " } })).result.isError).toBe(true);
    expect((await call(answer, "tools/call", { name: HOST_SHELL_TOOL })).result.isError).toBe(true);
    expect(await answer({ jsonrpc: "2.0", id: 9, method: "resources/list" })).toMatchObject({ id: 9, error: { code: -32601 } });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("which turns are offered the shell", () => {
  type Integrations = NonNullable<SendTurnInput["integrations"]>;
  const desktop = { command: "cua", args: [], env: {} };
  const hostDesktop = (): Integrations => ({ localComputer: { ...desktop, scope: "local-computer" } });
  const localModel = { sessionModelSwitch: "in-session", hostShellMcp: true } as ProviderAdapter["capabilities"];
  const otherEngine = { sessionModelSwitch: "in-session", localComputerMcp: true } as ProviderAdapter["capabilities"];
  const offered = (integrations: Integrations, capabilities = localModel, turn: { guestConfined: boolean; cwd?: string } = { guestConfined: false }) => {
    offerHostShell(integrations, capabilities, turn);
    return integrations.hostShell;
  };

  it("a local model's turn that mounted this computer, starting in the turn's folder when it has one", () => {
    expect(offered(hostDesktop())).toEqual({});
    expect(offered(hostDesktop(), localModel, { guestConfined: false, cwd: "/work" })).toEqual({ cwd: "/work" });
  });

  it("never an engine that does not mount it: an API-key model, Claude Code, Codex", () => {
    expect(offered(hostDesktop(), otherEngine)).toBeUndefined();
    expect(offered(hostDesktop(), { ...localModel, hostShellMcp: false })).toBeUndefined();
  });

  it("never a turn working anywhere but this computer: no computer, a Local VM, a VPS or a cloud desktop", () => {
    expect(offered({})).toBeUndefined();
    expect(offered({ browser: desktop })).toBeUndefined();
    expect(offered({ localComputer: desktop })).toBeUndefined();
    expect(offered({ localComputer: { ...desktop, platform: "linux", generation: "vm-1" } })).toBeUndefined();
  });

  it("never a guest's turn", () => {
    expect(offered(hostDesktop(), localModel, { guestConfined: true })).toBeUndefined();
  });
});
