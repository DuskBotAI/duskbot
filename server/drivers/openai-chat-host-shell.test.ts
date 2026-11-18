import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { flushDecisionLog, readDecisions } from "../decision-log.ts";
import { hostShellEnvironment, hostShellLaunch } from "../host-shell.ts";
import { offerHostShell } from "../local-computer.ts";
import { bindSafetyFloor } from "../safety-floor-gate.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { CerebrasDriver } from "./cerebras.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

interface ChatRequest {
  tools?: Array<{ function: { name: string } }>;
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
}

const WIPE = "rm -rf /";
const BLOCKED = "Blocked by the safety floor: recursive delete of the filesystem root";
const DESKTOP = `
import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
  else if (message.method === "tools/list") reply(message.id, { tools: [{ name: "click", description: "Click", inputSchema: { type: "object", properties: {} } }] });
  else reply(message.id, { content: [{ type: "text", text: "clicked" }] });
});
`;
const RECORDING_SHELL = `#!/bin/sh
printf '%s\\n' "$3" >> "$HOST_SHELL_HANDED"
echo "Recorded, not run."
`;

const cleanups: Array<() => Promise<void>> = [];
let ownShell: string | undefined;

beforeEach(() => {
  ownShell = process.env.SHELL;
  delete process.env.DUSK_SAFETY_FLOOR;
});
afterEach(async () => {
  bindSafetyFloor(() => ({}));
  if (ownShell === undefined) delete process.env.SHELL; else process.env.SHELL = ownShell;
  delete process.env.HOST_SHELL_HANDED;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sse(response: ServerResponse, delta: unknown, finishReason: string) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function fixture(commands: string[], engine: "local model" | "api key" = "local model") {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dusk-chat-shell-")));
  const requests: ChatRequest[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end('{"data":[]}');
      return;
    }
    let data = "";
    if (request.method !== "POST") { response.writeHead(404); response.end(); return; }
    for await (const part of request) data += part.toString();
    requests.push(JSON.parse(data) as ChatRequest);
    const command = commands[requests.length - 1];
    if (command === undefined) return sse(response, { content: "Done." }, "stop");
    sse(response, { content: null, tool_calls: [{
      index: 0, id: `call_${requests.length}`, type: "function",
      function: { name: "shell_run_command", arguments: JSON.stringify({ command }) },
    }] }, "tool_calls");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  const desktop = join(directory, "desktop.mjs");
  writeFileSync(desktop, DESKTOP);
  const shell = join(directory, "recording-shell");
  writeFileSync(shell, RECORDING_SHELL);
  chmodSync(shell, 0o755);
  const handedFile = join(directory, "handed.txt");
  process.env.SHELL = shell;
  process.env.HOST_SHELL_HANDED = handedFile;
  if (hostShellLaunch(WIPE, process.platform, hostShellEnvironment()).command !== shell) throw new Error("the recording shell is not the one commands would run in");
  const common = { instanceId: randomUUID(), displayName: "Shell fixture", enabled: true };
  const url = `http://127.0.0.1:${address.port}/v1`;
  const instance: ProviderInstance = engine === "api key"
    ? await CerebrasDriver.create({ ...common, config: CerebrasDriver.decodeConfig({ url }), environment: { CEREBRAS_API_KEY: "fixture-credential-9c2e4a17" } })
    : await OpenAICompatDriver.create({ ...common, config: { url, apiKeyEnv: "FIXTURE_CHAT_KEY" }, environment: { FIXTURE_CHAT_KEY: "fixture-credential-9c2e4a17" } });
  const recorder = recordEvents(instance.adapter);
  const threadId = randomUUID();
  const integrations: NonNullable<SendTurnInput["integrations"]> = {
    localComputer: { command: process.execPath, args: [desktop], env: {}, scope: "local-computer" },
  };
  offerHostShell(integrations, instance.adapter.capabilities, { guestConfined: false, cwd: directory });
  cleanups.push(async () => {
    recorder.stop();
    await instance.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(directory);
  });
  return {
    instance, recorder, requests, threadId, integrations,
    handed: (): string[] => existsSync(handedFile) ? readFileSync(handedFile, "utf8").trim().split("\n") : [],
    start: (input: Partial<SendTurnInput> = {}) => instance.adapter.sendTurn({
      threadId, botId: "bot-shell", text: "Check the repo.", model: "fixture-model", integrations, ...input,
    }),
    completed: () => recorder.until((event) => event.type === "turn.completed"),
    cards: () => recorder.events.filter((event) => event.type === "request.opened"),
    notices: () => recorder.events.flatMap((event) => event.type === "runtime.notice" ? [event.message] : []),
    listed: () => (requests[0]?.tools ?? []).map((tool) => tool.function.name),
    toolResult: (callId: string) => requests.at(-1)!.messages.filter((message) => message.role === "tool" && message.tool_call_id === callId).map((message) => String(message.content)),
    decisions: async () => {
      await flushDecisionLog(DATA_DIR);
      return readDecisions(DATA_DIR, 500).filter((row) => row.threadId === threadId);
    },
  };
}

describe.skipIf(process.platform === "win32")("a local model's own shell on this computer", () => {
  it("is offered to a model on this machine and not to an API-key model working on the same computer", async () => {
    const local = await fixture([]);
    expect(local.instance.adapter.capabilities.hostShellMcp).toBe(true);
    expect(local.integrations.hostShell).toBeDefined();
    await local.start({ approvalMode: "ask" });
    expect(await local.completed()).toMatchObject({ ok: true });
    expect(local.listed()).toEqual(expect.arrayContaining(["shell_run_command", "computer_click"]));

    const hosted = await fixture([], "api key");
    expect(hosted.instance.adapter.capabilities.hostShellMcp).not.toBe(true);
    expect(hosted.integrations.hostShell).toBeUndefined();
    await hosted.start({ approvalMode: "ask" });
    expect(await hosted.completed()).toMatchObject({ ok: true });
    expect(hosted.listed()).toContain("computer_click");
    expect(hosted.listed()).not.toContain("shell_run_command");
  });

  it("is not mounted by an API-key model's runtime even when a turn carries it", async () => {
    const f = await fixture([], "api key");
    await f.start({ approvalMode: "ask", integrations: { ...f.integrations, hostShell: {} } });
    expect(await f.completed()).toMatchObject({ ok: true });
    expect(f.listed()).toContain("computer_click");
    expect(f.listed()).not.toContain("shell_run_command");
  });

  it("shows the command on a card and runs nothing when the person says no", async () => {
    const f = await fixture(["git status"]);
    await f.start({ approvalMode: "ask" });
    const card = await f.recorder.until((event) => event.type === "request.opened");
    expect(card).toMatchObject({ requestType: "permission", tool: "shell_run_command", allowSession: true, summary: expect.stringContaining("git status") });
    expect(f.handed()).toEqual([]);
    expect(await f.instance.adapter.respondToRequest(f.threadId, card.requestId!, { behavior: "deny" })).toBe("rejected");
    expect(await f.completed()).toMatchObject({ denials: ["shell_run_command"] });
    expect(f.handed()).toEqual([]);
    expect(f.toolResult("call_1")).toEqual([expect.stringContaining("Permission denied")]);
  });

  it("runs the command once allowed, as a command step with its exit code and output", async () => {
    const f = await fixture(["git status"]);
    await f.start({ approvalMode: "ask" });
    const card = await f.recorder.until((event) => event.type === "request.opened");
    expect(await f.instance.adapter.respondToRequest(f.threadId, card.requestId!, { behavior: "allow" })).toBe("allowed-once");
    expect(await f.completed()).toMatchObject({ ok: true });
    expect(f.handed()).toEqual(["git status"]);
    expect(f.toolResult("call_1")).toEqual([expect.stringContaining("exit code 0\\nRecorded, not run.")]);
    expect(f.recorder.events).toContainEqual(expect.objectContaining({ type: "item.started", itemType: "tool", itemId: "call_1", title: "shell_run_command", input: expect.stringContaining("git status") }));
    expect(f.recorder.events).toContainEqual(expect.objectContaining({ type: "item.completed", itemType: "tool", itemId: "call_1", ok: true }));
  });

  it("keeps an \"Always allow this session\" to the exact command: another command asks again", async () => {
    const f = await fixture(["git status", "git status", "git push"]);
    await f.start({ approvalMode: "ask" });
    const first = await f.recorder.until((event) => event.type === "request.opened");
    await f.instance.adapter.respondToRequest(f.threadId, first.requestId!, { behavior: "allow", always: true });
    const second = await f.recorder.until((event) => event.type === "request.opened" && event.requestId !== first.requestId);
    expect(second).toMatchObject({ tool: "shell_run_command", summary: expect.stringContaining("git push") });
    expect(f.handed()).toEqual(["git status", "git status"]);
    await f.instance.adapter.respondToRequest(f.threadId, second.requestId!, { behavior: "deny" });
    await f.completed();
    expect(f.cards()).toHaveLength(2);
    expect(f.handed()).toEqual(["git status", "git status"]);
  });

  it("at Full access runs without a card, except what the safety floor never allows", async () => {
    bindSafetyFloor(() => ({ safetyFloor: { enabled: true } }), undefined, "linux");
    const f = await fixture(["ls -la", WIPE]);
    await f.start({ approvalMode: "full" });
    expect(await f.completed()).toMatchObject({ ok: false, denials: ["shell_run_command"] });
    expect(f.cards()).toEqual([]);
    expect(f.handed()).toEqual(["ls -la"]);
    expect(f.notices()).toEqual([BLOCKED]);
    expect(f.toolResult("call_2")).toEqual([expect.stringContaining(BLOCKED)]);
    expect(await f.decisions()).toEqual([
      expect.objectContaining({ botId: "bot-shell", tool: "shell_run_command", decision: "auto-denied", source: "safety-floor", rule: "delete-root" }),
    ]);
  });

  it("holds a kept session allow to the safety floor too", async () => {
    bindSafetyFloor(() => ({ safetyFloor: { enabled: true } }), undefined, "linux");
    const f = await fixture([WIPE, WIPE]);
    await f.start({ approvalMode: "ask" });
    const card = await f.recorder.until((event) => event.type === "request.opened");
    await f.instance.adapter.respondToRequest(f.threadId, card.requestId!, { behavior: "allow", always: true });
    await f.completed();
    expect(f.cards()).toHaveLength(1);
    expect(f.handed()).toEqual([WIPE]);
    expect(f.notices()).toEqual([BLOCKED]);
  });
});
