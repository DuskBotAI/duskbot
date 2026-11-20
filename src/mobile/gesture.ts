import { useEffect, useRef, type RefObject } from "react";
import { velocityTracker } from "./motion";

export interface DragState {
  dx: number;
  dy: number;
  vx: number;
  vy: number;
  /** The element the finger first touched. */
  target: EventTarget | null;
}

export interface DragHandlers {
  axis: "x" | "y";
  /** Decide, once the finger has moved past the slop, whether this gesture is ours. Return false to let the page have it. */
  claim: (state: DragState, start: { x: number; y: number }) => boolean;
  onStart?: (state: DragState) => void;
  onMove: (state: DragState) => void;
  onEnd: (state: DragState) => void;
  onCancel?: (state: DragState) => void;
  enabled?: boolean;
}

const SLOP = 8;

/** One-finger drag on `ref`, locked to `axis` once it moves past an 8px slop. Touch drives it on phones: once claimed,
 * touchmove is cancelled so a scroller underneath does not move with the finger. A mouse drives it in the web preview. */
export function useDrag(ref: RefObject<HTMLElement | null>, handlers: DragHandlers) {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const el = ref.current;
    if (!el || handlers.enabled === false) return;
    const tracker = velocityTracker();
    let start: { x: number; y: number } | null = null;
    let target: EventTarget | null = null;
    let phase: "idle" | "pending" | "claimed" | "refused" = "idle";
    let mouseId: number | null = null;

    const state = (x: number, y: number): DragState => {
      const v = tracker.velocity();
      return { dx: x - start!.x, dy: y - start!.y, vx: v.x, vy: v.y, target };
    };
    const begin = (x: number, y: number, t: EventTarget | null) => {
      start = { x, y };
      target = t;
      phase = "pending";
      tracker.reset(x, y);
    };
    /** True while this gesture owns the finger. */
    const move = (x: number, y: number): boolean => {
      if (!start || phase === "refused" || phase === "idle") return false;
      tracker.push(x, y);
      const s = state(x, y);
      if (phase === "pending") {
        const along = latest.current.axis === "x" ? Math.abs(s.dx) : Math.abs(s.dy);
        const across = latest.current.axis === "x" ? Math.abs(s.dy) : Math.abs(s.dx);
        if (Math.max(along, across) < SLOP) return false;
        if (along < across * 1.15 || !latest.current.claim(s, start)) {
          phase = "refused";
          return false;
        }
        phase = "claimed";
        latest.current.onStart?.(s);
      }
      latest.current.onMove(s);
      return true;
    };
    const end = (x: number, y: number, cancelled: boolean) => {
      if (phase === "claimed") {
        tracker.push(x, y);
        const s = state(x, y);
        if (cancelled && latest.current.onCancel) latest.current.onCancel(s);
        else latest.current.onEnd(s);
      }
      phase = "idle";
      start = null;
    };

    const last = { x: 0, y: 0 };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) { if (phase === "claimed") end(last.x, last.y, true); phase = "refused"; return; }
      const touch = event.touches[0];
      last.x = touch.clientX; last.y = touch.clientY;
      begin(touch.clientX, touch.clientY, event.target);
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      last.x = touch.clientX; last.y = touch.clientY;
      if (move(touch.clientX, touch.clientY) && event.cancelable) event.preventDefault();
    };
    const onTouchEnd = () => end(last.x, last.y, false);
    const onTouchCancel = () => end(last.x, last.y, true);

    const onMouseDown = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      mouseId = event.pointerId;
      begin(event.clientX, event.clientY, event.target);
    };
    const onMouseMove = (event: PointerEvent) => {
      if (event.pointerId !== mouseId) return;
      if (move(event.clientX, event.clientY)) {
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
      }
    };
    const onMouseUp = (event: PointerEvent) => {
      if (event.pointerId !== mouseId) return;
      mouseId = null;
      const claimed = phase === "claimed";
      end(event.clientX, event.clientY, false);
      // the click that ends a drag is not a tap on whatever sits under the cursor
      if (claimed) window.addEventListener("click", (click) => { click.stopPropagation(); click.preventDefault(); }, { capture: true, once: true });
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchCancel);
    el.addEventListener("pointerdown", onMouseDown);
    window.addEventListener("pointermove", onMouseMove);
    window.addEventListener("pointerup", onMouseUp);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchCancel);
      el.removeEventListener("pointerdown", onMouseDown);
      window.removeEventListener("pointermove", onMouseMove);
      window.removeEventListener("pointerup", onMouseUp);
    };
  }, [ref, handlers.enabled]);
}

/** Whether something under `target` (up to `root`) can still scroll toward `direction` on `axis`: then the finger is
 * scrolling it, not dragging the page. */
export function canScroll(target: EventTarget | null, root: HTMLElement, axis: "x" | "y", direction: -1 | 1): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== root) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node);
      const overflow = axis === "x" ? style.overflowX : style.overflowY;
      if (overflow === "auto" || overflow === "scroll") {
        const pos = axis === "x" ? Math.abs(node.scrollLeft) : node.scrollTop;
        const max = axis === "x" ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight;
        if (max > 1 && (direction < 0 ? pos > 0.5 : pos < max - 0.5)) return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

/** Text fields, sliders and canvases keep their own drags, and so does text being selected. */
export function ownsDrag(target: EventTarget | null): boolean {
  return target instanceof Element && (Boolean(target.closest("input, textarea, select, [contenteditable='true'], canvas, [data-no-swipe], [role='slider']")) || selectingIn(target));
}

/** A finger moving over viewer text that holds a selection is dragging that selection, not the sheet under it. */
export function selectingIn(target: Element): boolean {
  const area = target.closest("[data-selectable]");
  const selection = area ? window.getSelection() : null;
  return Boolean(selection && !selection.isCollapsed && selection.anchorNode && area!.contains(selection.anchorNode));
}
