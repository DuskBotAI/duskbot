import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { TurnStops } from "../turn-outcome.ts";
import { providerFailure, turnActed } from "./provider-failover.ts";

const at = { eventId: "e", provider: "codex", threadId: "t", turnId: "turn-1", createdAt: "2026-11-09T00:00:00Z" };
const event = (fields: Record<string, unknown>) => ({ ...at, ...fields }) as RuntimeEvent;

describe("provider failures", () => {
  it.each([
    "codex exited 1 before turn/completed: Error: 503 Service Unavailable",
    "API Error: 529 overloaded_error",
    "429 Too Many Requests: rate limit",
    "stream error: connection reset by peer",
    "codex turn/start timed out after 180000ms",
    "The model `gpt-9` does not exist: model not found",
    "unexpected status 401 Unauthorized",
    "unexpected status 400 Bad Request",
    "Internal error (session/prompt)",
    "OpenCode refused this turn because this model takes at most 128 tools and this bot offers more, even with its tool lists trimmed, so nothing ran.",
    "the run ended without a result",
  ])("counts %s", (cause) => expect(providerFailure(cause, "exit_before_result")).toBe(true));

  it.each([
    "You've hit your weekly limit · resets Oct 12",
    "This task was blocked by our safety systems.",
    "prompt is too long: 250000 tokens > 200000 maximum context length",
    "The model refused to answer this request.",
  ])("never counts %s", (cause) => expect(providerFailure(cause, "exit_before_result")).toBe(false));

  it("never counts a tool's own failure or the person's Stop", () => {
    expect(providerFailure("503 Service Unavailable", "tool_error")).toBe(false);
    expect(providerFailure("503 Service Unavailable", "cancelled")).toBe(false);
  });
});

describe("whether a turn acted", () => {
  it("counts reply words, tools and asks, not reasoning or the harness's own error text", () => {
    expect(turnActed(event({ type: "content.delta", streamKind: "assistant_text", delta: "Hi" }))).toBe(true);
    expect(turnActed(event({ type: "content.delta", streamKind: "reasoning_text", delta: "hmm" }))).toBe(false);
    expect(turnActed(event({ type: "item.started", itemType: "tool", itemId: "i", title: "shell" }))).toBe(true);
    expect(turnActed(event({ type: "item.completed", itemType: "assistant_text", text: "failed", synthetic: true }))).toBe(false);
    expect(turnActed(event({ type: "runtime.error", message: "503" }))).toBe(false);
  });

  it("is kept per turn and forgotten when the next one starts", () => {
    const stops = new TurnStops();
    stops.note(event({ type: "turn.started" }));
    stops.note(event({ type: "runtime.error", message: "503 Service Unavailable" }));
    expect(stops.read("t", "turn-1")?.acted).toBeUndefined();
    stops.note(event({ type: "item.started", itemType: "tool", itemId: "i", title: "shell" }));
    expect(stops.read("t", "turn-1")).toMatchObject({ acted: true, error: "503 Service Unavailable" });
    stops.note(event({ type: "turn.started", turnId: "turn-2" }));
    expect(stops.read("t", "turn-2")).toBeUndefined();
  });
});
