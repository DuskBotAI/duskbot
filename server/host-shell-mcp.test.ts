import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { modelPlace } from "./agents-bridge-switch.ts";
import { planBox, visibleInBox } from "./bot-box/plan.ts";
import { commandEnvironment, findFiles, hostShellLaunch, findInvocations, handleHostShellRpc, mountsHostShell, runCommand, runProcess, type Runner } from "./host-shell-mcp.ts";

const desktopTurn = { engineHasShell: false, desktopApp: true, cloudHome: false, worksOn: undefined, remoteComputer: false, thisComputerRefused: false, guest: false, testRun: false,
  model: "hosted" as const, platform: "darwin" as const, watched: true };

describe("mountsHostShell", () => {
  it("lends this computer's shell to a desktop bot whose engine has none, on Auto or This computer", () => {
    expect(mountsHostShell(desktopTurn)).toBe(true);
    expect(mountsHostShell({ ...desktopTurn, worksOn: "local" })).toBe(true);
    expect(mountsHostShell({ ...desktopTurn, worksOn: "browser" })).toBe(true);
  });
  it("never lends it to an engine with its own shell, off the desktop app, on Off, a remote computer, a guest or a test run", () => {
    for (const change of [{ engineHasShell: true }, { desktopApp: false }, { worksOn: "off" }, { remoteComputer: true },
      { thisComputerRefused: true }, { guest: true }, { testRun: true }]) {
      expect(mountsHostShell({ ...desktopTurn, ...change })).toBe(false);
    }
  });
  it("lends it on a server the person runs with duskbot serve, as on the desktop app", () => {
    const own = { ...desktopTurn, desktopApp: false, selfHosted: true };
    expect(mountsHostShell(own)).toBe(true);
    for (const change of [{ engineHasShell: true }, { worksOn: "off" }, { remoteComputer: true }, { guest: true }, { testRun: true }]) {
      expect(mountsHostShell({ ...own, ...change })).toBe(false);
    }
  });
  it("keeps a duskbot serve server's unsandboxed shell from routines, webhooks and messengers, and from a server others sign in to", () => {
    const own = { ...desktopTurn, desktopApp: false, selfHosted: true, platform: "linux" as const };
    expect(mountsHostShell({ ...own, watched: false })).toBe(false);
    expect(mountsHostShell({ ...own, shared: true })).toBe(false);
    expect(mountsHostShell({ ...own, shared: false })).toBe(true);
  });
  it("lends a local model the shell only from this machine, off Windows and on a turn a person is behind", () => {
    const local = { ...desktopTurn, model: "loopback" as const };
    expect(mountsHostShell(local)).toBe(true);
    for (const change of [{ model: "network" as const }, { platform: "win32" as const }, { watched: false }]) {
      expect(mountsHostShell({ ...local, ...change })).toBe(false);
    }
    expect(mountsHostShell({ ...local, guest: true })).toBe(false);
  });
  it("lends a dusk cloud home's own shell to a chat engine there, as Claude Code and Codex have theirs, but never to a guest, a test run or on Off", () => {
    const cloud = { ...desktopTurn, desktopApp: false, cloudHome: true, platform: "linux" as const };
    expect(mountsHostShell(cloud)).toBe(true);
    expect(mountsHostShell({ ...cloud, watched: false })).toBe(true);
    for (const change of [{ engineHasShell: true }, { guest: true }, { testRun: true }, { worksOn: "off" }, { remoteComputer: true }]) {
      expect(mountsHostShell({ ...cloud, ...change })).toBe(false);
    }
  });
  it("keeps a hosted engine's shell on Windows and on unattended turns", () => {
    expect(mountsHostShell({ ...desktopTurn, platform: "win32", watched: false })).toBe(true);
  });
});

describe("modelPlace", () => {
  const compat = (url: string) => ({ driverKind: "openai-compat", config: { url } });
  it("calls only a server on this machine loopback, a home network one network, and anything else hosted", () => {
    expect(modelPlace(null, compat("http://127.0.0.1:11434/v1"))).toBe("loopback");
    expect(modelPlace(null, compat("http://localhost:1234/v1"))).toBe("loopback");
    expect(modelPlace(null, compat("http://[::1]:8080/v1"))).toBe("loopback");
    expect(modelPlace(null, compat("http://192.168.1.20:11434/v1"))).toBe("network");
    expect(modelPlace(null, compat("http://studio.local:1234/v1"))).toBe("network");
    expect(modelPlace(null, compat("https://openrouter.ai/api/v1"))).toBe("hosted");
    expect(modelPlace(null, { driverKind: "codex" })).toBe("hosted");
    expect(modelPlace({ modelSelection: { model: "ollama::llama3" } }, { driverKind: "codex" })).toBe("loopback");
  });
});

