// A chat-completions turn never ends silently: empty, cut or tool-only replies get one nudged retry, then a plain failure.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { failedReplyReason } from "../failed-reply-reason.ts";
import { failureOf } from "../../shared/usage-signals.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "../testing/fake-http-mcp-server.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { unfinishedReply } from "./openai-chat-final.ts";

afterEach(() => vi.unstubAllGlobals());

const frame = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const done = "data: [DONE]\n\n";
const say = (text: string) => frame({ role: "assistant", content: text }) + frame({}, "stop") + done;
const EMPTY = frame({ role: "assistant", content: "" }) + frame({}, "stop") + done;

interface Sent { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }

/** one turn against a fake OpenAI-compatible server answering each chat completion with the next body */
async function turn(bodies: string[], extra: Partial<SendTurnInput> = {}) {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (!String(url).endsWith("/chat/completions")) return new Response(JSON.stringify({ data: [] }));
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(bodies[Math.min(sent.length - 1, bodies.length - 1)], { headers: { "content-type": "text/event-stream" } });
  }));
  const instance = await OpenAICompatDriver.create({
    instanceId: "api", displayName: "API", enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: "https://api.example.test/v1", apiKeyEnv: "K", model: "fixture" }),
    environment: { K: "synthetic" },
  });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  try {
    await instance.adapter.sendTurn({ threadId: "t", text: "hi", approvalMode: "full", ...extra });
    await vi.waitFor(() => expect(events.some((event) => event.type === "turn.completed")).toBe(true), { timeout: 15_000 });
  } finally {
    await instance.dispose();
  }
  const of = <T extends RuntimeEvent["type"]>(type: T) => events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);
  return {
    sent,
    replies: of("item.completed").filter((event) => event.itemType === "assistant_text").map((event) => (event as { text?: string }).text),
    errors: of("runtime.error"),
    retries: of("turn.retrying"),
    completed: of("turn.completed")[0]!,
  };
}

const lastUser = (request: Sent) => request.messages.filter((message) => message.role === "user").at(-1)?.content;

describe("a reply carried only as reasoning", () => {
  it.each(["reasoning_content", "reasoning"])("shows %s as the reply when content is empty", async (field) => {
    const run = await turn([frame({ role: "assistant", content: "", [field]: "Hello! How can I help today?" }) + frame({}, "stop") + done]);
    expect(run.replies).toEqual(["Hello! How can I help today?"]);
    expect(run.errors).toEqual([]);
    expect(run.completed).toMatchObject({ ok: true });
    expect(run.sent).toHaveLength(1);
  });
});

describe("an empty reply", () => {
  it("asks once more with a nudge and shows the second answer", async () => {
    const run = await turn([EMPTY, say("Hi! What can I do for you?")]);
    expect(run.sent).toHaveLength(2);
    expect(String(lastUser(run.sent[1]!))).toMatch(/came back empty/);
    expect(run.retries).toMatchObject([{ reason: "empty_reply" }]);
    expect(run.replies).toEqual(["Hi! What can I do for you?"]);
    expect(run.completed).toMatchObject({ ok: true });
  });

  it.each([
    ["only whitespace", frame({ role: "assistant", content: "\n\n  " }) + frame({}, "stop") + done],
    ["a role frame and [DONE]", frame({ role: "assistant" }) + done],
  ])("counts %s as empty", async (_name, body) => {
    const run = await turn([body, say("Here.")]);
    expect(run.replies).toEqual(["Here."]);
    expect(run.completed).toMatchObject({ ok: true });
  });

  it("ends with a plain failure the app and usage can read when the retry is empty too", async () => {
    const run = await turn([EMPTY]);
    expect(run.sent).toHaveLength(2);
    expect(run.replies).toEqual([]);
    expect(run.errors).toHaveLength(1);
    expect(run.errors[0]).toMatchObject({ terminal: true, errorCode: "no_reply:empty_reply" });
    expect(run.errors[0]!.message).toMatch(/^The model sent back an empty reply/);
    expect(failureOf(run.errors[0]!.message, { code: run.errors[0]!.errorCode })).toEqual({ reason: "no_reply", detail: "empty_reply" });
    expect(run.completed).toMatchObject({ ok: false, stopReason: "error" });
  });
});

describe("a stream that ends without finishing", () => {
  it("asks once more when nothing was shown", async () => {
    const run = await turn([frame({ role: "assistant", content: "" }), say("Back again.")]);
    expect(run.sent).toHaveLength(2);
    expect(run.replies).toEqual(["Back again."]);
    expect(run.completed).toMatchObject({ ok: true });
  });

  it("names the cut when it happens twice", async () => {
    const run = await turn([frame({ role: "assistant", content: "" })]);
    expect(run.sent).toHaveLength(2);
    expect(run.errors[0]).toMatchObject({ errorCode: "stream_cut" });
    expect(run.errors[0]!.message).toMatch(/stream closed before it finished/);
    expect(failureOf(run.errors[0]!.message, { code: run.errors[0]!.errorCode })).toMatchObject({ detail: "stream_cut" });
  });

  it("never asks again once answer text was shown, so nothing is said twice", async () => {
    const run = await turn([frame({ role: "assistant", content: "Half an ans" }), say("never sent")]);
    expect(run.sent).toHaveLength(1);
    expect(run.errors[0]).toMatchObject({ errorCode: "stream_cut" });
  });
});

