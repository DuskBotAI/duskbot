// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TYPING_PHASE } from "@/lib/friendly-activity";
import { typingWord, useStatusLabel } from "./TurnPresence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.useRealTimers());

describe("the working line while a reply is written", () => {
  it("moves forward through its words and holds the last", () => {
    expect([0, 1, 2, 5].map((step) => typingWord(["Writing", "Wrapping up"], step))).toEqual(["Writing", "Wrapping up", "Wrapping up", "Wrapping up"]);
  });

  it("never goes from Wrapping up back to Writing, however long the reply takes", () => {
    vi.useFakeTimers();
    const since = Date.now();
    const seen: string[] = [];
    const Probe = () => {
      const label = useStatusLabel(["Writing", "Wrapping up"], TYPING_PHASE, "chat:seed", since, true, [], true);
      if (label && seen.at(-1) !== label.text) seen.push(label.text);
      return null;
    };
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Probe)));
    for (let i = 0; i < 60; i++) act(() => { vi.advanceTimersByTime(2_000); });
    act(() => root.unmount());
    expect(seen).toEqual(["Writing", "Wrapping up"]);
  });
});
