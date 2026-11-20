import assert from "node:assert/strict";
import test from "node:test";
import { DOCK, ISLAND_SIZES, ISLAND_WINDOW, PILL_TOP, dockEdge, dockLayout, islandLayout, notchOf, pickDisplay } from "./ambient-geometry.mjs";

const display = (fields) => ({ id: 1, internal: false, label: "", bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 }, ...fields });
const builtIn = display({ id: 1, internal: true, label: "Built-in Liquid Retina XDR Display" });
const external = display({ id: 2, bounds: { x: 1512, y: -200, width: 2560, height: 1440 }, workArea: { x: 1512, y: -175, width: 2560, height: 1415 } });

test("a built-in display with a notch-tall menu bar has a notch, and the island is never narrower than it", () => {
  const notch = notchOf(builtIn, "darwin");
  assert.deepEqual(notch, { width: 177, height: 37, housing: { width: 177, height: 31 } });
  for (const size of Object.keys(ISLAND_SIZES)) {
    const { collapsed } = islandLayout(builtIn, { platform: "darwin", size });
    assert.equal(collapsed.kind, "notch");
    assert.equal(collapsed.top, 0);
    assert.equal(collapsed.height, 37);
    assert.ok(collapsed.width >= notch.width + 2 * ISLAND_SIZES.small.side);
  }
});

// NSScreen on a 16 inch MacBook Pro at 1728 x 1117: the housing runs from 771.5 to 956.5 and is 32 pt tall
const sixteen = display({ id: 1, internal: true, label: "Built-in Retina Display", bounds: { x: 0, y: 0, width: 1728, height: 1117 }, workArea: { x: 0, y: 38, width: 1728, height: 1079 } });
const housing16 = { width: 185, height: 32 };

test("at rest the island hides inside the camera housing AppKit measured, never past its sides or below it", () => {
  for (const size of Object.keys(ISLAND_SIZES)) {
    const { collapsed } = islandLayout(sixteen, { platform: "darwin", size, measured: housing16 });
    assert.ok(collapsed.notch < housing16.width && collapsed.notch >= housing16.width - 2, `${size} ${collapsed.notch}`);
    assert.ok(collapsed.notchHeight < housing16.height && collapsed.notchHeight >= housing16.height - 1, `${size} ${collapsed.notchHeight}`);
    // awake it still fills the menu bar's band, with room for the bot and the emoji beside the housing
    assert.equal(collapsed.height, 38);
    assert.equal(collapsed.width, housing16.width + 2 * ISLAND_SIZES[size].side);
  }
});

test("without AppKit's measure the estimate stays inside the housings Apple ships, at 37 and 38 pt menu bars", () => {
  for (const menuBar of [37, 38]) {
    const { collapsed } = islandLayout({ ...sixteen, workArea: { ...sixteen.workArea, y: menuBar } }, { platform: "darwin" });
    assert.ok(collapsed.notch <= housing16.width - 2, `${menuBar}: ${collapsed.notch}`);
    assert.ok(collapsed.notchHeight <= housing16.height - 1, `${menuBar}: ${collapsed.notchHeight}`);
  }
  // a measure that makes no sense is ignored
  assert.deepEqual(notchOf(sixteen, "darwin", { width: 0, height: 32 }).housing, { width: 182, height: 32 });
});

test("no notch off macOS, on an external display, or under a classic 24 pt menu bar", () => {
  assert.equal(notchOf(builtIn, "win32"), null);
  assert.equal(notchOf({ ...external, internal: false }, "darwin"), null);
  assert.equal(notchOf(display({ internal: true, label: "Built-in Retina Display", workArea: { x: 0, y: 24, width: 1440, height: 876 } }), "darwin"), null);
  // an auto-hidden menu bar measures nothing: the panel's name decides
  const hidden = { ...builtIn, workArea: { ...builtIn.bounds } };
  assert.deepEqual(notchOf(hidden, "darwin"), { width: 177, height: 37, housing: { width: 177, height: 31 } });
  assert.equal(notchOf({ ...hidden, label: "Built-in Retina Display" }, "darwin"), null);
});

