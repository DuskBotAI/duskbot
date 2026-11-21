// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSystemControls, useSystemControl } from "@/lib/system-control";
import { PlatformContext, webPlatform, type BarConfig, type MobileChrome } from "./platform";
import { phoneControlCover } from "./control-cover";
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
  installSystemControls(null, phoneControlCover);
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
    expect(push.frames.length).toBeLessThanOrEqual(34);
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

function mockNativeChrome() {
  const calls: string[] = [];
  const committedTokens: string[] = [];
  const bars: Array<BarConfig | null> = [];
  let pagePopped: ((tokens: string[]) => void) | null = null;
  const chrome: MobileChrome = {
    setBar: (config) => { bars.push(config); },
    onBarPress: () => () => {},
    onPictureTaken: () => () => {},
    freeze: async () => {},
    thaw: async () => {},
    presentSheet: async () => {},
    resizeSheet: () => {},
    dismissSheet: async () => {},
    onSheetDismissed: () => () => {},
    beginPush: async () => { calls.push("beginPush"); return true; },
    commitPush: async (token) => { calls.push(`commitPush:${token}`); committedTokens.push(token); return true; },
    cancelPush: async () => { calls.push("cancelPush"); },
    popPage: async (token) => { calls.push(`popPage:${token}`); return true; },
    finishPop: async () => { calls.push("finishPop"); },
    resetPushStack: async () => { calls.push("resetPushStack"); },
    onPagePopped: (listener) => { pagePopped = listener; return () => { pagePopped = null; }; },
  };
  return {
    chrome,
    calls,
    committedTokens,
    bars,
    firePop: (tokens: string[]) => pagePopped?.(tokens),
  };
}

async function flushMicrotasks() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function pumpFrames(count: number) {
  for (let i = 0; i < count; i += 1) {
    nextFrame();
    await flushMicrotasks();
  }
}

