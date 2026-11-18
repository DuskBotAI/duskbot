import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

import { reducedMotion } from "./onboarding";

/** The bot panel's usual width. */
export const PANEL_NARROW = 320;
/** The narrowest a drag of the panel's edge leaves it. */
export const PANEL_MIN_WIDTH = 280;
/** The chat keeps at least this much beside a widened panel. */
const CHAT_KEEPS = 400;
const WIDE_MAX = 880;
const PANEL_WIDTH_KEY = "duskbot.panelWidth";

function storedWidth(): number {
  try {
    const stored = Number(globalThis.localStorage?.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) return Math.min(WIDE_MAX, Math.max(PANEL_MIN_WIDTH, stored));
  } catch {
  }
  return PANEL_NARROW;
}

let width = storedWidth();
/** The width a drag leaves the panel at, to come back to after the browser's expansion closes. */
let baseWidth = width;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => width;

/** The panel's width now: PANEL_NARROW, the width a drag left it at, or wider while the browser in it is expanded. */
export function usePanelWidth(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function panelWide(): boolean {
  return width > PANEL_NARROW;
}

/** About 60% of the room the chat and panel share, never squeezing the chat under CHAT_KEEPS. */
export function wideWidth(shared: number): number {
  return Math.round(Math.max(PANEL_NARROW, Math.min(WIDE_MAX, shared * 0.6, shared - CHAT_KEEPS)));
}

/** The room the chat and a docked panel share; a panel over the chat (a narrow window) has the window's. */
function sharedRoom(): number {
  const slot = document.querySelector<HTMLElement>("[data-panel-slot]");
  const chat = slot?.parentElement?.querySelector<HTMLElement>(":scope > main");
  if (slot && chat) return slot.getBoundingClientRect().right - chat.getBoundingClientRect().left;
  return window.innerWidth - 48;
}

/** The widest the panel may be in the room it shares with the chat. */
export function maxPanelWidth(): number {
  return Math.max(PANEL_MIN_WIDTH, Math.min(WIDE_MAX, sharedRoom() - CHAT_KEEPS));
}

function clamped(next: number): number {
  return Math.round(Math.min(maxPanelWidth(), Math.max(PANEL_MIN_WIDTH, next)));
}

function apply(next: number): void {
  width = next;
  document.documentElement.style.setProperty("--side-panel-w", `${next}px`);
  for (const listener of listeners) listener();
}

if (typeof document !== "undefined") document.documentElement.style.setProperty("--side-panel-w", `${width}px`);

function onResize(): void {
  if (panelWide()) apply(wideWidth(sharedRoom()));
}

/** The edge was dragged to `next`: the panel takes that width, and keeps it for the next open. */
export function setPanelWidth(next: number): number {
  const fitted = clamped(next);
  baseWidth = fitted;
  if (fitted !== width) apply(fitted);
  return fitted;
}

/** Keeps the width a drag left for the next open. */
export function savePanelWidth(): void {
  try {
    globalThis.localStorage?.setItem(PANEL_WIDTH_KEY, String(baseWidth));
  } catch {
  }
}

/** Fits the panel inside the room it shares with the chat, after a window resize or a smaller window opens it. */
export function fitPanelWidth(): void {
  const fitted = clamped(width);
  if (fitted !== width) apply(fitted);
}

/** Widens the panel beside the chat, or brings it back to the width a drag left. The chat and panel move as one spring
 * through a view transition, snapshots only, so the live page never lays out mid-motion; with less motion it simply
 * changes. */
export function setPanelWide(on: boolean): void {
  const next = on ? Math.max(baseWidth, wideWidth(sharedRoom())) : baseWidth;
  if (next === width) return;
  if (on) window.addEventListener("resize", onResize);
  else window.removeEventListener("resize", onResize);
  const root = document.documentElement;
  if (reducedMotion() || typeof document.startViewTransition !== "function") { apply(next); return; }
  root.classList.add("panel-widening");
  const transition = document.startViewTransition(() => flushSync(() => apply(next)));
  void transition.finished.finally(() => root.classList.remove("panel-widening"));
}
