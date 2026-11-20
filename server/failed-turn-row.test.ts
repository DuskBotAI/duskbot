import { describe, expect, it } from "vitest";

import { failedTurnCause } from "../shared/failed-turn.ts";
import { isErrorRef } from "../shared/failure-plan.ts";
import { failedTurnRow } from "./failed-turn-row.ts";

describe("a failed reply's row", () => {
  it("carries a reference code, logged with its kind and the real cause", () => {
    const lines: string[] = [];
    const tool = failedTurnRow("API Error: 429 {\"type\":\"rate_limit_error\"}", {}, (line) => lines.push(line));
    expect(isErrorRef(tool.errorRef)).toBe(true);
    expect(tool.reason).toBe("rate_limit");
    expect(lines).toEqual([`failed reply ${tool.errorRef}: busy (rate_limit) API Error: 429 {"type":"rate_limit_error"}`]);
  });

  it("keeps a reason it was given, and reads none into a place or a stopped run", () => {
    const quiet = () => {};
    expect(failedTurnRow("took too long", { reason: "timeout" }, quiet).reason).toBe("timeout");
    expect(failedTurnRow("stopped: the same step did nothing three times", { blocker: { kind: "loop" } }, quiet).reason).toBeUndefined();
    expect(failedTurnRow("You've hit your usage limit", { limitResetsAt: Date.now() + 60_000 }, quiet).reason).toBe("usage_limit");
  });

  it("never logs the bot's system prompt an engine echoed back", () => {
    const lines: string[] = [];
    const tool = failedTurnRow("bad request: You are Kai, a personal bot in dusk bot. secret rules follow", {}, (line) => lines.push(line));
    expect(lines[0]).not.toContain("secret rules");
    expect(failedTurnCause(tool.name)).not.toContain("secret rules");
  });
});
