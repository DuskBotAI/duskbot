// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

import { revealIfCovered } from "./SignInPill";

const box = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 200, width: 200, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

it("scrolls a sign-in step into view when it opens below the window or under the bar over it, and leaves a shown one alone", () => {
  const step = document.createElement("div");
  const inner = document.createElement("input");
  const bar = document.createElement("div");
  step.append(inner);
  document.body.append(step, bar);
  const scroll = vi.fn();
  step.scrollIntoView = scroll;
  Object.defineProperty(window, "innerHeight", { value: 577, configurable: true });

  step.getBoundingClientRect = () => box(600, 660);
  revealIfCovered(step);
  expect(scroll).toHaveBeenCalledTimes(1);

  step.getBoundingClientRect = () => box(480, 540);
  document.elementFromPoint = () => bar;
  revealIfCovered(step);
  expect(scroll).toHaveBeenCalledTimes(2);

  step.getBoundingClientRect = () => box(200, 260);
  document.elementFromPoint = () => inner;
  revealIfCovered(step);
  expect(scroll).toHaveBeenCalledTimes(2);
});
