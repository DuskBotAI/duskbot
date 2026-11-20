import { rubberband } from "../motion";

export const MAX_ZOOM = 4;
export const DOUBLE_TAP_ZOOM = 2.5;
const MIN_PINCH = 0.6;

export interface Size { w: number; h: number }
export interface Point { x: number; y: number }

/** A picture fitted inside the stage the way object-fit: contain draws it. */
export function fitted(natural: Size, stage: Size): Size {
  if (natural.w <= 0 || natural.h <= 0) return stage;
  const ratio = Math.min(stage.w / natural.w, stage.h / natural.h, 1);
  return { w: natural.w * ratio, h: natural.h * ratio };
}

/** How far a zoomed picture may move off centre before its edge leaves the stage's edge. */
export function panLimit(picture: Size, stage: Size, scale: number): Point {
  return { x: Math.max(0, (picture.w * scale - stage.w) / 2), y: Math.max(0, (picture.h * scale - stage.h) / 2) };
}

export function clampPan(pan: Point, limit: Point): Point {
  return { x: Math.max(-limit.x, Math.min(limit.x, pan.x)), y: Math.max(-limit.y, Math.min(limit.y, pan.y)) };
}

/** Past its limit a pan gives like a scroll view's edge. */
export function elasticPan(pan: Point, limit: Point): Point {
  const give = (value: number, max: number) => value > max ? max + rubberband(value - max, 120) : value < -max ? -max + rubberband(value + max, 120) : value;
  return { x: give(pan.x, limit.x), y: give(pan.y, limit.y) };
}

/** Pinching keeps the point that was under the fingers' midpoint under it. `focus` and `pan` are from the stage centre. */
export function pinchTo(start: { scale: number; pan: Point; focus: Point }, focus: Point, ratio: number): { scale: number; pan: Point } {
  const raw = start.scale * ratio;
  const scale = raw < 1 ? Math.max(MIN_PINCH, 1 - rubberband(1 - raw, 0.4)) : raw > MAX_ZOOM ? MAX_ZOOM + rubberband(raw - MAX_ZOOM, 1) : raw;
  const content = { x: (start.focus.x - start.pan.x) / start.scale, y: (start.focus.y - start.pan.y) / start.scale };
  return { scale, pan: { x: focus.x - scale * content.x, y: focus.y - scale * content.y } };
}

/** A double tap zooms in on the tapped point, or back out. */
export function doubleTapZoom(scale: number, at: Point, picture: Size, stage: Size): { scale: number; pan: Point } {
  if (scale > 1.01) return { scale: 1, pan: { x: 0, y: 0 } };
  const next = DOUBLE_TAP_ZOOM;
  return { scale: next, pan: clampPan({ x: at.x * (1 - next), y: at.y * (1 - next) }, panLimit(picture, stage, next)) };
}

/** Which way a one-finger drag on an unzoomed picture goes once it moves past the slop. */
export function dragAxis(dx: number, dy: number, pages: number): "page" | "dismiss" {
  return pages > 1 && Math.abs(dx) > Math.abs(dy) ? "page" : "dismiss";
}

/** A swipe turns the page when it travelled a quarter of the width or was flicked. */
export function pageStep(dx: number, vx: number, width: number): -1 | 0 | 1 {
  if (Math.abs(dx) < 12) return 0;
  if (dx < -width * 0.25 || vx < -500) return 1;
  if (dx > width * 0.25 || vx > 500) return -1;
  return 0;
}

/** A pull away from the picture closes it past 120pt or with a flick that way. */
export function dismisses(dy: number, vy: number): boolean {
  return Math.abs(dy) > 120 || (Math.abs(vy) > 800 && Math.sign(vy) === Math.sign(dy));
}
