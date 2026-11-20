// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Message } from "@/state/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
const { FIRST_PAINT_ROWS, useFirstPaintRows } = await import("./ChatView");

const rows: Message[] = Array.from({ length: 60 }, (_, index) => ({ id: `m${index}`, role: "bot", kind: "text", text: `${index}`, at: index }));

it("keeps a chat held at its newest row there in the same commit that mounts older rows above it", async () => {
  const scroller = document.createElement("div");
  let height = 1_000;
  Object.defineProperty(scroller, "scrollHeight", { get: () => height });
  Object.defineProperty(scroller, "clientHeight", { get: () => 600 });
  const seen: Array<{ painted: number; top: number }> = [];
  function Probe() {
    const ref = useRef<HTMLElement | null>(scroller);
    const painted = useFirstPaintRows("bot:thread", rows, false, ref, true);
    height = 1_000 + painted.length * 100;
    seen.push({ painted: painted.length, top: scroller.scrollTop });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe)));
  expect(seen[0]!.painted).toBe(FIRST_PAINT_ROWS);
  expect(seen.at(-1)!.painted).toBe(rows.length);
  expect(scroller.scrollTop).toBe(1_000 + rows.length * 100);
  act(() => root.unmount());
});

it("checks whether the first paint fills the view once, not again as each step mounts more rows", async () => {
  const scroller = document.createElement("div");
  let reads = 0;
  Object.defineProperty(scroller, "scrollHeight", { get: () => { reads += 1; return 5_000; } });
  Object.defineProperty(scroller, "clientHeight", { get: () => 600 });
  function Probe() {
    const ref = useRef<HTMLElement | null>(scroller);
    useFirstPaintRows("bot:thread", rows, false, ref, false);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe)));
  expect(reads, "each read forces the chat's whole style and layout").toBe(1);
  act(() => root.unmount());
});
