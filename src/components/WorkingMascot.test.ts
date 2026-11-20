// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stillSvgPaths } from "@/pixel/engine";
import { WORKING_MOODS, type WorkingMood } from "@/lib/working-mood";
import { MOOD_FACES, WorkingMascot } from "./WorkingMascot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const bot = { id: "nova", color: "green" as const };
const reduce = (on: boolean) => vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
  matches: on && query.includes("reduce"), media: query, addEventListener: () => {}, removeEventListener: () => {},
}) as unknown as MediaQueryList);

const draw = (mood?: WorkingMood, motion?: "current") => act(() => root.render(createElement(WorkingMascot, { bot, size: 26, seed: "s", mood, motion: motion ?? "current" })));
const drawShipped = (mood?: WorkingMood) => act(() => root.render(createElement(WorkingMascot, { bot, size: 26, seed: "s", mood })));
const drawMotion = (motion: "current" | "flat-gentle", mood: WorkingMood = "thinking") => act(() => root.render(createElement(WorkingMascot, { bot, size: 26, seed: "s", mood, motion })));
const mascot = () => host.querySelector<HTMLElement>("[data-working-mascot]")!;
const eyes = () => mascot().querySelectorAll("path")[1]!.getAttribute("d");

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the working mascot's face", () => {
  it("wears an expression for every mood, never the plain resting eyes while it thinks", () => {
    reduce(false);
    const resting = stillSvgPaths("kit", { scale: 1 }).eyes;
    for (const mood of WORKING_MOODS) expect(MOOD_FACES[mood].length, mood).toBeGreaterThan(0);
    for (const face of Object.values(MOOD_FACES).flat()) expect(face.ms, "a face changes no faster than every 2 s").toBeGreaterThanOrEqual(2000);
    draw("thinking");
    expect(mascot().dataset.face).toBe("thinking");
    expect(eyes()).not.toBe(resting);
    draw("error");
    expect(mascot().dataset.face, "concerned on a failed step").toBe("sad");
    draw("replying");
    expect(mascot().dataset.face, "a happy beat as the reply comes").toBe("happy");
  });

  it("looks about while it thinks, the other way round too, and plays the reply's happy beat only once", () => {
    reduce(false);
    draw("thinking");
    const seen = [mascot().dataset.face];
    for (const face of MOOD_FACES.thinking) {
      act(() => void vi.advanceTimersByTime(face.ms));
      seen.push(mascot().dataset.face);
    }
    expect(seen).toEqual(["thinking", "thinking-flip", "confused", "thinking"]);

    draw("replying");
    const replying = [mascot().dataset.face];
    for (let i = 0; i < 3; i++) {
      act(() => void vi.advanceTimersByTime(3_000));
      replying.push(mascot().dataset.face);
    }
    expect(replying).toEqual(["happy", "working", "working", "working"]);
  });

  it("holds one face under reduced motion, still an expression", () => {
    reduce(true);
    draw("replying");
    expect(mascot().dataset.face).toBe("working");
    act(() => void vi.advanceTimersByTime(20_000));
    expect(mascot().dataset.face).toBe("working");
    draw("thinking");
    expect(mascot().dataset.face).toBe("thinking");
  });

  it("keeps its resting eyes without a mood, as the phone list's rows draw it", () => {
    reduce(false);
    draw();
    expect(mascot().dataset.face).toBeUndefined();
    expect(eyes()).toBe(stillSvgPaths("kit", { scale: 1 }).eyes);
  });

  it("moves the gentle flat mascot in the chat line, and keeps the plain loops where it has no mood", () => {
    reduce(false);
    drawShipped("thinking");
    expect(mascot().dataset.motion).toBe("flat-gentle");
    drawShipped();
    expect(mascot().dataset.motion).toBeUndefined();
    expect(mascot().querySelector(".working-mascot-bob")).not.toBeNull();
  });

  it("poses a lab motion on the shared frame loop only while it is on screen", () => {
    reduce(false);
    let seen: (entries: Array<{ isIntersecting: boolean }>) => void = () => {};
    vi.stubGlobal("IntersectionObserver", class { constructor(fn: typeof seen) { seen = fn; } observe() {} disconnect() {} });
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const caf = vi.spyOn(window, "cancelAnimationFrame");
    drawMotion("flat-gentle");
    expect(mascot().dataset.motion).toBe("flat-gentle");
    expect(raf, "nothing until it is seen").not.toHaveBeenCalled();
    act(() => seen([{ isIntersecting: true }]));
    expect(raf).toHaveBeenCalledTimes(1);
    act(() => seen([{ isIntersecting: false }]));
    expect(caf).toHaveBeenCalledTimes(1);
    act(() => seen([{ isIntersecting: true }]));
    act(() => root.render(null));
    expect(caf).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("asks for no frames at all under reduced motion", () => {
    reduce(true);
    const raf = vi.spyOn(window, "requestAnimationFrame");
    drawMotion("flat-gentle");
    drawMotion("flat-gentle", "writing");
    expect(raf).not.toHaveBeenCalled();
    expect(mascot().querySelectorAll("path")[0]!.getAttribute("d")).toMatch(/^M/);
  });

  it("mirrors a sideways look across its own eyes", () => {
    reduce(false);
    draw("thinking");
    const right = eyes();
    act(() => void vi.advanceTimersByTime(MOOD_FACES.thinking[0]!.ms));
    const left = eyes();
    expect(left).not.toBe(right);
    const xs = (d: string | null) => [...(d ?? "").matchAll(/M(-?\d+) /g)].map((m) => Number(m[1]));
    const rest = xs(stillSvgPaths("kit", { scale: 1 }).eyes);
    expect(Math.sign(Math.min(...xs(right)) - Math.min(...rest)), "it looks one way").toBe(-Math.sign(Math.min(...xs(left)) - Math.min(...rest)));
  });
});
