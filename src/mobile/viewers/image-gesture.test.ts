import { describe, expect, it } from "vitest";
import { clampPan, dismisses, doubleTapZoom, dragAxis, fitted, MAX_ZOOM, pageStep, panLimit, pinchTo } from "./image-gesture";

const stage = { w: 400, h: 800 };

describe("picture viewer gestures", () => {
  it("fits a picture inside the stage without growing a small one", () => {
    expect(fitted({ w: 2000, h: 1000 }, stage)).toEqual({ w: 400, h: 200 });
    expect(fitted({ w: 100, h: 50 }, stage)).toEqual({ w: 100, h: 50 });
  });

  it("lets a zoomed picture move only as far as its edges reach", () => {
    const limit = panLimit({ w: 400, h: 200 }, stage, 2);
    expect(limit).toEqual({ x: 200, y: 0 });
    expect(clampPan({ x: 500, y: 40 }, limit)).toEqual({ x: 200, y: 0 });
  });

  it("keeps the pinched point under the fingers", () => {
    const start = { scale: 1, pan: { x: 0, y: 0 }, focus: { x: 50, y: -20 } };
    const next = pinchTo(start, { x: 50, y: -20 }, 2);
    expect(next.scale).toBe(2);
    expect(next.pan.x + next.scale * 50).toBeCloseTo(50);
    expect(next.pan.y + next.scale * -20).toBeCloseTo(-20);
  });

  it("gives past the zoom limits instead of stopping dead", () => {
    const start = { scale: 1, pan: { x: 0, y: 0 }, focus: { x: 0, y: 0 } };
    expect(pinchTo(start, { x: 0, y: 0 }, 10).scale).toBeGreaterThan(MAX_ZOOM);
    expect(pinchTo(start, { x: 0, y: 0 }, 10).scale).toBeLessThan(MAX_ZOOM + 1);
    expect(pinchTo(start, { x: 0, y: 0 }, 0.1).scale).toBeGreaterThan(0.5);
  });

  it("double tap zooms in on the tapped point and back out", () => {
    const zoomed = doubleTapZoom(1, { x: 40, y: 0 }, { w: 400, h: 300 }, stage);
    expect(zoomed.scale).toBeGreaterThan(1);
    expect(zoomed.pan.x).toBeLessThan(0);
    expect(doubleTapZoom(zoomed.scale, { x: 0, y: 0 }, { w: 400, h: 300 }, stage)).toEqual({ scale: 1, pan: { x: 0, y: 0 } });
  });

  it("swipes sideways between pictures and pulls one away to close", () => {
    expect(dragAxis(30, 5, 3)).toBe("page");
    expect(dragAxis(30, 5, 1)).toBe("dismiss");
    expect(dragAxis(5, 30, 3)).toBe("dismiss");
    expect(pageStep(-150, 0, 400)).toBe(1);
    expect(pageStep(40, 900, 400)).toBe(-1);
    expect(pageStep(-40, -100, 400)).toBe(0);
    expect(dismisses(140, 0)).toBe(true);
    expect(dismisses(40, 1200)).toBe(true);
    expect(dismisses(40, -1200)).toBe(false);
  });
});
