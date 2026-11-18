import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { writeFileAtomic } from "./atomic.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

interface ChatRequest {
  tools?: Array<{ function: { name: string } }>;
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ASK = "Say which folder you are working in.";
const COMMAND = "echo dusk-shell-$((20+22))";
const DRIVER = `#!/usr/bin/env node
import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture-driver", version: "1" } });
  else if (message.method === "tools/list") reply(message.id, { tools: [{ name: "click", description: "Click", inputSchema: { type: "object", properties: {} } }] });
  else reply(message.id, { content: [{ type: "text", text: "clicked" }] });
});
`;

describe.skipIf(process.platform !== "darwin")("a local model's shell, through the server the desktop app launched", () => {
  let home = "";
  let data = "";
  let output = "";
  let base = "";
  let child: ChildProcess | null = null;
  let provider: Server;
  let providerUrl = "";
  const turns: ChatRequest[] = [];

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json", origin: base },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBeLessThan(400);
    return result;
  };
  async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
    const end = Date.now() + 30_000;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${output.slice(-4_000)}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const idle = (botId: string, threadId: string) => until(
    () => api("GET", "/api/bots?messages=0").then((body) => body.bots.find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId)),
    (task) => Boolean(task) && !task.busy,
  );

  async function start(desktop: boolean) {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    const hooks = ["--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href,
      ...(desktop ? ["--import", pathToFileURL(join(ROOT, "server/testing/desktop-parent.mjs")).href] : [])];
    const proc = spawn(process.execPath, [...hooks, join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home, USERPROFILE: home, DUSK_DATA_DIR: data, TEMP: home, TMP: home, TMPDIR: home,
        DUSK_PORT: String(port), DUSK_WEBHOOK_PORT: String(port + 1), DUSK_STATIC_DIR: join(home, "static"), DUSK_TEST_VM_STATE: join(home, "vm.json"),
        DUSK_USER_DATA: join(home, "user-data"), DUSK_NO_TEST_BOTS: "1",
        ...(desktop ? { DUSK_TEST_DESKTOP_CUA_CONNECTION: join(home, "user-data", "cua-connection.json") } : {}),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", (chunk) => { output += chunk; });
    proc.stderr!.on("data", (chunk) => { output += chunk; });
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, Boolean);
    await api("PATCH", "/api/config", { openaiCompat: { key: "synthetic-fixture-key", url: providerUrl, model: "fixture-model" } });
    await api("POST", "/api/instances/openaiCompat/refresh-models", {});
  }

  async function localModelBot(name: string, place: "local" | undefined) {
    const { bot } = await api("POST", "/api/bots", { name });
    const modelSelection = { instanceId: "openaiCompat", model: "fixture-model" };
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection, approvalMode: "ask" });
    const { task } = await api("POST", `/api/bots/${bot.id}/tasks`, {});
    await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { modelSelection, ...(place ? { surface: place } : {}) });
    return { botId: bot.id as string, threadId: task.threadId as string };
  }

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "dusk-host-shell-e2e-")));
    data = join(home, "data");
    mkdirSync(data);
    mkdirSync(join(home, "static", "assets"), { recursive: true });
    writeFileSync(join(home, "static", "index.html"), "<title>Host shell</title>");
    writeFileSync(join(home, "static", "assets", "test.css"), "body{}");
    writeFileAtomic(join(home, "vm.json"), JSON.stringify({ noContainers: true }));
    const driver = join(home, "fixture-driver.mjs");
    writeFileSync(driver, DRIVER, { mode: 0o755 });
    mkdirSync(join(home, "user-data"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "user-data", "cua-connection.json"), JSON.stringify({
      mode: "embedded", status: "ready", socketPath: join(home, "cua.sock"), mcpCommand: driver, mcpArgs: ["mcp"], mcpEnv: {},
    }), { mode: 0o600 });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {} }));
    provider = createServer(async (request, response) => {
      if (request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
        return;
      }
      if (request.method !== "POST") { response.writeHead(404); response.end(); return; }
      let body = "";
      for await (const chunk of request) body += chunk;
      const turn = JSON.parse(body) as ChatRequest;
      const frame = (delta: unknown, finish: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (turn.messages[0]?.role !== "system" || !turn.messages.some((message) => message.role === "user" && String(message.content).includes(ASK))) return response.end(frame({ content: "SKIP" }, "stop"));
      turns.push(turn);
      const shell = turn.tools?.some((tool) => tool.function.name === "shell_run_command");
      if (!shell || turn.messages.some((message) => message.role === "tool")) return response.end(frame({ content: "Done." }, "stop"));
      response.end(frame({ content: null, tool_calls: [{ index: 0, id: "call_shell", type: "function",
        function: { name: "shell_run_command", arguments: JSON.stringify({ command: COMMAND }) } }] }, "tool_calls"));
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("fixture provider address missing");
    providerUrl = `http://127.0.0.1:${address.port}/v1`;
  });
  afterEach(async () => {
    turns.length = 0;
    if (!child) return;
    const proc = child;
    child = null;
    await waitForExit(proc, { signal: "SIGTERM" });
  });
  afterAll(async () => {
    provider?.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    if (home) await removeTempDir(home);
  });

  it("lists the shell beside this computer, asks before the command, then runs it and hands the output back", async () => {
    await start(true);
    const { botId, threadId } = await localModelBot("Shell Bot", "local");
    await api("POST", `/api/bots/${botId}/messages`, { text: ASK, threadId });
    await until(() => turns.length, (count) => count >= 1);
    expect(turns[0]!.tools!.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(["shell_run_command", "computer_click"]));

    const card = await until<any>(async () => (await messages(threadId)).find((message) => message.card?.requestId && !message.card.answered)?.card, Boolean);
    expect(JSON.stringify(card)).toContain("dusk-shell-$((20+22))");
    expect(turns).toHaveLength(1);
    await api("POST", `/api/bots/${botId}/respond`, { threadId, requestId: card.requestId, behavior: "allow" });

    await until(() => turns.length, (count) => count >= 2);
    const handedBack = turns[1]!.messages.find((message) => message.role === "tool" && message.tool_call_id === "call_shell");
    expect(String(handedBack?.content)).toContain("exit code 0\\ndusk-shell-42");
    await idle(botId, threadId);
    const steps = (await messages(threadId)).filter((message) => message.kind === "activity").map((message) => message.tool);
    expect(steps).toContainEqual(expect.objectContaining({ name: "shell_run_command", ok: true }));
  }, 90_000);

  it("lists no shell on a server the desktop app did not launch", async () => {
    await start(false);
    const { botId, threadId } = await localModelBot("Second Server Shell Bot", undefined);
    await api("POST", `/api/bots/${botId}/messages`, { text: ASK, threadId });
    await until(() => turns.length, (count) => count >= 1);
    const names = (turns[0]!.tools ?? []).map((tool) => tool.function.name);
    expect(names).not.toContain("shell_run_command");
    expect(names.filter((name) => name.startsWith("computer_"))).toEqual([]);
    await idle(botId, threadId);
  }, 90_000);
});
