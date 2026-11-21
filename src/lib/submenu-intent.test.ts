import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SUBMENU_DWELL_MS, SUBMENU_EDGE_PAD, SUBMENU_GRACE_MS, submenuBridgeBox, submenuIntent, towardSubmenu } from "./submenu-intent";

const submenu = { left: 300, right: 500, top: 100, bottom: 300 };

function setup() {
  const events: string[] = [];
  const aiming: boolean[] = [];
  const intent = submenuIntent({
    open: (key) => events.push(`open ${key}`),
    close: () => events.push("close"),
    submenuBox: () => submenu,
    onAimingChange: (next) => aiming.push(next),
  });
  const dwellOpen = (key = "support", point = { x: 200, y: 150 }) => {
    intent.enterRow(key, true, point);
    vi.advanceTimersByTime(SUBMENU_DWELL_MS);
  };
  return { intent, events, aiming, dwellOpen };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("submenu hover intent", () => {
  it("does not open a submenu the pointer only passes through", () => {
    const { intent, events } = setup();
    intent.enterRow("support", true, { x: 200, y: 150 });
    vi.advanceTimersByTime(90);
    intent.leaveRow("support");
    intent.enterRow("settings", false, { x: 200, y: 184 });
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
  });

  it("opens once the pointer rests on the row for the dwell time", () => {
    const { intent, events } = setup();
    intent.enterRow("support", true, { x: 200, y: 150 });
    vi.advanceTimersByTime(SUBMENU_DWELL_MS - 1);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(["open support"]);
    expect(intent.openKey).toBe("support");
  });

  it("closes at once when the pointer enters a sibling row that is not on the way to the submenu", () => {
    const { intent, events, dwellOpen } = setup();
    dwellOpen();
    intent.enterRow("settings", false, { x: 200, y: 184 });
    expect(events).toEqual(["open support", "close"]);
    expect(intent.openKey).toBeNull();
  });

  it("swaps to a sibling submenu only after its own dwell", () => {
    const { intent, events, dwellOpen } = setup();
    dwellOpen();
    intent.enterRow("phone", true, { x: 200, y: 220 });
    expect(events).toEqual(["open support", "close"]);
    vi.advanceTimersByTime(SUBMENU_DWELL_MS);
    expect(events).toEqual(["open support", "close", "open phone"]);
  });

  it("keeps the submenu open while the pointer heads into it, for the grace period at most", () => {
    const { intent, events, dwellOpen } = setup();
    dwellOpen();
    intent.move({ x: 220, y: 150 }, true);
    intent.enterRow("settings", false, { x: 260, y: 170 });
    vi.advanceTimersByTime(SUBMENU_GRACE_MS - 1);
    expect(events).toEqual(["open support"]);
    intent.enterSubmenu();
    vi.advanceTimersByTime(1000);
    expect(events).toEqual(["open support"]);

    const late = setup();
    late.dwellOpen();
    late.intent.move({ x: 220, y: 150 }, true);
    late.intent.enterRow("settings", false, { x: 260, y: 170 });
    vi.advanceTimersByTime(SUBMENU_GRACE_MS);
    expect(late.events).toEqual(["open support", "close"]);
  });

  it("closes during the grace period as soon as the pointer turns away from the submenu", () => {
    const { intent, events, dwellOpen } = setup();
    dwellOpen();
    intent.move({ x: 220, y: 150 }, true);
    intent.enterRow("settings", false, { x: 260, y: 170 });
    intent.move({ x: 230, y: 240 }, false);
    expect(events).toEqual(["open support", "close"]);
  });

  it("opens and closes at once from a click or the keyboard", () => {
    const { intent, events } = setup();
    intent.openNow("support");
    expect(events).toEqual(["open support"]);
    intent.closeNow();
    expect(events).toEqual(["open support", "close"]);
    intent.closeNow();
    expect(events).toEqual(["open support", "close"]);
  });

  it("forgets a pending dwell when the pointer leaves the menu", () => {
    const { intent, events } = setup();
    intent.enterRow("support", true, { x: 200, y: 150 });
    intent.leaveMenu();
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
  });
});

describe("a slow diagonal path", () => {
  it("keeps the submenu open while the pointer keeps moving inside the triangle", () => {
    const { intent, events, dwellOpen } = setup();
    dwellOpen();
    intent.move({ x: 200, y: 150 }, true);
    intent.leaveRow("support");
    intent.enterRow("settings", false, { x: 215, y: 170 });
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(SUBMENU_GRACE_MS - 50);
      intent.move({ x: 225 + i * 12, y: 175 + i * 8 }, false);
    }
    expect(events).toEqual(["open support"]);
    vi.advanceTimersByTime(SUBMENU_GRACE_MS);
    expect(events).toEqual(["open support", "close"]);
  });
});

