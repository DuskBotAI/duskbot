import { describe, expect, it } from "vitest";

import type { BrowserStep } from "./browser-step";
import { browsingNow } from "./LiveRows";

const step = (id: string, ok?: boolean): BrowserStep =>
  ({ id, role: "bot", kind: "activity", at: 1, tool: { name: "mcp__browser__agent_browser_click", ...(ok === undefined ? {} : { ok }) } }) as BrowserStep;
const now = (over: Partial<Parameters<typeof browsingNow>[0]> = {}) => browsingNow({
  steps: [step("a", true), step("b", true)], through: ["a", "b"], live: new Set(["a", "b"]), room: false, turnEnded: false, replying: false, ...over,
});

describe("browsingNow", () => {
  it("is true between two browser calls of a running turn, so the card stays open", () => {
    expect(now()).toBe(true);
  });

  it("is false once the turn is over, its answer is being written, or its steps are from an earlier turn", () => {
    expect(now({ turnEnded: true })).toBe(false);
    expect(now({ replying: true })).toBe(false);
    expect(now({ live: new Set() })).toBe(false);
    expect(now({ live: new Set(["z"]) })).toBe(false);
  });

  it("is false once the turn's newest step is past the stretch, and true while it is a step the chat does not draw", () => {
    expect(now({ live: new Set(["a", "b", "command"]) })).toBe(false);
    expect(now({ through: ["a", "b", "hidden"], live: new Set(["a", "b", "hidden"]) })).toBe(true);
  });

  it("in a room follows only the member's own running call when a teammate's step is newer", () => {
    const live = new Set(["a", "b", "teammate"]);
    expect(now({ room: true, live })).toBe(false);
    expect(now({ room: true, live, steps: [step("a", true), step("b")] })).toBe(true);
  });
});
