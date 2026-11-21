import { describe, expect, it } from "vitest";

import type { Frame } from "./events.ts";
import { parallelism, SAME_ROUND_MS } from "./parallel.ts";

const runtime = (at: number, threadId: string, event: Record<string, unknown>): Frame => ({ at, kind: "runtime", threadId, data: { event: { threadId, turnId: `${threadId}-turn`, ...event } } });
const tool = (threadId: string, id: string, start: number, end: number): Frame[] => [
  runtime(start, threadId, { type: "item.started", itemType: "tool", itemId: id }),
  runtime(end, threadId, { type: "item.completed", itemType: "tool", itemId: id }),
];

describe("parallelism", () => {
  it("counts tools asked for in one round together, apart from a later round", () => {
    const frames = [
      runtime(0, "a", { type: "turn.started" }),
      ...tool("a", "1", 1_000, 1_800), ...tool("a", "2", 1_010, 1_500), ...tool("a", "3", 1_820, 1_900),
      ...tool("a", "4", 1_900 + SAME_ROUND_MS + 2_000, 5_000),
      runtime(6_000, "a", { type: "turn.completed" }),
    ].sort((x, y) => x.at - y.at);
    expect(parallelism(frames, ["a"])).toEqual({ tools: 4, toolRounds: 2, batchedTools: 3, maxToolsInFlight: 2, maxThreadsBusy: 1, threadsWithTurns: 1 });
  });

  it("sees separate jobs of the bot running at the same moment, and ignores threads that are not its own", () => {
    const frames = [
      runtime(0, "a", { type: "turn.started" }), runtime(100, "b", { type: "turn.started" }), runtime(200, "c", { type: "turn.started" }),
      runtime(300, "x", { type: "turn.started" }),
      runtime(5_000, "b", { type: "turn.completed" }), runtime(6_000, "c", { type: "turn.completed" }), runtime(9_000, "a", { type: "turn.completed" }),
    ];
    expect(parallelism(frames, ["a", "b", "c"])).toMatchObject({ tools: 0, toolRounds: 0, maxThreadsBusy: 3, threadsWithTurns: 3 });
  });
});