describe("a finish reason that is not stop", () => {
  it("says the output allowance ran out, without retrying, when finish_reason is length and nothing came", async () => {
    const run = await turn([frame({ role: "assistant", content: "" }) + frame({}, "length") + done]);
    expect(run.sent).toHaveLength(1);
    expect(run.errors[0]).toMatchObject({ errorCode: "finish_length" });
    expect(run.errors[0]!.message).toMatch(/finish_reason: length/);
    expect(failedReplyReason(run.errors[0]!.message, { errorCode: run.errors[0]!.errorCode })).toBeUndefined();
  });

  it("keeps a cut reply on screen and says it was cut", async () => {
    const run = await turn([frame({ role: "assistant", content: "Part one" }) + frame({}, "length") + done]);
    expect(run.replies).toEqual(["Part one"]);
    expect(run.errors[0]).toMatchObject({ errorCode: "finish_length" });
  });

  it("says a content filter blocked it", async () => {
    const run = await turn([frame({ role: "assistant", content: "" }) + frame({}, "content_filter") + done]);
    expect(run.sent).toHaveLength(1);
    expect(run.errors[0]!.message).toMatch(/content filter blocked/);
    expect(failureOf(run.errors[0]!.message, { code: run.errors[0]!.errorCode }).reason).toBe("refused");
  });

  it("words any other finish reason with its token only", () => {
    expect(unfinishedReply("text", "stop")).toBeNull();
    expect(unfinishedReply("text", null)).toBeNull();
    expect(unfinishedReply("text", "error")).toMatchObject({ code: "finish_error" });
    expect(unfinishedReply("text", "Weird <b>")).toMatchObject({ code: "finish_other" });
  });
});

describe("a broken or tool-only final round", () => {
  let mcp: FakeHttpMcp | undefined;
  afterEach(async () => { await mcp?.close(); mcp = undefined; });

  const call = (id: string, name: string, args = "{}") => frame({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] }) + frame({}, "tool_calls") + done;

  it("nudges an empty reply after a tool ran, and the answer comes", async () => {
    mcp = await startFakeHttpMcp({ tools: [{ name: "lookup", inputSchema: { type: "object", properties: {} } }] });
    const run = await turn([call("c1", "fixture_lookup"), EMPTY, say("Found it.")], { integrations: { custom: { fixture: { type: "http", url: mcp.url, headers: {} } } } });
    const toolName = (run.sent[0]!.tools as Array<{ function: { name: string } }> | undefined)?.map((tool) => tool.function.name);
    expect(toolName).toContain("fixture_lookup");
    expect(run.sent).toHaveLength(3);
    expect(run.sent[2]!.messages.at(-1)).toMatchObject({ role: "user" });
    expect(String(lastUser(run.sent[2]!))).toMatch(/^Your tools have finished and you wrote no reply\. Without calling another tool, write your final answer now/);
    expect(String(lastUser(run.sent[2]!))).not.toMatch(/A step failed/);
    expect(run.replies).toEqual(["Found it."]);
    expect(run.completed).toMatchObject({ ok: true });
  });

  it("asks for the failure in plain words when a tool failed before the empty reply", async () => {
    mcp = await startFakeHttpMcp({ tools: [{ name: "lookup", inputSchema: { type: "object", properties: {} } }] });
    const run = await turn([call("c1", "fixture_missing"), EMPTY, say("The lookup failed, so nothing was found.")], { integrations: { custom: { fixture: { type: "http", url: mcp.url, headers: {} } } } });
    expect(String(lastUser(run.sent.at(-1)!))).toMatch(/A step failed: say plainly what failed/);
    expect(run.replies.at(-1)).toBe("The lookup failed, so nothing was found.");
  });

  it("asks once more after a tool call with no id, which ran nothing", async () => {
    const broken = frame({ role: "assistant", tool_calls: [{ index: 0, type: "function", function: { name: "lookup", arguments: "{}" } }] }) + frame({}, "tool_calls") + done;
    const run = await turn([broken, say("Plain answer.")]);
    expect(run.sent).toHaveLength(2);
    expect(run.replies).toEqual(["Plain answer."]);
  });

  it("words a broken tool call twice for the person", async () => {
    const broken = frame({ role: "assistant", tool_calls: [{ index: 0, type: "function", function: { name: "lookup", arguments: "{}" } }] }) + frame({}, "tool_calls") + done;
    const run = await turn([broken]);
    expect(run.sent).toHaveLength(2);
    expect(run.errors[0]).toMatchObject({ errorCode: "tool_call_malformed" });
    expect(run.errors[0]!.message).toMatch(/^The model sent a broken tool call/);
  });
});
