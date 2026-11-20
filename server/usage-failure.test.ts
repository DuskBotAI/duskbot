// real-shaped failures per engine, as each driver emits them in runtime.error, read into a usage reason and a detail
import { describe, expect, it } from "vitest";
import { FAILURE_DETAIL, cleanUsageTurn, cliExitCode, failureOf, modelFamily, opencodeProvider, rpcCode } from "../shared/usage-signals.ts";
import { codexErrorCode } from "./drivers/codex-errors.ts";
import { engineFailureMessage } from "./drivers/engine-errors.ts";
import { exitDetail } from "./drivers/acp/exit-report.ts";
import { describeSpawnFailure } from "./procs.ts";
import { serverLine } from "./server-lines.ts";
import { turnRecord } from "./usage-signals.ts";
import { runnerActions } from "../shared/usage-trace.ts";

const NOW = Date.UTC(2026, 10, 17, 12);
const SECRET = "Email jane.doe@acme.com the Q3 numbers from /Users/jane/Secret Plan.xlsx at https://acme.com/x sk-live-abcdefghijklmnop";

describe("the api engine (openai-chat: \"<label> HTTP <status>: <provider message> (<code>)\")", () => {
  it.each([
    ["upstream HTTP 401: Authentication Fails, Your api key: ****abcd is invalid (authentication_error)", "auth", "http_401:authentication_error"],
    ["upstream HTTP 402: Insufficient Balance", "quota", "http_402"],
    ["upstream HTTP 429: You exceeded your current quota, please check your plan and billing details. (insufficient_quota)", "quota", "http_429:insufficient_quota"],
    ["upstream HTTP 429: Rate limit exceeded: free-models-per-day. (rate_limit_exceeded)", "rate_limit", "http_429:rate_limit_exceeded"],
    ["upstream HTTP 400: Model Not Exist", "model_not_found", "http_400"],
    ["upstream HTTP 404: No endpoints found for deepseek/deepseek-r1:free.", "model_not_found", "http_404"],
    ["upstream HTTP 400: This model's maximum context length is 131072 tokens. However, you requested 140000 tokens. (context_length_exceeded)", "context", "http_400:context_length_exceeded"],
    ["upstream HTTP 400: Invalid 'messages[3].content': string too long (invalid_request_error)", "bad_request", "http_400:invalid_request_error"],
    ["upstream HTTP 422: Unprocessable Entity", "bad_request", "http_422"],
    ["upstream HTTP 429: 余额不足或无可用资源包,请充值。", "quota", "http_429"],
    ["upstream HTTP 400: 模型不存在，请检查模型代码。", "model_not_found", "http_400"],
    ["upstream HTTP 503: upstream connect error or disconnect/reset before headers", "provider_down", "http_503"],
    ["upstream HTTP 500: {\"error\":{\"message\":\"Internal error\",\"type\":\"server_error\"}}", "provider_down", "http_500:server_error"],
    ["TypeError: fetch failed", "network", "TypeError"],
    ["connect ECONNREFUSED 127.0.0.1:11434", "network", "econnrefused"],
    ["terminated", "network", undefined],
    ["Streaming idle timeout elapsed", "timeout", undefined],
    ["provider returned no completion message", "no_reply", undefined],
  ])("%s", (text, reason, detail) => {
    expect(failureOf(text)).toEqual({ reason, ...(detail ? { detail } : {}) });
  });

  it("reads engine-errors' plain sentences the same way", () => {
    expect(failureOf(engineFailureMessage("DeepSeek", "DeepSeek HTTP 503: Service Unavailable")!)).toEqual({ reason: "provider_down", detail: "http_503" });
    expect(failureOf(engineFailureMessage("GLM", "GLM HTTP 529: Overloaded")!)).toEqual({ reason: "provider_down", detail: "http_529" });
    expect(failureOf(engineFailureMessage("OpenRouter", "fetch failed")!).reason).toBe("network");
    expect(failureOf(engineFailureMessage("Kimi", "Kimi HTTP 400: tools.function.parameters is not a valid moonshot flavored json schema")!).reason).toBe("bad_request");
  });
});

