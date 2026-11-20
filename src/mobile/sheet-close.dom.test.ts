// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "./Sheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HEIGHT = 600;
let root: Root;
let host: HTMLDivElement;
let frames: FrameRequestCallback[];
let runs: Array<{ el: Element; frames: Keyframe[]; animation: { onfinish: (() => void) | null } }>;
let drawn: string;

function render(open: boolean) {
  act(() => root.render(createElement(Sheet, { open, onClose: () => {}, title: "settings", children: createElement("p", null, "rows") })));
}
const nextFrame = () => act(() => { for (const fn of frames.splice(0)) fn(performance.now()); });
const sheetRuns = () => runs.filter((run) => run.el.getAttribute("role") === "dialog");
const lastY = (run: { frames: Keyframe[] }, at: number) => Number(/translateY\((.+)px\)/.exec(String(run.frames.at(at)!.transform))![1]);
const land = () => act(() => sheetRuns().at(-1)!.animation.onfinish?.());
const mounted = () => host.querySelector("[role=dialog]") !== null;

beforeEach(() => {
  frames = [];
  runs = [];
  drawn = "none";
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frames.push(fn); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: HEIGHT, width: 390, top: 0, left: 0, right: 390, bottom: HEIGHT, x: 0, y: 0, toJSON() {} } as DOMRect);
  vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({ transform: drawn, getPropertyValue: () => "" }) as unknown as CSSStyleDeclaration);
  vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(function (this: Element, keyframes) {
    const animation = { commitStyles() {}, cancel() {}, onfinish: null };
    runs.push({ el: this, frames: keyframes as Keyframe[], animation });
    return animation as unknown as Animation;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function opened() {
  render(true);
  nextFrame();
  land();
}

describe("closing a sheet", () => {
  it("slides away on the compositor on the same spring it rose on, and unmounts only once it has left", async () => {
    await opened();
    const rise = sheetRuns()[0]!;
    render(false);
    const close = sheetRuns().at(-1)!;
    expect(close).not.toBe(rise);
    expect(lastY(close, 0)).toBe(0);
    expect(lastY(close, -1)).toBe(HEIGHT + 24);
    // it leaves at the speed it arrived: the first step of each covers the same ground
    expect((lastY(close, 1) - lastY(close, 0)) / (lastY(rise, 0) - lastY(rise, 1))).toBeCloseTo(1, 1);
    expect(mounted()).toBe(true);
    land();
    expect(mounted()).toBe(false);
  });

  it("turns around from where it is when opened again while it leaves", async () => {
    await opened();
    render(false);
    drawn = "matrix(1, 0, 0, 1, 0, 240)";
    render(true);
    const back = sheetRuns().at(-1)!;
    expect(lastY(back, 0)).toBe(240);
    expect(lastY(back, -1)).toBe(0);
    land();
    expect(mounted()).toBe(true);
  });
});
