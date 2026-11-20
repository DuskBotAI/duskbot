import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../../shared/runtime-events";
import { commandTail, forgetCommandTails, noteCommandTail } from "./command-tails";
import { forgetTurnStatuses, noteTurnEvent } from "./turn-status";

const event = (fields: Record<string, unknown>) => ({ eventId: "e", provider: "claudeAgent", providerInstanceId: "claude", threadId: "t1", createdAt: "2026-01-01T00:00:00.000Z", turnId: "turn-1", ...fields }) as unknown as RuntimeEvent;
const progress = (itemId: string, tail: string[], threadId = "t1") => event({ type: "turn.progress", activity: "command", itemId, tail, threadId });

afterEach(() => forgetCommandTails());

describe("command tails", () => {
  it("keeps each running command's own last lines, by thread and call", () => {
    noteCommandTail(progress("a", ["one"]));
    noteCommandTail(progress("b", ["two", "three"]));
    noteCommandTail(progress("a", ["one", "four"]));
    noteCommandTail(progress("a", ["elsewhere"], "t2"));
    expect(commandTail("t1", "a")).toEqual(["one", "four"]);
    expect(commandTail("t1", "b")).toEqual(["two", "three"]);
    expect(commandTail("t2", "a")).toEqual(["elsewhere"]);
    expect(commandTail("t1", "missing")).toEqual([]);
    expect(commandTail(undefined, "a")).toEqual([]);
  });

  it("ignores frames that carry no command output", () => {
    noteCommandTail(event({ type: "turn.progress", activity: "web", itemId: "a", tail: ["x"] }));
    noteCommandTail(event({ type: "turn.progress", activity: "command", itemId: "a" }));
    noteCommandTail(event({ type: "turn.progress", activity: "command", tail: ["x"] }));
    expect(commandTail("t1", "a")).toEqual([]);
  });

  it("keeps the lines when the call ends and drops them when the turn does", () => {
    noteCommandTail(progress("a", ["one"]));
    noteCommandTail(event({ type: "item.completed", itemType: "tool", itemId: "a" }));
    expect(commandTail("t1", "a")).toEqual(["one"]);
    noteCommandTail(event({ type: "turn.completed" }));
    expect(commandTail("t1", "a")).toEqual([]);
  });

  it("is fed by the live frames the status line reads, and cleared with them", () => {
    noteTurnEvent(progress("a", ["one"]));
    expect(commandTail("t1", "a")).toEqual(["one"]);
    forgetTurnStatuses();
    expect(commandTail("t1", "a")).toEqual([]);
  });
});