describe("opencode (ACP)", () => {
  it("reads the free backup's lines by their code, in any language", () => {
    expect(failureOf(serverLine(undefined, "server.freeModel.noReply"), { code: "free_timeout" })).toEqual({ reason: "timeout", detail: "free_timeout" });
    expect(failureOf(serverLine("de", "server.freeModel.limit"), { code: "free_pool_limit" })).toEqual({ reason: "quota", detail: "free_pool_limit" });
    expect(failureOf(serverLine("ja", "server.freeModel.noReply"), { code: "free_busy" }).reason).toBe("provider_down");
    expect(failureOf(serverLine(undefined, "server.freeModel.noReply")).reason).toBe("no_reply");
  });

  it("reads its JSON-RPC errors with the provider code and error class", () => {
    expect(failureOf("Internal error: Invalid API key. (session/prompt, service: session, APIError)", { code: "invalid_credentials" }))
      .toEqual({ reason: "auth", detail: "invalid_credentials:APIError" });
    expect(failureOf("Internal error: Model not found: anthropic/claude-opus-9 (session/prompt, service: session, ProviderModelNotFoundError)", { code: "ProviderModelNotFoundError" }))
      .toEqual({ reason: "model_not_found", detail: "ProviderModelNotFoundError" });
    expect(failureOf(engineFailureMessage("OpenCode", "Internal error: API error (status 400 Bad Request): prompt is too long: 210000 tokens > 200000 maximum (session/prompt, service: session, APIError)")!, { code: "APIError" }))
      .toEqual({ reason: "context", detail: "APIError:http_400" });
  });

  it("reads an exit before the prompt result as an early exit, or a crash by its signal", () => {
    expect(failureOf(`OpenCode exited 1 before the prompt result${exitDetail(1, null, "")}`)).toEqual({ reason: "cli_exit_early", detail: "exit_1" });
    expect(failureOf(`OpenCode exited SIGKILL before the prompt result${exitDetail(null, "SIGKILL", "")}`)).toEqual({ reason: "crashed", detail: "sigkill" });
    expect(failureOf(`OpenCode exited 127 before the prompt result${exitDetail(127, null, "")}`)).toEqual({ reason: "cli_missing", detail: "exit_127" });
  });

  it("records the provider an OpenCode model goes through instead of other", () => {
    expect(opencodeProvider("anthropic/claude-sonnet-9")).toBe("opencode/anthropic");
    expect(opencodeProvider("opencode/big-pickle")).toBe("opencode/zen");
    expect(opencodeProvider("my-company-gateway/secret-model")).toBeNull();
    expect(modelFamily("opencode/zen")).toBe("opencode/zen");
    expect(modelFamily("opencode/my-company")).toBe("other");
    const turn = (model: string) => turnRecord({ driverKind: "opencodeGo", status: "error", reason: "x", model, toolNames: [], trigger: { kind: "owner" }, room: false, startedAt: NOW - 10, endedAt: NOW }, "desktop", NOW)!;
    expect(turn("opencode/big-pickle").model).toBe("opencode/zen");
    expect(turn("openrouter/acme/unlisted-model").model).toBe("opencode/openrouter");
    expect(turn("anthropic/claude-sonnet-4-5").model).toBe("claude-sonnet-4-5");
    expect(turn("my-company-gateway/secret-model").model).toBe("other");
  });
});

describe("codex", () => {
  it("turns codexErrorInfo into a code, with its status", () => {
    expect(codexErrorCode("usageLimitExceeded")).toBe("usageLimitExceeded");
    expect(codexErrorCode({ responseStreamDisconnected: { httpStatusCode: null } })).toBe("responseStreamDisconnected");
    expect(codexErrorCode({ httpConnectionFailed: { httpStatusCode: 502 } })).toBe("httpConnectionFailed:http_502");
    expect(codexErrorCode("You've hit your usage limit.")).toBeUndefined();
    expect(codexErrorCode(null)).toBeUndefined();
  });

  it.each([
    ["stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)", "responseStreamDisconnected", "network", "responseStreamDisconnected"],
    ["Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.", "contextWindowExceeded", "context", "contextWindowExceeded"],
    ["unexpected status 502 Bad Gateway: upstream error", "httpConnectionFailed:http_502", "network", "httpConnectionFailed:http_502"],
    ["We're currently experiencing high demand, which may cause temporary errors.", "serverOverloaded", "provider_down", "serverOverloaded"],
    ["unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", "unauthorized", "auth", "unauthorized:http_401"],
    ["unexpected status 400 Bad Request: {\"detail\":\"Unsupported parameter: reasoning.summary\"}", undefined, "bad_request", "http_400"],
    ["exceeded retry limit, last status: 429 Too Many Requests", undefined, "rate_limit", "http_429"],
  ])("%s", (text, code, reason, detail) => {
    expect(failureOf(text, { code })).toEqual({ reason, detail });
  });

  it("reads codex's own exit lines", () => {
    expect(failureOf("codex exited 1 before turn/completed: Error: failed to initialize rollout recorder")).toEqual({ reason: "cli_exit_early", detail: "exit_1" });
    expect(failureOf("codex exited null (signal SIGKILL) before turn/completed")).toEqual({ reason: "crashed", detail: "exit_null:sigkill" });
  });
});

