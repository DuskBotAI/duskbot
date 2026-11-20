import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Simple: the pill's height in pixels, set from its content in the same frame the content changes. Opening to the
 * expanded layout and closing back to one row animate on the pill's spring; once open, the pill follows its text at
 * once, as grok's composer does (`heightSnap`), and so does an expansion made while an input method is composing.
 */
export function usePillHeight(shellRef: RefObject<HTMLDivElement | null>, contentRef: RefObject<HTMLDivElement | null>, on: boolean, expanded: boolean, composing = false): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);
  const live = useRef<{ expanded: boolean; composing: boolean; settled: boolean } | null>(null);
  live.current ??= { expanded, composing, settled: expanded };
  live.current.expanded = expanded;
  live.current.composing = composing;
  const measureRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const content = contentRef.current;
    if (!on || !shell || !content || typeof ResizeObserver === "undefined") {
      measureRef.current = null;
      setHeight(undefined);
      return;
    }
    let last: number | undefined;
    let settle = 0;
    const done = () => {
      window.clearTimeout(settle);
      delete shell.dataset.growing;
      if (live.current?.expanded) live.current.settled = true;
    };
    const measure = () => {
      const state = live.current;
      if (!state) return;
      if (!state.expanded) state.settled = false;
      else if (state.composing) state.settled = true;
      const snap = state.expanded && state.settled;
      if (snap) shell.dataset.snap = "";
      else delete shell.dataset.snap;
      const style = getComputedStyle(shell);
      const next = Math.ceil(content.offsetHeight + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0));
      if (next === last) return;
      if (last !== undefined && !snap) {
        if (next > last) shell.dataset.growing = "";
        window.clearTimeout(settle);
        settle = window.setTimeout(done, 400);
      }
      last = next;
      setHeight(next);
    };
    const ended = (event: TransitionEvent) => {
      if (event.target === shell && event.propertyName === "height") done();
    };
    measureRef.current = measure;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    shell.addEventListener("transitionend", ended);
    shell.addEventListener("transitioncancel", ended);
    return () => {
      measureRef.current = null;
      observer.disconnect();
      shell.removeEventListener("transitionend", ended);
      shell.removeEventListener("transitioncancel", ended);
      window.clearTimeout(settle);
      delete shell.dataset.growing;
      delete shell.dataset.snap;
    };
  }, [shellRef, contentRef, on]);
  // a resize observer reports a frame late; measuring after every render starts the pill with its content
  useLayoutEffect(() => measureRef.current?.());
  return on ? height : undefined;
}

/**
 * Advanced: a message past one line takes the composer's full width above the buttons instead of wrapping in the gap
 * between them. `wrapAt` is the length at which the one-row field wrapped; the field goes back beside the buttons
 * only below it, so wider text on its own line cannot flip back and forth. With `holdUntilEmpty` (Simple, as grok's
 * composer) it stays stacked until the field is empty.
 */
export function useStackedField(inputRef: RefObject<HTMLTextAreaElement | null>, on: boolean, text: string, holdUntilEmpty = false): boolean {
  const [wrapAt, setWrapAt] = useState<number | null>(null);
  const [held, setHeld] = useState(false);
  const stacked = on && (text.includes("\n") || (wrapAt !== null && text.length >= wrapAt) || (holdUntilEmpty && held && text.length > 0));
  const holds = holdUntilEmpty && stacked;
  if (holds !== held) setHeld(holds);
  // Width changes (a resized window, a panel opening) can wrap the one-row field too, so watch its size, not just the text.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!on || stacked || !input || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // An empty field's height is its placeholder's, which may wrap; that is not a message. The next message measures afresh.
      if (!input.value) return setWrapAt(null);
      const style = getComputedStyle(input);
      const line = parseFloat(style.lineHeight) || 24;
      const content = input.scrollHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
      if (content > line * 1.5) setWrapAt(input.value.length);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(input);
    return () => observer.disconnect();
  }, [inputRef, on, stacked, text]);
  return stacked;
}

export function movesLess(): boolean {
  if (document.documentElement.dataset.reducedMotion === "true") return true;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Slides an element from where it was to where it is whenever `key` changes, on the pill's own spring. Its box is read
 * only when `key` changes: once while rendering, before React moves anything, and once after; a box read on every commit
 * forced a layout of the whole page each time a chat's rows mounted. */
export function useSlideOnChange(target: () => HTMLElement | null | undefined, key: unknown, on: boolean): void {
  const lastKey = useRef(key);
  const before = useRef<DOMRect | null>(null);
  const element = useRef(target);
  element.current = target;
  if (lastKey.current !== key) {
    lastKey.current = key;
    before.current = on && typeof document !== "undefined" && !movesLess() ? target()?.getBoundingClientRect() ?? null : null;
  }
  useLayoutEffect(() => {
    const from = before.current;
    before.current = null;
    const moved = element.current();
    if (!from || !moved || typeof moved.animate !== "function") return;
    const rect = moved.getBoundingClientRect();
    const dx = from.left - rect.left;
    const dy = from.top - rect.top;
    if (!dx && !dy) return;
    const easing = getComputedStyle(document.documentElement).getPropertyValue("--composer-spring").trim() || "ease-out";
    moved.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 300, easing });
  }, [key]);
}
