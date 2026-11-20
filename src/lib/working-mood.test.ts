import { describe, expect, it } from "vitest";
import { TYPING_PHASE } from "./friendly-activity";
import { wordGroup, workingMood } from "./working-mood";

describe("workingMood", () => {
  it.each([
    [undefined, "thinking"],
    ["friendly:thinking", "thinking"],
    ["friendly:generic", "thinking"],
    ["friendly:memory", "thinking"],
    [TYPING_PHASE, "replying"],
    ["friendly:code", "writing"],
    ["friendly:editing", "writing"],
    ["friendly:web", "searching"],
    ["friendly:browsing", "browsing"],
    ["friendly:openPage", "browsing"],
    ["friendly:clicking", "browsing"],
    ["friendly:service:Gmail", "browsing"],
    ["friendly:commands", "running"],
    ["friendly:files", "reading"],
    ["friendly:team", "waiting"],
    ["notice:Retrying in 5 s", "error"],
    ["friendly:something-new", "thinking"],
  ])("%s is %s", (phase, mood) => {
    expect(workingMood({ phase })).toBe(mood);
  });

  it("puts waiting on the person, a failed step and the turn's end ahead of the step", () => {
    expect(workingMood({ phase: "friendly:commands", waiting: true })).toBe("waiting");
    expect(workingMood({ phase: "friendly:commands", waiting: true, failed: true })).toBe("error");
    expect(workingMood({ phase: "friendly:commands", failed: true, done: true })).toBe("done");
  });
});

describe("wordGroup", () => {
  it("folds steps into thinking, looking things up, working on it and writing; labels and notices stand alone", () => {
    const groups = (phases: string[]) => phases.map(wordGroup);
    expect(groups(["friendly:thinking", "friendly:generic", "friendly:memory", "friendly:opening"])).toEqual(Array(4).fill("thinking"));
    expect(groups(["friendly:web", "friendly:page", "friendly:files", "friendly:screen", "friendly:service:Gmail"])).toEqual(Array(5).fill("looking"));
    expect(groups(["friendly:commands", "friendly:editing", "friendly:code", "friendly:form"])).toEqual(Array(4).fill("working"));
    expect(wordGroup(TYPING_PHASE)).toBe("writing");
    expect(wordGroup("label:Comparing desks")).toBe("label:Comparing desks");
    expect(wordGroup("notice:Retrying in 5 s")).toBe("notice:Retrying in 5 s");
  });
});