describe("copilot (ACP)", () => {
  it("names the exit code of a fast crash and a missing cli", () => {
    expect(failureOf("GitHub Copilot exited 1 before the prompt result")).toEqual({ reason: "cli_exit_early", detail: "exit_1" });
    expect(failureOf("GitHub Copilot exited 1 before the prompt result: Error: No authentication information found.")).toEqual({ reason: "auth", detail: "exit_1" });
    const missing = describeSpawnFailure(Object.assign(new Error("spawn copilot ENOENT"), { code: "ENOENT" }), "copilot");
    expect(failureOf(missing.message, { stopReason: "spawn_error" }).reason).toBe("cli_missing");
  });

  it("falls back to the turn's stop reason when the words say nothing", () => {
    expect(failureOf("", { stopReason: "exit_before_result" })).toEqual({ reason: "cli_exit_early" });
    expect(failureOf("something odd", { stopReason: "weird_stop" })).toEqual({ reason: "unknown", detail: "stop_weird_stop" });
    expect(failureOf("something odd", { stopReason: "Some long sentence the engine said" })).toEqual({ reason: "unknown" });
  });
});

describe("a connected-apps runner call", () => {
  it("reads the actions it ran from whole or cut-short arguments, and nothing from other tools", () => {
    expect(runnerActions("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS" }] })).toEqual(["GMAIL_FETCH_EMAILS"]);
    expect(runnerActions("mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", '{"tools":[{"tool_slug":"NOTION_CREATE_PAGE","arguments":{"title":"cut sh')).toEqual(["NOTION_CREATE_PAGE"]);
    expect(runnerActions("COMPOSIO_SEARCH_TOOLS", { tool_slug: "GMAIL_FETCH_EMAILS" })).toEqual([]);
    expect(runnerActions("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "COMPOSIO_SEARCH_TOOLS" }, { tool_slug: "lower_case" }] })).toEqual([]);
  });

  it("makes a failed runner call count against its app and action in the usage record", () => {
    const record = turnRecord({ driverKind: "claudeAgent", status: "ok", startedAt: NOW - 1_000, endedAt: NOW, trigger: { kind: "owner" }, room: false,
      toolNames: ["GMAIL_SEND_EMAIL", "mcp__composio__COMPOSIO_SEARCH_TOOLS"], failedNames: ["GMAIL_SEND_EMAIL"] }, "desktop", NOW);
    expect(record).toMatchObject({ apps: ["gmail", "other_app"], failedApps: ["gmail"], actions: ["gmail_send_email"], category: "email" });
  });
});

describe("a JSON-RPC failure with no words to go on (ACP agents, codex app-server)", () => {
  it("keeps the RPC code in the detail instead of the bare stop reason", () => {
    expect(failureOf("Internal error (session/prompt)", { code: rpcCode(-32603), stopReason: "rpc_error" })).toEqual({ reason: "unknown", detail: "rpc_32603" });
    expect(failureOf("Invalid params (session/prompt)", { code: rpcCode(-32602), stopReason: "rpc_error" })).toEqual({ reason: "bad_request", detail: "rpc_32602" });
    expect(rpcCode("x")).toBeUndefined();
    expect(rpcCode(1.5)).toBeUndefined();
  });
});

describe("the api engine's own stops", () => {
  it.each([
    ["The model announced another action without tool progress after a nudge. The task is incomplete.", "announced_no_action", "no_reply"],
    ["Stopped after 64 steps without a final answer. The steps so far already ran, so ask only for what's left.", "max_steps", "no_reply"],
    ["tool arguments are not complete JSON", "tool_args_malformed", "tool"],
    ["provider reused a tool-call ID; refusing to repeat an operation", "reused_call_id", "tool"],
  ])("%s", (text, code, reason) => {
    expect(failureOf(text, { code, stopReason: "error" })).toEqual({ reason, detail: code });
  });
});

