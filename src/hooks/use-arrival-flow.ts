import { useLayoutEffect, useRef, type RefObject } from "react";
import { probeMotion } from "@/lib/motion-probe";
import { cssBezier, pacedMs, pacedOut, springTiming, type SpringTiming } from "@/lib/motion-speed";
import { contentTop, readingInset, landingReply, replyHoldTop } from "@/lib/reply-hold";

import { usePrefersReducedMotion } from "@/components/mascot-clock";

const ARRIVAL = "[data-arrival]";

/** A new row with no entrance of its own (a card, a chip): inserted whole at full opacity, rising this far into place (px)
 * over ROW_ENTER_MS on ROW_ENTER_EASE. */
export const ROW_RISE_PX = 12;
export const ROW_ENTER_MS = 240;
export const ROW_ENTER_CURVE = [0.23, 1, 0.32, 1] as const;
export const ROW_ENTER_EASE = `cubic-bezier(${ROW_ENTER_CURVE.join(", ")})`;

/** A row that plays its own entrance (a bubble carried out of the composer, a reply growing out of the mascot): the
 * column still follows it, but it does not rise as well. */
export const OWN_ENTRANCE = "data-arrival-own";

export { springTiming, type SpringTiming } from "@/lib/motion-speed";

/** motion's { type: "spring", bounce, visualDuration } in stiffness and damping */
export function visualSpring(visualDuration: number, bounce = 0): SpringTiming {
  const root = (2 * Math.PI) / (visualDuration * 1.2);
  return springTiming(root * root, 2 * Math.min(1, Math.max(0.05, 1 - bounce)) * root);
}

/** How a transcript resting at its end follows a new row: one short ease that stops cleanly. A spring's long tail read
 * as the row landing and then creeping up a few more px. */
export const FOLLOW: SpringTiming = { duration: pacedMs(240), easing: cssBezier(pacedOut([0.25, 0.46, 0.45, 0.94])) };
/** The person's own send: the column follows on one short ease-out, the same one the bubble fades in on, and a send
 * that lands with room to spare rises SEND_RISE_PX instead. */
export const SEND_FLOW: SpringTiming = { duration: pacedMs(200), easing: cssBezier(pacedOut([0.22, 1, 0.36, 1])) };
export const SEND_RISE_PX = 8;

/** The column's glide from where the rows were drawn to where they now rest: `from` px below its place, back to 0. */
export function columnGlide(column: HTMLElement, from: number, timing: SpringTiming = FOLLOW): Animation | null {
  if (!canAnimate(column) || Math.abs(from) < 0.5) return null;
  return column.animate(
    [{ transform: `translateY(${from}px)` }, { transform: "translateY(0px)" }],
    { duration: timing.duration, easing: timing.easing },
  );
}

/** Adds a glide of `px` to whatever the column is already doing (composited, so a line arriving mid-glide extends it),
 * clipping the column meanwhile so its transform never stretches the scroll range. */
export function glideColumn(column: HTMLElement | null, clip: HTMLElement | null, px: number): void {
  if (!column || !canAnimate(column) || px < 0.5 || px > 400 || reducedMotionQuery()) return;
  if (clip) clip.style.overflowY = "clip";
  const anim = column.animate(
    [{ transform: `translateY(${px}px)` }, { transform: "translateY(0px)" }],
    { duration: FOLLOW.duration, easing: FOLLOW.easing, composite: "add" },
  );
  anim.addEventListener("finish", () => {
    if (clip && column.getAnimations().length === 0) clip.style.overflowY = "";
  });
}

const reducedMotionQuery = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How far below its place the column is drawn right now, mid-glide (px). */
function glideOffset(column: HTMLElement): number {
  const transform = getComputedStyle(column).transform;
  if (!transform || transform === "none") return 0;
  const match = /matrix(3d)?\(([^)]+)\)/.exec(transform);
  if (!match) return 0;
  const parts = match[2]!.split(",").map(Number);
  const y = match[1] ? parts[13] : parts[5];
  return Number.isFinite(y) ? y! : 0;
}

interface Snapshot {
  key: string;
  /** the furthest the transcript could scroll then, and where it was scrolled */
  max: number;
  top: number;
}

const canAnimate = (el: Element) => typeof (el as HTMLElement).animate === "function";

/** One row's entrance: a rise with no fade, no scale and no stagger. */
export function rowEnter(row: HTMLElement, send = false): Animation | null {
  if (!canAnimate(row)) return null;
  return row.animate(
    [{ transform: `translateY(${send ? SEND_RISE_PX : ROW_RISE_PX}px)` }, { transform: "translateY(0px)" }],
    send ? { duration: SEND_FLOW.duration, easing: SEND_FLOW.easing } : { duration: ROW_ENTER_MS, easing: ROW_ENTER_EASE },
  );
}

/** Rows that arrive while the conversation is open. A transcript resting at its end scrolls to the new end in the frame
 * the row is inserted and the column glides up from where it was drawn (columnGlide), so the rows already on screen
 * move smoothly; a row that lands with no glide rises into place (rowEnter) unless it plays its own entrance. The end stays pinned, with no glide, while
 * the composer changes height. A wrapper clips the column vertically while a row rises, so its transform never stretches the scroll range.
 * Scrolled up, nothing moves the view. Under reduced motion rows simply appear. */
