// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerNoticeSlot, NOTICE_MOTION } from "./ComposerNoticeSlot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Run = { keyframes: Keyframe[]; options?: KeyframeAnimationOptions; node: Element; onfinish: (() => void) | null; oncancel: (() => void) | null };
let runs: Run[] = [];
let root: ReturnType<typeof createRoot> | null = null;

const Card = ({ show, text }: { show: boolean; text: string }) =>
  createElement(ComposerNoticeSlot, null,
    createElement("div", { className: "pointer-events-auto" }, show ? createElement("div", { "data-card": "" }, text) : null));
const render = async (show: boolean, text = "Bot failed to respond") => { await act(async () => root!.render(createElement(Card, { show, text }))); };
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const cardRuns = () => runs.filter((run) => (run.node as HTMLElement).dataset?.card !== undefined);

beforeEach(() => {
  runs = [];
  document.documentElement.dataset.reducedMotion = "false";
  vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(function (this: HTMLElement, keyframes, options) {
    const run: Run = { keyframes: keyframes as Keyframe[], options: options as KeyframeAnimationOptions, node: this, onfinish: null, oncancel: null };
    runs.push(run);
    return run as unknown as Animation;
  });
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; vi.restoreAllMocks(); });

describe("the cards above the composer", () => {
  it("come in with a fade and a short rise", async () => {
    await render(false);
    await render(true);
    await flush();
    const enter = cardRuns()[0]!;
    expect(enter.keyframes[0]).toMatchObject({ opacity: 0, transform: "translateY(6px)" });
    expect(enter.keyframes[1]).toMatchObject({ opacity: 1 });
  });

  it("keep a leaving card on screen, fading where it is, until its exit has played, then drop it", async () => {
    await render(true);
    await render(false);
    await flush();
    const leaving = document.querySelector("[data-card]");
    expect(leaving, "still there while it leaves").not.toBeNull();
    expect(leaving!.getAttribute("aria-hidden")).toBe("true");
    const exit = cardRuns().at(-1)!;
    expect(exit.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(exit.options).toMatchObject({ duration: NOTICE_MOTION.fadeOutMs, easing: NOTICE_MOTION.ease });
    exit.onfinish!();
    expect(document.querySelector("[data-card]")).toBeNull();
  });

  it("only fade with reduced motion", async () => {
    document.documentElement.dataset.reducedMotion = "true";
    await render(true);
    await render(false);
    await flush();
    for (const run of cardRuns()) for (const frame of run.keyframes) expect(frame.transform).toBeUndefined();
    expect(cardRuns().map((run) => run.keyframes.map((frame) => frame.opacity))).toEqual([[1, 0]]);
  });
});
