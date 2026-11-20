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
const mounted = () => host.querySelector("[role=dialog]") !== null;

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
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


describe("closing a sheet with reduced motion", () => {
  it("fades out in place instead of sliding", async () => {
    render(true);
    nextFrame();
    await act(async () => { await new Promise((done) => setTimeout(done, 300)); });
    const before = sheetRuns().length;
    render(false);
    expect(sheetRuns().length, "nothing slides").toBe(before);
    expect(mounted()).toBe(true);
    await act(async () => { await new Promise((done) => setTimeout(done, 300)); });
    expect(mounted()).toBe(false);
  });
});
