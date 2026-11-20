// @vitest-environment happy-dom
import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SETTLE_MAX_MS, SETTLE_QUIET_MS, useSettledReveal, watchSettled } from "./settled-reveal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let resized: Array<() => void> = [];
let root: Root | null = null;
const host = document.createElement("div");
document.body.append(host);
beforeEach(() => {
  vi.useFakeTimers();
  resized = [];
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized.push(callback); } observe() {} disconnect() {} });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; vi.useRealTimers(); vi.unstubAllGlobals(); });

it("settles only once the block's size has held, and at the latest after the cap", () => {
  const settled = vi.fn();
  watchSettled(document.createElement("div"), settled);
  vi.advanceTimersByTime(SETTLE_QUIET_MS - 10);
  resized[0]!();
  vi.advanceTimersByTime(SETTLE_QUIET_MS - 10);
  expect(settled).not.toHaveBeenCalled();
  vi.advanceTimersByTime(20);
  expect(settled).toHaveBeenCalledOnce();

  const capped = vi.fn();
  watchSettled(document.createElement("div"), capped);
  for (let at = 0; at < SETTLE_MAX_MS; at += SETTLE_QUIET_MS / 2) { resized.at(-1)!(); vi.advanceTimersByTime(SETTLE_QUIET_MS / 2); }
  expect(capped).toHaveBeenCalledOnce();
});

it("a pane whose parts load late is never seen at its first layout: rows that come and go do so while it is invisible", async () => {
  let load: () => void = () => {};
  function Pane() {
    const block = useRef<HTMLDivElement>(null);
    const shown = useSettledReveal(block);
    const [loaded, setLoaded] = useState(false);
    load = () => setLoaded(true);
    return createElement("div", { ref: block, "data-pane": "", style: { visibility: shown ? "visible" : "hidden" } },
      !loaded && createElement("p", { "data-checking": "" }, "checking"), createElement("button", { "data-advanced": "" }, "Advanced"));
  }
  root = createRoot(host);
  await act(async () => { root!.render(createElement(Pane)); });
  const pane = () => host.querySelector<HTMLElement>("[data-pane]")!;
  expect(pane().style.visibility).toBe("hidden");
  await act(async () => { vi.advanceTimersByTime(SETTLE_QUIET_MS / 2); load(); resized[0]!(); });
  expect(host.querySelector("[data-checking]")).toBeNull();
  expect(pane().style.visibility, "the row went before anyone saw it").toBe("hidden");
  await act(async () => { vi.advanceTimersByTime(SETTLE_QUIET_MS + 1); });
  expect(pane().style.visibility).toBe("visible");
});