test("the island window sits at the top middle of its own display, and a display without a notch gets a floating pill", () => {
  const { window, collapsed } = islandLayout(external, { platform: "darwin", size: "large" });
  assert.deepEqual(window, { x: 1512 + (2560 - ISLAND_WINDOW.width) / 2, y: -200, width: ISLAND_WINDOW.width, height: ISLAND_WINDOW.height });
  assert.deepEqual(collapsed, { kind: "pill", width: ISLAND_SIZES.large.pill, height: ISLAND_SIZES.large.pillHeight, top: PILL_TOP, notch: 0, notchHeight: 0 });
  assert.equal(islandLayout(external, { platform: "darwin", size: "huge" }).size, "medium");
});

test("the dock is a strip against the right edge of the work area, as tall as it, wide enough to open", () => {
  const { window, body, top } = dockLayout(external);
  assert.equal(window.x + window.width, 1512 + 2560 + DOCK.overhang);
  assert.equal(window.width, DOCK.open + DOCK.overhang);
  assert.deepEqual([window.y, window.height], [external.workArea.y, external.workArea.height]);
  assert.equal(top, DOCK.ear + DOCK.margin);
  assert.equal(body, window.height - 2 * top);
  // a Dock pinned to the right leaves a narrower work area; the bot dock stays left of it
  const pinned = { ...external, workArea: { ...external.workArea, width: 2480 } };
  assert.equal(dockLayout(pinned).window.x + dockLayout(pinned).window.width, 1512 + 2480 + DOCK.overhang);
});

test("an auto-hidden Dock or taskbar on the right does not hold the dock off the screen's edge", () => {
  // macOS leaves 4 pt of the work area free beside an auto-hidden Dock, Windows 2 px beside an auto-hidden taskbar
  for (const strip of [1, 2, 4, 8]) {
    for (const scale of [1, 1.25, 1.5, 2]) {
      const hidden = { ...external, scaleFactor: scale, workArea: { ...external.workArea, width: external.bounds.width - strip } };
      const { window } = dockLayout(hidden);
      assert.equal(dockEdge(hidden), 1512 + 2560, `${strip} ${scale}x`);
      assert.equal(window.x + window.width, 1512 + 2560 + DOCK.overhang, `${strip} ${scale}x`);
    }
  }
  // a Dock that shows keeps its place
  const shown = { ...external, workArea: { ...external.workArea, width: 2560 - 48 } };
  assert.equal(dockEdge(shown), 1512 + 2560 - 48);
});

test("the dock never stops short of the screen's edge, whatever the scale or a fractional work area", () => {
  for (const scale of [1, 1.25, 1.5, 1.75, 2]) {
    for (const width of [1512, 1511.5, 1440.25, 1728.8]) {
      const display = { id: 3, internal: false, scaleFactor: scale, bounds: { x: 0.5, y: 0, width, height: 982 }, workArea: { x: 0.5, y: 25.5, width, height: 956.5 } };
      const { window } = dockLayout(display);
      const edge = display.workArea.x + display.workArea.width;
      // in device pixels too: the window's right side lands at least a few pixels past the edge
      assert.ok(Math.round((window.x + window.width) * scale) >= Math.round(edge * scale) + 2 * scale, `${scale}x ${width}`);
      assert.ok(Number.isInteger(window.x) && Number.isInteger(window.y) && Number.isInteger(window.height));
      assert.ok(window.y <= display.workArea.y && window.y + window.height >= display.workArea.y + display.workArea.height);
    }
  }
});

test("the surfaces follow the pointer's display, or stay on the built-in or main one", () => {
  const all = [builtIn, external];
  assert.equal(pickDisplay(all, "active", { primary: builtIn, cursor: { x: 2000, y: 100 } }).id, 2);
  assert.equal(pickDisplay(all, "active", { primary: builtIn, cursor: { x: 9999, y: 9999 } }).id, 1);
  assert.equal(pickDisplay(all, "built-in", { primary: external, cursor: { x: 2000, y: 100 } }).id, 1);
  assert.equal(pickDisplay([external], "built-in", { primary: external }).id, 2);
  assert.equal(pickDisplay(all, "main", { primary: external, cursor: { x: 10, y: 10 } }).id, 2);
  assert.equal(pickDisplay([], "active", {}), null);
});