describe("hostShellLaunch", () => {
  it("makes the working folder and passes it and the hidden folders in the environment, never on argv", () => {
    const folder = join(mkdtempSync(join(tmpdir(), "host-shell-")), "chat");
    const launch = hostShellLaunch(folder, ["/data"]);
    expect(existsSync(folder)).toBe(true);
    expect(launch!.args.join(" ")).not.toContain(folder);
    expect(launch!.env).toMatchObject({ DUSK_SHELL_CWD: folder, DUSK_SHELL_HIDDEN: "[\"/data\"]" });
    expect(hostShellLaunch(undefined, [])).toBeNull();
  });

  it.skipIf(process.platform === "win32")("asks the bot box to keep its working folder and the bot's own folder writable, so a boxed cloud shell can run there", () => {
    const dataDir = "/data/.duskbot", folder = join(dataDir, "workspaces", "bot-a");
    const launch = { command: "/usr/bin/node", args: [], env: {}, box: { rw: [folder], botId: "bot-a" } };
    expect(hostShellLaunch(join(mkdtempSync(join(tmpdir(), "host-shell-")), "chat"), [], "bot-a")!.box).toMatchObject({ botId: "bot-a" });
    const plan = planBox({ dataDir, home: "/data", codeRoots: ["/app"], engineRoots: [], seccompFd: 3, bridges: [] }, { ...launch, ...launch.box });
    expect(visibleInBox(plan, join(folder, "notes.txt"))).toBe("rw");
    expect(visibleInBox(plan, join(dataDir, "workspaces", "bot-b", "MEMORY.md"))).not.toBe("rw");
  });
});

describe("run_command", () => {
  const cwd = mkdtempSync(join(tmpdir(), "host-shell-"));
  it.skipIf(process.platform === "win32")("runs in the working folder and reports exit code and output", async () => {
    const ok = await runCommand({ command: "pwd; echo out; echo err 1>&2" }, { cwd });
    expect(ok.isError).toBeUndefined();
    expect(ok.text).toMatch(/^exit code 0\n--- stdout ---\n.*host-shell-.*\nout\n--- stderr ---\nerr$/s);
    const failed = await runCommand({ command: "exit 3" }, { cwd });
    expect(failed).toEqual({ text: "exit code 3\n(no output)", isError: true });
  });
  it.skipIf(process.platform === "win32")("stops a command at its limit", async () => {
    const result = await runCommand({ command: "sleep 5", timeout_seconds: 1 }, { cwd });
    expect(result).toEqual({ text: "The command was stopped: it ran past its 1-second limit.", isError: true });
  });
  it("keeps dusk bot's variables and API keys out of the command's environment", async () => {
    let seen: NodeJS.ProcessEnv = {};
    const run: Runner = async (_file, _args, options) => { seen = options.env; return { code: 0, stdout: "", stderr: "", timedOut: false }; };
    await runCommand({ command: "env" }, { cwd, env: { PATH: "/bin", DUSK_MCP_TOKEN_DATA: "x", OPENAI_COMPAT_API_KEY: "k", ELECTRON_RUN_AS_NODE: "1" }, run });
    expect(seen).toEqual({ PATH: "/bin" });
    expect(commandEnvironment({ dusk_cloud_x: "1", HOME: "/h" })).toEqual({ HOME: "/h" });
  });
  it("runs PowerShell on Windows", async () => {
    let call: string[] = [];
    const run: Runner = async (file, args) => { call = [file, ...args]; return { code: 0, stdout: "hi", stderr: "", timedOut: false }; };
    await runCommand({ command: "Get-ChildItem" }, { cwd, platform: "win32", env: {}, run });
    expect(call[0]).toBe("powershell.exe");
    expect(call.at(-1)).toBe("Get-ChildItem");
  });
  it("refuses an empty command", async () => {
    expect(await runCommand({ command: "  " }, { cwd })).toEqual({ text: "command is required.", isError: true });
  });
});