describe("towardSubmenu", () => {
  it("is true inside the corridor from the pointer to the submenu's near edge, on either side", () => {
    expect(towardSubmenu({ x: 200, y: 150 }, { x: 260, y: 170 }, submenu)).toBe(true);
    expect(towardSubmenu({ x: 200, y: 150 }, { x: 200, y: 200 }, submenu)).toBe(false);
    expect(towardSubmenu({ x: 200, y: 150 }, { x: 150, y: 150 }, submenu)).toBe(false);
    const left = { left: 0, right: 100, top: 100, bottom: 300 };
    expect(towardSubmenu({ x: 200, y: 150 }, { x: 150, y: 160 }, left)).toBe(true);
    expect(towardSubmenu({ x: 200, y: 150 }, { x: 250, y: 160 }, left)).toBe(false);
  });

  it("tolerates steep diagonal starts across a row gap and slight vertical graze past the submenu edge", () => {
    const tight = { left: 274, right: 454, top: 100, bottom: 222 };
    expect(towardSubmenu({ x: 158, y: 131 }, { x: 162, y: 136 }, tight)).toBe(true);
    expect(towardSubmenu({ x: 158, y: 102 }, { x: 164, y: 97 }, tight)).toBe(true);
    expect(towardSubmenu({ x: 158, y: 131 }, { x: 158, y: 145 }, tight)).toBe(false);
    expect(towardSubmenu({ x: 158, y: 131 }, { x: 160, y: 155 }, tight)).toBe(false);
    expect(towardSubmenu({ x: 158, y: 131 }, { x: 162, y: 136 }, { left: 0, right: 0, top: 0, bottom: 0 })).toBe(false);
  });
});

describe("aiming lifecycle and stale anchors", () => {
  it("anchors on dwell and click so an immediate diagonal exit stays open", () => {
    const dwelled = setup();
    dwelled.dwellOpen("move", { x: 200, y: 150 });
    dwelled.intent.enterRow("row", false, { x: 230, y: 170 });
    expect(dwelled.events).toEqual(["open move"]);
    expect(dwelled.aiming).toEqual([true]);
    dwelled.intent.enterSubmenu();
    expect(dwelled.aiming).toEqual([true, false]);

    const clicked = setup();
    clicked.intent.openNow("move", { x: 200, y: 150 });
    clicked.intent.enterRow("row", false, { x: 230, y: 170 });
    expect(clicked.events).toEqual(["open move"]);
    expect(clicked.aiming).toEqual([true]);
  });

  it("closes immediately when returning from the submenu onto a sibling row", () => {
    const { intent, events, dwellOpen } = setup();
    dwellOpen("move", { x: 200, y: 150 });
    intent.enterRow("row", false, { x: 240, y: 170 });
    intent.enterSubmenu();
    intent.enterRow("row", false, { x: 260, y: 190 });
    expect(events).toEqual(["open move", "close"]);
  });

  it("keeps grace alive when leaving the parent menu toward a taller submenu, and closes when leaving away", () => {
    const toward = setup();
    toward.dwellOpen("support", { x: 200, y: 150 });
    toward.intent.leaveMenu({ x: 260, y: 240 });
    vi.advanceTimersByTime(SUBMENU_GRACE_MS - 1);
    expect(toward.events).toEqual(["open support"]);
    toward.intent.enterSubmenu();
    vi.advanceTimersByTime(SUBMENU_GRACE_MS);
    expect(toward.events).toEqual(["open support"]);

    const away = setup();
    away.dwellOpen("support", { x: 200, y: 150 });
    away.intent.leaveMenu({ x: 180, y: 240 });
    vi.advanceTimersByTime(0);
    expect(away.events).toEqual(["open support", "close"]);
  });
});

describe("submenuBridgeBox", () => {
  const menu = { left: 50, right: 270, top: 20, bottom: 360 };
  const row = { left: 56, right: 264, top: 100, bottom: 132 };

  it("covers the gap on either side with subpixel overlap and vertical edge padding", () => {
    expect(submenuBridgeBox(menu, row, { left: 274, right: 454, top: 100, bottom: 222 })).toEqual({
      left: 269,
      top: 100 - SUBMENU_EDGE_PAD,
      width: 6,
      height: 122 + SUBMENU_EDGE_PAD * 2,
    });
    expect(submenuBridgeBox({ left: 900, right: 1120, top: 20, bottom: 360 }, row, { left: 716, right: 896, top: 100, bottom: 222 })).toEqual({
      left: 895,
      top: 100 - SUBMENU_EDGE_PAD,
      width: 6,
      height: 122 + SUBMENU_EDGE_PAD * 2,
    });
  });

  it("returns null when overlapping or unmeasured", () => {
    expect(submenuBridgeBox(menu, row, { left: 260, right: 440, top: 100, bottom: 222 })).toBeNull();
    expect(submenuBridgeBox(menu, row, { left: 0, right: 0, top: 0, bottom: 0 })).toBeNull();
  });
});