describe("NativeSheetPush", () => {
  it("runs beginPush -> paint -> commitPush and pops natively via onPagePopped", async () => {
    const mock = mockNativeChrome();
    const platform = { ...webPlatform(), kind: "ios" as const, native: true, chrome: mock.chrome };
    const onClose = vi.fn();
    act(() => root.render(createElement(
      PlatformContext.Provider,
      { value: platform },
      createElement(SheetPush, { open: true, onClose, title: "Vault", children: createElement("p", null, "logins") }),
    )));
    await flushMicrotasks();
    expect(mock.calls).toEqual(["beginPush"]);
    expect(host.querySelector("[data-phone-pushed-page]")).not.toBeNull();
    await pumpFrames(3);
    expect(mock.committedTokens).toHaveLength(1);
    expect(mock.calls).toEqual(["beginPush", `commitPush:${mock.committedTokens[0]}`]);
    expect(mock.bars.at(-1)?.title).toBe("Vault");
    expect(mock.bars.at(-1)?.leading[0]?.id).toBe("back");

    act(() => mock.firePop([mock.committedTokens[0]!]));
    expect(onClose).toHaveBeenCalledOnce();
    expect(host.querySelector("[data-phone-pushed-page]")).toBeNull();
    await pumpFrames(2);
    expect(mock.calls.at(-1)).toBe("finishPop");
  });

  it("handles nested pushes, depth-ordered z-index, and multi-level native pop in one pass", async () => {
    const mock = mockNativeChrome();
    const platform = { ...webPlatform(), kind: "ios" as const, native: true, chrome: mock.chrome };
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    const renderNested = (outerOpen: boolean, innerOpen: boolean) => act(() => root.render(createElement(
      PlatformContext.Provider,
      { value: platform },
      createElement(
        SheetPush,
        {
          open: outerOpen,
          onClose: closeOuter,
          title: "Vault",
          pageId: "vault",
          children: [
            createElement("p", { key: "list" }, "list"),
            createElement(SheetPush, { key: "inner", open: innerOpen, onClose: closeInner, title: "GitHub", pageId: "detail", children: createElement("p", null, "entry") }),
          ],
        },
      ),
    )));

    renderNested(true, false);
    await flushMicrotasks();
    await pumpFrames(3);
    expect(mock.committedTokens).toHaveLength(1);

    renderNested(true, true);
    await flushMicrotasks();
    await pumpFrames(3);
    expect(mock.committedTokens).toHaveLength(2);
    const pages = [...host.querySelectorAll<HTMLElement>("[data-phone-pushed-page]")];
    expect(pages).toHaveLength(2);
    expect(Number(pages[1]!.style.zIndex)).toBeGreaterThan(Number(pages[0]!.style.zIndex));
    expect(mock.bars.at(-1)?.title).toBe("GitHub");

    // Long-press back menu popping both levels at once
    act(() => mock.firePop([mock.committedTokens[1]!, mock.committedTokens[0]!]));
    expect(closeInner).toHaveBeenCalledOnce();
    expect(closeOuter).toHaveBeenCalledOnce();
    expect(host.querySelectorAll("[data-phone-pushed-page]")).toHaveLength(0);
    await pumpFrames(2);
    expect(mock.calls.filter((call) => call === "finishPop")).toHaveLength(1);
  });

  it("pops programmatically via popPage -> unmount -> finishPop when open turns false", async () => {
    const mock = mockNativeChrome();
    const platform = { ...webPlatform(), kind: "ios" as const, native: true, chrome: mock.chrome };
    const draw = (open: boolean) => act(() => root.render(createElement(
      PlatformContext.Provider,
      { value: platform },
      createElement(SheetPush, { open, onClose: () => {}, title: "Routines", children: createElement("p", null, "rows") }),
    )));

    draw(true);
    await flushMicrotasks();
    await pumpFrames(3);
    const token = mock.committedTokens[0]!;

    draw(false);
    await flushMicrotasks();
    expect(mock.calls).toContain(`popPage:${token}`);
    expect(host.querySelector("[data-phone-pushed-page]")).toBeNull();
    await pumpFrames(2);
    expect(mock.calls.at(-1)).toBe("finishPop");
  });

  it("waits for native control placement to commit before commitPush and finishPop", async () => {
    const mock = mockNativeChrome();
    const platform = { ...webPlatform(), kind: "ios" as const, native: true, chrome: mock.chrome };
    const pendingPlaces: Array<() => void> = [];
    installSystemControls({
      place: () => new Promise<boolean>((resolve) => { pendingPlaces.push(() => resolve(true)); }),
      remove: () => {},
      onChange: () => () => {},
    }, phoneControlCover);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(16, 120, 358, 36));
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => host.querySelector("[data-control-slot]"),
    });

    function BaseControl() {
      const ref = useRef<HTMLDivElement>(null);
      useSystemControl(ref, { kind: "segmented", items: ["System", "Light", "Dark"], selected: 0 }, () => {});
      return createElement("div", { ref, "data-control-slot": "" });
    }

    const draw = (open: boolean) => act(() => root.render(createElement(
      PlatformContext.Provider,
      { value: platform },
      createElement("div", null,
        createElement(BaseControl),
        createElement(SheetPush, { open, onClose: () => {}, title: "Language", children: createElement("p", null, "langs") }),
      ),
    )));

    draw(true);
    await flushMicrotasks();
    await pumpFrames(1);
    expect(pendingPlaces.length).toBeGreaterThan(0);
    // commitPush must not fire while system control placement is still in flight
    expect(mock.committedTokens).toHaveLength(0);

    await act(async () => { for (const resolve of pendingPlaces.splice(0)) resolve(); });
    await flushMicrotasks();
    await pumpFrames(2);
    expect(mock.committedTokens).toHaveLength(1);

    const token = mock.committedTokens[0]!;
    act(() => mock.firePop([token]));
    await pumpFrames(1);
    expect(pendingPlaces.length).toBeGreaterThan(0);
    // finishPop must wait for the underlying control to unhide natively before lifting the pop cover
    expect(mock.calls).not.toContain("finishPop");

    await act(async () => { for (const resolve of pendingPlaces.splice(0)) resolve(); });
    await flushMicrotasks();
    await pumpFrames(1);
    expect(mock.calls.at(-1)).toBe("finishPop");
  });
});
