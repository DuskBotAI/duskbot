// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { feel, springEasing, springPath } from "./motion";
import { placeContextMenu } from "./ContextMenu";
import { cardRowTarget, installPress, pressScale, pressTarget } from "./press";

const view = { width: 393, height: 852 };

describe("springEasing", () => {
  it("ends at rest and gives a little past it for the press release", () => {
    const { duration, easing } = springEasing(feel.press.release.stiffness, feel.press.release.damping);
    const points = easing.slice("linear(".length, -1).split(",").map(Number);
    expect(points.at(-1)).toBe(1);
    expect(Math.max(...points)).toBeGreaterThan(1);
    expect(Math.max(...points)).toBeLessThan(1.12);
    expect(duration).toBeGreaterThan(150);
    expect(duration).toBeLessThan(700);
  });

  it("never overshoots when critically damped", () => {
    const points = springEasing(400, 40).easing.slice("linear(".length, -1).split(",").map(Number);
    expect(Math.max(...points)).toBeLessThanOrEqual(1);
  });
});

describe("springPath", () => {
  it("pushes a page in from the edge without overshoot and lands exactly", () => {
    const { duration, points } = springPath(440, 0, 0, { stiffness: 380, damping: 39 });
    expect(points[0]).toBe(440);
    expect(points.at(-1)).toBe(0);
    expect(Math.min(...points)).toBeGreaterThanOrEqual(0);
    expect(points.every((p, i) => i === 0 || p <= points[i - 1]!)).toBe(true);
    expect(duration).toBeGreaterThan(300);
    expect(duration).toBeLessThan(700);
  });

  it("carries a flick's speed into the first frame", () => {
    const flung = springPath(200, 440, 2000, { stiffness: 440, damping: 40 });
    const still = springPath(200, 440, 0, { stiffness: 440, damping: 40 });
    expect(flung.points[1]! - 200).toBeGreaterThan(still.points[1]! - 200 + 20);
    expect(flung.points.at(-1)).toBe(440);
  });

  it("follows an underdamped spring past its target and back", () => {
    const { points } = springPath(0, 100, 0, { stiffness: 500, damping: 18 });
    expect(Math.max(...points)).toBeGreaterThan(100);
    expect(points.at(-1)).toBe(100);
  });
});

describe("placeContextMenu", () => {
  it("keeps a held item in place with room for its reactions above and actions below", () => {
    const at = placeContextMenu({ top: 300, left: 16, width: 240, height: 60 }, 3, view, { reactions: 6 });
    expect(at.top).toBe(300);
    expect(at.barTop).toBeLessThan(at.top);
    expect(at.menuTop).toBeGreaterThan(at.top + at.height);
    expect(at.above).toBe(false);
  });

  it("moves the item up near the bottom of the screen so the actions fit under it", () => {
    const at = placeContextMenu({ top: 700, left: 16, width: 240, height: 60 }, 6, view, { reactions: 6 });
    expect(at.menuTop + 6 * 46 + 12).toBeLessThanOrEqual(view.height - 34);
    expect(at.barTop).toBeGreaterThanOrEqual(54);
  });

  it("opens the actions above a row near the bottom when there are no reactions", () => {
    const at = placeContextMenu({ top: 700, left: 8, width: 377, height: 76 }, 3, view);
    expect(at.above).toBe(true);
    expect(at.menuTop + 3 * 46 + 12).toBeLessThanOrEqual(at.top);
  });

  it("cuts a message taller than the room left, and lines menus up with a sent message's right edge", () => {
    const at = placeContextMenu({ top: 80, left: 120, width: 260, height: 900 }, 6, view, { reactions: 6, end: true });
    expect(at.height).toBeLessThan(900);
    expect(at.menuLeft + 250).toBeLessThanOrEqual(view.width - 12);
    expect(at.barLeft + at.barW).toBeLessThanOrEqual(120 + 260);
  });
});

describe("press", () => {
  it("presses small controls further than wide rows", () => {
    expect(pressScale(44)).toBe(feel.press.scale);
    expect(pressScale(377)).toBe(feel.press.wide);
  });

  it("finds the control under the finger, skipping ones that press on their own or are disabled", () => {
    document.body.innerHTML = `<div id="root">
      <button id="plain"><span id="inner">a</span></button>
      <button id="own" class="mobile-press">b</button>
      <button id="off" disabled>c</button>
      <div id="held" data-long-press><span id="row">d</span></div>
      <p id="text">e</p>
    </div>`;
    const root = document.getElementById("root")!;
    expect(pressTarget(document.getElementById("inner"), root)?.id).toBe("plain");
    expect(pressTarget(document.getElementById("own"), root)).toBeNull();
    expect(pressTarget(document.getElementById("off"), root)).toBeNull();
    expect(pressTarget(document.getElementById("row"), root)).toBeNull();
    expect(pressTarget(document.getElementById("text"), root)).toBeNull();
  });

  it("highlights grouped card rows after a hold without scaling, and clears immediately when scrolling", () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = `<div id="root">
        <div data-settings-card="">
          <button id="row" class="mobile-row"><span>Text size</span></button>
          <button id="sw" role="switch" class="mobile-row">Haptics</button>
        </div>
      </div>`;
      const root = document.getElementById("root")!;
      const row = document.getElementById("row")!;
      const sw = document.getElementById("sw")!;
      expect(pressTarget(row, root)).toBeNull();
      expect(cardRowTarget(row, root)).toBe(row);
      expect(cardRowTarget(sw, root)).toBeNull();

      const stop = installPress(root);
      row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 100, clientY: 200 }));
      expect(row.hasAttribute("data-row-highlighted")).toBe(false);
      vi.advanceTimersByTime(100);
      expect(row.hasAttribute("data-row-highlighted")).toBe(true);

      // dragging/scrolling while holding clears the highlight at once
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 100, clientY: 220 }));
      expect(row.hasAttribute("data-row-highlighted")).toBe(false);

      // quick tap flashes briefly then fades back out
      row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 100, clientY: 200 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 100, clientY: 200 }));
      expect(row.hasAttribute("data-row-highlighted")).toBe(true);
      vi.advanceTimersByTime(80);
      expect(row.hasAttribute("data-row-highlighted")).toBe(false);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