describe("find_files", () => {
  it("asks Spotlight on macOS first, by name or by content, inside a folder", () => {
    expect(findInvocations("invoice", { content: false, limit: 50, platform: "darwin", home: "/Users/a" })[0]).toEqual({ file: "mdfind", args: ["-name", "invoice"], index: true });
    expect(findInvocations("invoice", { content: true, folder: "/Users/a/Documents", limit: 50, platform: "darwin", home: "/Users/a" })[0])
      .toEqual({ file: "mdfind", args: ["-onlyin", "/Users/a/Documents", "invoice"], index: true });
  });
  it("walks the home folder when Spotlight finds nothing, with iCloud Drive and every word of the name", async () => {
    const home = mkdtempSync(join(tmpdir(), "find-home-"));
    const put = (path: string, body: string) => { mkdirSync(dirname(join(home, path)), { recursive: true }); writeFileSync(join(home, path), body); };
    put("Desktop/old stuff/scans 2024/IMG_4471 halyard paddle club card.txt", "member no. HPC-20417");
    put("Library/Mobile Documents/com~apple~CloudDocs/Trips/oct-weekend.md", "host is Marguerite Oyelaran, Quillmoor cabin");
    put("Library/Caches/halyard club card.txt", "cache");
    put(".hidden/halyard club card.txt", "hidden");
    const calls: string[] = [];
    const run: Runner = async (file, args, options) => {
      calls.push(file);
      return file === "mdfind" ? { code: 0, stdout: "", stderr: "", timedOut: false } : runProcess(file, args, options);
    };
    const byName = await findFiles({ query: "club halyard card" }, { platform: "darwin", home, env: process.env, run });
    expect(calls).toEqual(["mdfind", "find"]);
    expect(byName).toEqual({ text: join(home, "Desktop/old stuff/scans 2024/IMG_4471 halyard paddle club card.txt") });
    const byContent = await findFiles({ query: "quillmoor cabin", in_content: true }, { platform: "darwin", home, env: process.env, run });
    expect(byContent).toEqual({ text: join(home, "Library/Mobile Documents/com~apple~CloudDocs/Trips/oct-weekend.md") });
    const linux = await findFiles({ query: "paddle" }, { platform: "linux", home, env: process.env, run: async (file, args, options) => (file === "locate" ? { code: 0, stdout: "", stderr: "", timedOut: false } : runProcess(file, args, options)) });
    expect(linux.text).toContain("IMG_4471 halyard paddle club card.txt");
    rmSync(home, { recursive: true, force: true });
  });
  it("asks Windows Search with the query in the environment, then where.exe", () => {
    const [search, where] = findInvocations("it's 50%", { content: false, limit: 20, platform: "win32", home: "C:\\Users\\a" });
    expect(search!.file).toBe("powershell.exe");
    expect(search!.args.join(" ")).not.toContain("it's");
    expect(search!.env).toEqual({ FIND_QUERY: "it's 50%", FIND_CONTENT: "0", FIND_FOLDER: "", FIND_LIMIT: "20" });
    expect(where).toEqual({ file: "where.exe", args: ["/r", "C:\\Users\\a", "*it's 50%*"] });
  });
  it("lists matches without dusk bot's own folders, and says when nothing matched", async () => {
    const run: Runner = async () => ({ code: 0, stdout: "/Users/a/Documents/invoice.pdf\n/Users/a/Library/Application Support/dusk/x/invoice.json\n", stderr: "", timedOut: false });
    const found = await findFiles({ query: "invoice" }, { platform: "darwin", home: "/Users/a", hidden: ["/Users/a/Library/Application Support/dusk"], env: {}, run });
    expect(found).toEqual({ text: "/Users/a/Documents/invoice.pdf" });
    const none = await findFiles({ query: "zzz" }, { platform: "darwin", home: "/Users/a", env: {}, run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) });
    expect(none.text).toMatch(/^No files matched "zzz"\./);
  });
  it("falls back to where.exe when Windows Search cannot run", async () => {
    const calls: string[] = [];
    const run: Runner = async (file) => {
      calls.push(file);
      return file === "powershell.exe" ? { code: 1, stdout: "", stderr: "no index", timedOut: false } : { code: 0, stdout: "C:\\Users\\a\\cv.docx\r\n", stderr: "", timedOut: false };
    };
    const found = await findFiles({ query: "cv" }, { platform: "win32", home: "C:\\Users\\a", env: {}, run });
    expect(calls).toEqual(["powershell.exe", "where.exe"]);
    expect(found).toEqual({ text: "C:\\Users\\a\\cv.docx" });
  });
  it("refuses a folder that is not a full path", async () => {
    expect(await findFiles({ query: "x", folder: "Documents" }, { platform: "darwin", home: "/Users/a", env: {} }))
      .toEqual({ text: "folder must be a full path or start with ~.", isError: true });
  });
});

describe("the MCP server", () => {
  it("lists its two tools and answers calls", async () => {
    const options = { cwd: tmpdir(), hidden: [], run: (async () => ({ code: 0, stdout: "/a/b.txt\n", stderr: "", timedOut: false })) as Runner, platform: "darwin" as const, env: {} };
    const listed = await handleHostShellRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, options);
    expect((listed!.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual(["run_command", "find_files"]);
    const called = await handleHostShellRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "find_files", arguments: { query: "b" } } }, options);
    expect(called).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "/a/b.txt" }] } });
    expect(await handleHostShellRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, options)).toBeUndefined();
  });
});