describe("the detail never carries text", () => {
  it("keeps only codes from any message, and drops bad hints and bad details", () => {
    for (const text of [SECRET, `upstream HTTP 400: ${SECRET}`, `GitHub Copilot exited 1 before the prompt result: ${SECRET}`, `upstream HTTP 400: ${SECRET} (jane doe)`]) {
      const { detail } = failureOf(text, { code: "jane.doe@acme.com" });
      if (detail) expect(detail).toMatch(FAILURE_DETAIL);
      expect(detail ?? "").not.toMatch(/jane|acme|secret|users|sk-live/i);
    }
    const base = { id: "abcdefgh12", at: NOW, engine: "api", outcome: "failed", reason: "bad_request", ms: 10, tools: [], apps: [], category: "chat", from: "app", place: "desktop", room: false };
    expect(cleanUsageTurn({ ...base, detail: "http_429:insufficient_quota" }, NOW)?.detail).toBe("http_429:insufficient_quota");
    expect(cleanUsageTurn({ ...base, detail: "jane doe" }, NOW)).not.toHaveProperty("detail");
    expect(cleanUsageTurn({ ...base, detail: "/Users/jane" }, NOW)).not.toHaveProperty("detail");
    expect(cleanUsageTurn({ ...base, outcome: "ok", detail: "http_429" }, NOW)).not.toHaveProperty("detail");
    expect(cleanUsageTurn({ ...base, reason: "cli_exit_early" }, NOW)?.reason).toBe("cli_exit_early");
  });

  it("a turn record carries the recorder's failure, and reads an older row's line itself", () => {
    const facts = { driverKind: "copilotAgent", status: "error" as const, toolNames: [], trigger: { kind: "owner" }, room: false, startedAt: NOW - 300, endedAt: NOW };
    expect(turnRecord({ ...facts, reason: "GitHub Copilot exited 1 before the prompt result", failure: { reason: "cli_exit_early", detail: "exit_1" } }, "desktop", NOW))
      .toMatchObject({ engine: "copilot", reason: "cli_exit_early", detail: "exit_1" });
    expect(turnRecord({ ...facts, reason: "GitHub Copilot exited 1 before the prompt result" }, "desktop", NOW))
      .toMatchObject({ reason: "cli_exit_early", detail: "exit_1" });
    expect(turnRecord({ ...facts, status: "interrupted", reason: "GitHub Copilot exited 1" }, "desktop", NOW)).not.toHaveProperty("detail");
  });
});

describe("a cli that quit before its result, for every cli engine", () => {
  it("codes the exit, whether anything came first, and the version", () => {
    expect(cliExitCode({ code: 1, output: false, version: "codex-cli 0.160.1" })).toBe("cli_exit_early:exit_1:no_output:v0_160_1");
    expect(cliExitCode({ code: null, signal: "SIGSEGV", output: true, version: "1.0.12" })).toBe("crashed:sigsegv:after_output:v1_0_12");
    expect(cliExitCode({ code: 127, output: false })).toBe("cli_missing:exit_127:no_output");
    expect(cliExitCode({ code: 1, output: false, version: [2, 1, 140] })).toBe("cli_exit_early:exit_1:no_output:v2_1_140");
    expect(cliExitCode({ code: null, signal: "SIGTERM", output: false, version: "/Users/jane/bin/copilot" })).toBe("cli_exit_early:sigterm:no_output");
  });

  it.each([
    ["codex", "codex exited 1 before turn/completed: Error: failed to initialize rollout recorder", { code: 1, output: false, version: "0.160.1" },
      { reason: "cli_exit_early", detail: "exit_1:no_output:v0_160_1" }],
    ["codex", "codex exited null (signal SIGKILL) before turn/completed", { code: null, signal: "SIGKILL", output: true, version: "0.160.1" },
      { reason: "crashed", detail: "sigkill:after_output:v0_160_1" }],
    ["copilot", "GitHub Copilot exited 1 before the prompt result", { code: 1, output: false, version: "1.0.4" },
      { reason: "cli_exit_early", detail: "exit_1:no_output:v1_0_4" }],
    ["copilot", "GitHub Copilot exited 1 before the prompt result: Error: No authentication information found.", { code: 1, output: false },
      { reason: "auth", detail: "exit_1:no_output" }],
    ["opencode", "OpenCode exited SIGKILL before the prompt result: it was killed, often for running out of memory", { code: null, signal: "SIGKILL", output: true, version: "1.19.4" },
      { reason: "crashed", detail: "sigkill:after_output:v1_19_4" }],
    ["claude", "claude exited 1 before result: Error: spawn node ENOENT", { code: 1, output: false, version: [2, 1, 140] },
      { reason: "cli_missing", detail: "exit_1:no_output:v2_1_140:enoent" }],
    ["gemini", "Gemini CLI exited 1 before the prompt result", { code: 1, output: true },
      { reason: "cli_exit_early", detail: "exit_1:after_output" }],
  ])("%s: %s", (_engine, text, exit, failure) => {
    expect(failureOf(text, { code: cliExitCode(exit) })).toEqual(failure);
  });

  it("an empty line still reads by its exit code", () => {
    expect(failureOf("", { code: cliExitCode({ code: 3, output: false }) })).toEqual({ reason: "cli_exit_early", detail: "exit_3:no_output" });
  });
});
