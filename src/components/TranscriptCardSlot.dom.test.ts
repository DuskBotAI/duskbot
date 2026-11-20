// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTICE_MOTION } from "./ComposerNoticeSlot";
import { cardSlotPlan, TranscriptCardSlot } from "./TranscriptCardSlot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { collapseMs: COLLAPSE, fadeOutMs: FADE, collapseEase: IN_OUT, ease: OUT } = NOTICE_MOTION;

describe("the card slot's plan", () => {
  it("opens the slot on the collapse clock, then fades the card in", () => {
    expect(cardSlotPlan("appear", 0, 96, false)).toEqual({
      height: { from: 0, to: 96, ms: COLLAPSE, easing: IN_OUT },
      fade: { from: 0, to: 1, ms: FADE, delay: COLLAPSE, easing: OUT },
    });
  });

  it("leaves as the owner's pick: a fade where it is while the slot collapses", () => {
    expect(cardSlotPlan("leave", 96, 0, false)).toEqual({
      height: { from: 96, to: 0, ms: COLLAPSE, easing: IN_OUT },
      fade: { from: 1, to: 0, ms: FADE, delay: 0, easing: OUT },
    });
  });

  it("a card back mid-collapse opens only the rest of the way, and fades in after it", () => {
    expect(cardSlotPlan("appear", 48, 96, false)).toMatchObject({ height: { from: 48, to: 96, ms: Math.round(COLLAPSE / 2) }, fade: { delay: Math.round(COLLAPSE / 2) } });
  });

  it("moves nothing under reduced motion: the space opens at once, and holds while the card fades out", () => {
    expect(cardSlotPlan("appear", 0, 96, true)).toMatchObject({ height: null, fade: { from: 0, to: 1, delay: 0 } });
    expect(cardSlotPlan("leave", 96, 0, true)).toMatchObject({ height: { from: 96, to: 96, ms: FADE }, fade: { from: 1, to: 0, ms: FADE } });
  });
});

type Run = { keyframes: Keyframe[]; options: KeyframeAnimationOptions; node: HTMLElement; listeners: Map<string, () => void>; cancelled: boolean };
let runs: Run[] = [];
let root: ReturnType<typeof createRoot> | null = null;

const Slot = ({ show }: { show: boolean }) =>
  createElement(TranscriptCardSlot, null, show ? createElement("div", { "data-failed-reply": "", "data-card": "" }, "Bot failed to respond") : null);
const render = async (show: boolean) => { await act(async () => root!.render(createElement(Slot, { show }))); };
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const finish = (run: Run) => run.listeners.get("finish")?.();
const heightRuns = () => runs.filter((run) => run.node.dataset.failedReplyRow !== undefined);
const cardRuns = () => runs.filter((run) => run.node.dataset.card !== undefined);

beforeEach(() => {
  runs = [];
  document.documentElement.dataset.reducedMotion = "false";
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.querySelector("[data-card]") ? 96 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(function (this: HTMLElement, keyframes, options) {
    const run: Run = { keyframes: keyframes as Keyframe[], options: options as KeyframeAnimationOptions, node: this, listeners: new Map(), cancelled: false };
    runs.push(run);
    return {
      addEventListener: (type: string, listener: () => void) => run.listeners.set(type, listener),
      cancel: () => { run.cancelled = true; },
    } as unknown as Animation;
  });
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; vi.restoreAllMocks(); });

describe("the failed reply's card in the transcript", () => {
  it("just shows a card that is there when the chat opens", async () => {
    await render(true);
    await flush();
    expect(runs).toEqual([]);
  });

  it("opens its slot, then fades the card in", async () => {
    await render(false);
    await render(true);
    await flush();
    expect(heightRuns().map((run) => run.keyframes)).toEqual([[{ height: "0px" }, { height: "96px" }]]);
    expect(cardRuns()[0]!.options).toMatchObject({ duration: FADE, delay: COLLAPSE, fill: "both" });
    expect(cardRuns()[0]!.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  it("keeps a closed card on screen, faded and inert, while its slot collapses, then drops it", async () => {
    await render(true);
    await render(false);
    await flush();
    const leaving = document.querySelector<HTMLElement>("[data-card]");
    expect(leaving, "still there while it leaves").not.toBeNull();
    expect(leaving!.getAttribute("aria-hidden")).toBe("true");
    expect(leaving!.style.pointerEvents).toBe("none");
    expect(heightRuns().map((run) => [run.keyframes, run.options.duration])).toEqual([[[{ height: "96px" }, { height: "0px" }], COLLAPSE]]);
    const fade = cardRuns().at(-1)!;
    expect(fade.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(fade.options).toMatchObject({ duration: FADE, delay: 0 });
    finish(fade);
    expect(document.querySelector("[data-card]")).toBeNull();
  });

  it("a card back while the last one leaves drops the leaving one and opens from where the slot is drawn", async () => {
    await render(true);
    await render(false);
    await flush();
    const collapse = heightRuns()[0]!;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 40 } as DOMRect);
    await render(true);
    await flush();
    expect(collapse.cancelled).toBe(true);
    expect(document.querySelectorAll("[data-card]")).toHaveLength(1);
    expect(heightRuns().at(-1)!.keyframes).toEqual([{ height: "40px" }, { height: "96px" }]);
  });

  it("only fades under reduced motion", async () => {
    document.documentElement.dataset.reducedMotion = "true";
    await render(false);
    await render(true);
    await flush();
    expect(heightRuns()).toEqual([]);
    expect(cardRuns()[0]!.options).toMatchObject({ delay: 0, duration: FADE });
    await render(false);
    await flush();
    expect(heightRuns().map((run) => run.keyframes)).toEqual([[{ height: "96px" }, { height: "96px" }]]);
  });
});
