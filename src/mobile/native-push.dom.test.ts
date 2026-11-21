// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sheetsUp } from "./chrome";
import { useNativeTrail, type NativeTrail } from "./native-push";
import type { MobileChrome } from "./platform";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let frames: FrameRequestCallback[];
let trail: NativeTrail<string>;
let shown: string[];
let popped: Array<{ removed: string[]; left: string[] }>;

function fakeChrome({ begins = true, commits = true } = {}) {
  const calls: string[] = [];
  const tokens: string[] = [];
  let pagePopped: ((tokens: string[]) => void) | null = null;
  const chrome = {
    beginPush: async () => { calls.push("beginPush"); return begins; },
    commitPush: async (token: string) => { calls.push("commitPush"); tokens.push(token); return commits; },
    cancelPush: async () => { calls.push("cancelPush"); },
    popPage: async (token: string, options?: { animated?: boolean }) => {
      calls.push(options?.animated === false ? `drop:${tokens.indexOf(token)}` : `popPage:${tokens.indexOf(token)}`);
      return true;
    },
    finishPop: async () => { calls.push("finishPop"); },
    onPagePopped: (listener: (tokens: string[]) => void) => { pagePopped = listener; return () => { pagePopped = null; }; },
  } as unknown as MobileChrome;
  return { chrome, calls, tokens, systemPops: (which: number[]) => pagePopped?.(which.map((at) => tokens[at]!)) };
}

function Harness({ chrome }: { chrome: MobileChrome | null }) {
  const [pages, setPages] = useState<string[]>([]);
  trail = useNativeTrail<string>(chrome, (removed, left) => {
    popped.push({ removed, left });
    setPages(left);
  });
  shown = pages;
  return createElement("ul", null, pages.map((page) => createElement("li", { key: page }, page)));
}

const mount = (chrome: MobileChrome | null) => act(() => root.render(createElement(Harness, { chrome })));
const push = (page: string) => trail.push(() => page, (item, pushedTrail) => { shown = pushedTrail ?? [...shown, item]; });

async function settle(frameCount = 4) {
  for (let i = 0; i < frameCount; i += 1) {
    await act(async () => { for (let turn = 0; turn < 6; turn += 1) await Promise.resolve(); });
    act(() => { for (const fn of frames.splice(0)) fn(performance.now()); });
  }
  await act(async () => { for (let turn = 0; turn < 6; turn += 1) await Promise.resolve(); });
}

beforeEach(() => {
  frames = [];
  popped = [];
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frames.push(fn); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await settle();
  act(() => root.unmount());
  host.remove();
  sheetsUp.system = false;
  vi.unstubAllGlobals();
});

describe("a trail of pages pushed the system's way", () => {
  it("pushes each page under the system's cover, then pops the top one back out", async () => {
    const device = fakeChrome();
    mount(device.chrome);
    expect(push("apps")).toBe(true);
    await settle();
    expect(device.calls).toEqual(["beginPush", "commitPush"]);
    expect(shown).toEqual(["apps"]);
    push("github");
    await settle();
    expect(shown).toEqual(["apps", "github"]);

    expect(trail.back()).toBe(true);
    await settle();
    expect(device.calls.slice(-2)).toEqual(["popPage:1", "finishPop"]);
    expect(popped).toEqual([{ removed: ["github"], left: ["apps"] }]);
  });

  it("hears the system's own back take off every page it left, as the system names them top first", async () => {
    const device = fakeChrome();
    mount(device.chrome);
    for (const page of ["apps", "github", "tokens"]) {
      push(page);
      await settle();
    }
    act(() => device.systemPops([2, 1]));
    expect(popped).toEqual([{ removed: ["tokens"], left: ["apps", "github"] }, { removed: ["github"], left: ["apps"] }]);
    expect(shown).toEqual(["apps"]);
    await settle();
    expect(device.calls.filter((call) => call === "finishPop")).toHaveLength(1);
    expect(trail.back()).toBe(true);
  });

  it("takes every page over a popped one off with it", async () => {
    const device = fakeChrome();
    mount(device.chrome);
    for (const page of ["apps", "github", "tokens"]) {
      push(page);
      await settle();
    }
    act(() => device.systemPops([1]));
    expect(popped).toEqual([{ removed: ["github", "tokens"], left: ["apps"] }]);
  });

  it("shows the page without a slide where the system refuses the push, and has nothing to pop", async () => {
    const device = fakeChrome({ begins: false });
    mount(device.chrome);
    push("apps");
    await settle();
    expect(device.calls).toEqual(["beginPush"]);
    expect(shown).toEqual(["apps"]);
    expect(trail.back()).toBe(false);
  });

  it("takes a page back down when the system does not slide it in", async () => {
    const device = fakeChrome({ commits: false });
    mount(device.chrome);
    push("apps");
    await settle();
    expect(popped).toEqual([{ removed: ["apps"], left: [] }]);
    expect(trail.back()).toBe(false);
  });

  it("gives up a push whose owner went away, and drops the pages already up without a slide", async () => {
    const device = fakeChrome();
    sheetsUp.system = true;
    mount(device.chrome);
    push("apps");
    await settle();
    push("github");
    await act(async () => { for (let turn = 0; turn < 6; turn += 1) await Promise.resolve(); });
    act(() => root.unmount());
    await settle();
    expect(device.calls).toEqual(["beginPush", "commitPush", "beginPush", "cancelPush", "drop:0"]);
    expect(popped).toEqual([]);
    root = createRoot(host);
  });

  it("pushes nothing where the device has no pages of its own", () => {
    mount(null);
    expect(push("apps")).toBe(false);
    expect(trail.back()).toBe(false);
  });
});
