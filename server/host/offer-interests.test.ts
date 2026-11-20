import { describe, expect, it } from "vitest";

import { learn, mergeSpotted, parseInterests, renderInterests } from "./offer-interests.ts";

describe("goals kept in memory", () => {
  it("reads a line typed by hand at the starting weight, and writes back what it read", () => {
    const text = "---\ntitle: x\n---\n- Learning Portuguese\n- 2026-11-01 · from chat · a dated memory note\n- Moving to Porto · weight 2.5 · since 2026-10-02 · id moving-porto\n";
    const goals = parseInterests(text, "2026-11-20");
    expect(goals).toEqual([
      { id: "learning-portuguese", title: "Learning Portuguese", weight: 1, since: "2026-11-20", stopped: false },
      { id: "moving-porto", title: "Moving to Porto", weight: 2.5, since: "2026-10-02", stopped: false },
    ]);
    expect(parseInterests(renderInterests(goals), "2026-12-01")).toEqual(goals);
  });

  it("keeps weights within bounds and never brings back a stopped goal", () => {
    let goals = mergeSpotted([], [{ title: "Launching the app" }], "2026-11-20");
    for (let i = 0; i < 10; i++) goals = learn(goals, goals[0]!.id, "took");
    expect(goals[0]!.weight).toBe(3);
    for (let i = 0; i < 20; i++) goals = learn(goals, goals[0]!.id, "skipped");
    expect(goals[0]!.weight).toBe(0.2);
    goals = learn(goals, goals[0]!.id, "stopped");
    expect(mergeSpotted(goals, [{ title: "launching the app" }], "2026-12-01")).toEqual(goals);
    expect(mergeSpotted(goals, [{ id: goals[0]!.id, title: "Launching the app", ended: true }], "2026-12-01")).toEqual(goals);
  });
});