export function useArrivalFlow({
  scrollRef,
  clipRef,
  columnRef,
  transcriptKey,
  following,
  onHold,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  clipRef: RefObject<HTMLElement | null>;
  columnRef: RefObject<HTMLElement | null>;
  transcriptKey: string;
  following: boolean;
  /** a reply taller than the view stopped the follow at its top */
  onHold?: () => void;
}): void {
  const reduced = usePrefersReducedMotion();
  const snapshot = useRef<Snapshot | null>(null);
  const rising = useRef(new Set<Animation>());
  const played = useRef(new WeakSet<Element>());
  const glide = useRef<Animation | null>(null);

  const take = (key: string): void => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    snapshot.current = { key, max: scroller.scrollHeight - scroller.clientHeight, top: scroller.scrollTop };
  };

  // a size change outside a render (an image loading, the window resizing) moves the end without an arrival: re-measure
  useLayoutEffect(() => {
    const scroller = scrollRef.current, column = columnRef.current;
    if (!scroller || !column || typeof ResizeObserver === "undefined") return;
    // the observer's first call, after the opened chat's first layout, takes its first snapshot; a scroll moves `top`
    const observer = new ResizeObserver(() => take(transcriptKey));
    observer.observe(column);
    observer.observe(scroller);
    const scrolled = () => take(transcriptKey);
    scroller.addEventListener("scroll", scrolled, { passive: true });
    return () => { observer.disconnect(); scroller.removeEventListener("scroll", scrolled); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- take reads refs only
  }, [scrollRef, columnRef, transcriptKey]);

  // a conversation left (or the transcript gone) drops whatever was still rising
  useLayoutEffect(() => {
    const all = rising.current;
    const clip = clipRef.current;
    return () => {
      for (const anim of all) anim.cancel();
      all.clear();
      glide.current?.cancel();
      glide.current = null;
      if (clip) clip.style.overflowY = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the ref object is stable; only the conversation matters
  }, [transcriptKey]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current, column = columnRef.current, clip = clipRef.current;
    if (!scroller || !column) return;
    const before = snapshot.current;
    const arrivals = [...column.querySelectorAll<HTMLElement>(ARRIVAL)].filter((row) => !played.current.has(row));
    arrivals.forEach((row) => played.current.add(row));
    if (import.meta.env.DEV && arrivals.some((row) => row.getAttribute("data-arrival") === "end")) probeMotion(scroller, column);
    // a render with no new row leaves the snapshot to the observer and the scroll listener: reading the transcript's size
    // here forced its whole style and layout on every render, four times over while a long chat opened; a chat's first
    // render still takes one
    if (arrivals.length === 0 && before?.key === transcriptKey) return;
    if (!before || before.key !== transcriptKey) {
      take(transcriptKey);
      return;
    }

    const max = scroller.scrollHeight - scroller.clientHeight;
    // a transcript resting at its end stays there; mid-scroll (a jump to the latest in progress) is left alone
    const atEnd = scroller.scrollTop >= Math.min(before.max, max) - 2;
    if (following && atEnd && scroller.scrollTop !== max) scroller.scrollTop = max;
    const reply = following && atEnd ? landingReply(arrivals) : null;
    const hold = reply && replyHoldTop({ replyTop: contentTop(scroller, reply, glideOffset(column)), inset: readingInset(scroller), end: max, current: before.top });
    if (hold !== null && hold !== undefined) {
      scroller.scrollTop = hold;
      onHold?.();
    }
    // what the rows added under a view that was resting at its end (another hook may already have pinned it there)
    const shift = before.top >= before.max - 2 ? Math.max(0, scroller.scrollTop - before.top) : 0;

    const track = (anim: Animation) => {
      if (clip) clip.style.overflowY = "clip";
      rising.current.add(anim);
      anim.addEventListener("finish", () => {
        rising.current.delete(anim);
        if (clip && rising.current.size === 0) clip.style.overflowY = "";
      });
    };
    // scrolled up, a new row lands below the view: nothing on screen moves
    if (!reduced && following && atEnd && arrivals.length > 0) {
      // the rows on screen glide up by what the arrivals added instead of jumping there in one frame; a glide still
      // running carries on from where it is drawn now
      const carried = glide.current ? glideOffset(column) : 0;
      if (glide.current) { glide.current.cancel(); rising.current.delete(glide.current); glide.current = null; }
      const send = arrivals.some((row) => row.getAttribute("data-arrival") === "end");
      const glided = columnGlide(column, shift + carried, send ? SEND_FLOW : FOLLOW);
      if (glided) {
        glide.current = glided;
        glided.addEventListener("finish", () => { if (glide.current === glided) glide.current = null; });
        track(glided);
      }
      // a row the column carries up needs no rise of its own; one landing with no glide (room already there) rises
      for (const row of glided ? [] : arrivals.filter((one) => !one.hasAttribute(OWN_ENTRANCE))) {
        const anim = rowEnter(row, row.getAttribute("data-arrival") === "end");
        if (anim) track(anim);
      }
    }
    if (clip && rising.current.size === 0) clip.style.overflowY = "";
    take(transcriptKey);
  });
}
