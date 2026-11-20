// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SheetPush } from "./SheetPush";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WIDTH = 390;
let root: Root;
let host: HTMLDivElement;
let baseSheet: HTMLDivElement;
let frames: FrameRequestCallback[];
let runs: Array<{ el: Element; frames: Keyframe[]; animation: { currentTime: number; onfinish: (() => void) | null } }>;

function render(open: boolean, onClose = () => {}) {
  act(() => root.render(createElement(SheetPush, { open, onClose, title: "Thinking", children: createElement("p", null, "levels") })));
}
const nextFrame = () => act(() => { for (const fn of frames.splice(0)) fn(performance.now()); });
const pageRuns = () => runs.filter((run) => run.el.hasAttribute("data-phone-pushed-page"));
const baseRuns = () => runs.filter((run) => run.el === baseSheet);
const frameX = (run: { frames: Keyframe[] }, at: number) => Number(/translateX\((.+)px\)/.exec(String(run.frames.at(at)!.transform))![1]);
const land = () => act(() => pageRuns().at(-1)?.animation.onfinish?.());

beforeEach(() => {
  frames = [];
  runs = [];
  vi.stubGlobal("innerWidth", WIDTH);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frames.push(fn); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({ transform: "none", getPropertyValue: () => "" }) as unknown as CSSStyleDeclaration);
  vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(function (this: Element, keyframes) {
    const animation = { currentTime: 0, commitStyles() {}, cancel() {}, onfinish: null };
    runs.push({ el: this, frames: keyframes as Keyframe[], animation });
    return animation as unknown as Animation;
  });
  host = document.createElement("div");
  host.className = "dusk-mobile";
  const layer = document.createElement("div");
  layer.className = "mobile-sheet-layer";
  baseSheet = document.createElement("div");
  baseSheet.className = "mobile-sheet";
  layer.append(baseSheet);
  const mount = document.createElement("div");
  host.append(layer, mount);
  document.body.append(host);
  root = createRoot(mount);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SheetPush", () => {
  it("pushes in on the compositor spring with 30% base parallax and pops back cleanly before unmounting", () => {
    render(true);
    expect(host.querySelector("[data-phone-pushed-page]")).not.toBeNull();
    nextFrame();
    nextFrame();
    const push = pageRuns()[0]!;
    expect(frameX(push, 0)).toBe(WIDTH);
    expect(frameX(push, -1)).toBe(0);
    expect(frameX(push, 0) - frameX(push, 1)).toBeGreaterThan(frameX(push, 1) - frameX(push, 2));
    const parallax = baseRuns()[0]!;
    expect(frameX(parallax, 0)).toBeCloseTo(0, 1);
    expect(frameX(parallax, -1)).toBeCloseTo(-WIDTH * 0.3, 1);
    land();

    render(false);
    expect(host.querySelector("[data-phone-pushed-page]")).not.toBeNull();
    const pop = pageRuns().at(-1)!;
    expect(frameX(pop, 0)).toBe(0);
    expect(frameX(pop, -1)).toBe(WIDTH);
    expect(frameX(baseRuns().at(-1)!, -1)).toBeCloseTo(0, 1);
    land();
    expect(host.querySelector("[data-phone-pushed-page]")).toBeNull();
    expect(baseSheet.style.transform).toBe("");
  });
});
