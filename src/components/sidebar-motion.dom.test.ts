// @vitest-environment happy-dom
import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RAIL_MORPH_EASING, RAIL_MORPH_MS, useRailMorph } from "./sidebar-motion";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Run = { el: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions };
let runs: Run[] = [];
let root: Root;
let host: HTMLDivElement;
let rail = false;
let toggle: () => void = () => {};

const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

function Shell() {
  const aside = useRef<HTMLElement>(null);
  const morph = useRailMorph(aside);
  const [icons, setIcons] = useState(rail);
  toggle = () => morph(() => { rail = !icons; setIcons(!icons); });
  return createElement("div", null,
    createElement("aside", { ref: aside, "data-aside": "" },
      createElement("div", { "data-glass-frame": "" },
        createElement("span", { "data-morph": "bot:a", "data-avatar": "" }),
        icons ? createElement("hr", { "data-separator": "" }) : createElement("p", { "data-name": "" }, "Atlas"))),
    createElement("main", null, "chat"));
}

const reduce = (on: boolean) => vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
  matches: on && query.includes("reduce"), media: query, addEventListener: () => {}, removeEventListener: () => {},
}) as unknown as MediaQueryList);

beforeEach(() => {
  runs = [];
  rail = false;
  vi.spyOn(Element.prototype, "animate").mockImplementation(function (this: Element, keyframes, options) {
    runs.push({ el: this, keyframes: keyframes as Keyframe[], options: options as KeyframeAnimationOptions });
    return { finished: new Promise(() => {}), cancel: () => {} } as unknown as Animation;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.matches("[data-aside]")) return box(0, 0, rail ? 80 : 288, 800);
    if (this.matches("main")) return box(rail ? 80 : 288, 0, 900, 800);
    if (this.matches("[data-avatar]")) return rail ? box(22, 60, 36, 36) : box(20, 100, 40, 40);
    return box(0, 0, 0, 0);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(Shell)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("the sidebar between names and avatars", () => {
  it("swaps at once, then slides the chat column, glides the avatar and fades the words on one critically damped clock", () => {
    reduce(false);
    act(() => toggle());
    expect(host.querySelector("[data-separator]"), "the rail is laid out before the first frame").not.toBeNull();
    const main = runs.find((run) => run.el.matches("main"))!;
    expect(main.keyframes).toEqual([{ transform: "translateX(208px)" }, { transform: "none" }]);
    expect(main.options).toMatchObject({ duration: RAIL_MORPH_MS, easing: RAIL_MORPH_EASING });
    const flyer = runs.find((run) => run.el instanceof HTMLElement && run.el.dataset.morphFly === "bot:a")!;
    expect(flyer.keyframes[0]).toMatchObject({ transform: `translate(-2px, 40px) scale(${40 / 36})` });
    expect(flyer.options).toMatchObject({ duration: RAIL_MORPH_MS, easing: RAIL_MORPH_EASING });
    expect((host.querySelector("[data-aside] [data-morph='bot:a']") as HTMLElement).style.visibility, "the real avatar waits under its copy").toBe("hidden");
    expect(runs.some((run) => run.el.matches("[data-separator]") && run.keyframes[0]?.opacity === 0), "what is new fades in").toBe(true);
    const ghost = host.querySelector("[data-aside] > [data-morph-layer] [data-name]");
    expect(ghost?.textContent, "the names it leaves fade out where they stood").toBe("Atlas");
  });

  it("opens by clipping the sidebar's edge to where the chat column starts", () => {
    rail = true;
    act(() => root.render(createElement("div")));
    act(() => root.render(createElement(Shell)));
    reduce(false);
    act(() => toggle());
    const aside = runs.find((run) => run.el.matches("[data-aside]"))!;
    expect(aside.keyframes).toEqual([{ clipPath: "inset(0 208px 0 0)" }, { clipPath: "inset(0 0 0 0)" }]);
    expect(runs.find((run) => run.el.matches("main"))!.keyframes[0]).toEqual({ transform: "translateX(-208px)" });
  });

  it("under reduced motion only swaps", () => {
    reduce(true);
    act(() => toggle());
    expect(host.querySelector("[data-separator]")).not.toBeNull();
    expect(runs).toHaveLength(0);
    expect(host.querySelector("[data-morph-layer]")).toBeNull();
  });

  it("rides a curve that starts at rest, never overshoots and is 99% there when it ends", () => {
    const points = /^linear\((.*)\)$/.exec(RAIL_MORPH_EASING)![1]!.split(", ").map(Number);
    expect(points[0]).toBe(0);
    expect(points.at(-1)).toBe(1);
    expect(points.every((value, index) => index === 0 || value >= points[index - 1]!)).toBe(true);
    expect(points.at(-2)!).toBeGreaterThan(0.99);
    expect(points[1]!).toBeLessThan(0.02);
  });
});
