import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createIslandWindow } from "./island-window.mjs";

function world() {
  const sent = [];
  class BrowserWindow {
    constructor(options) {
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), { send: (channel, payload) => sent.push([channel, payload]), setWindowOpenHandler() {} });
    }
    setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} setIgnoreMouseEvents() {} on() {} showInactive() {}
    loadURL() { queueMicrotask(() => this.webContents.emit("did-finish-load")); return Promise.resolve(); }
    isDestroyed() { return this.destroyed; } isVisible() { return true; } getBounds() { return this.bounds; } setBounds(bounds) { this.bounds = bounds; }
    destroy() { this.destroyed = true; }
  }
  return { BrowserWindow, sent };
}

const builtIn = { id: 1, internal: true, label: "Built-in Retina Display", bounds: { x: 0, y: 0, width: 1728, height: 1117 }, workArea: { x: 0, y: 38, width: 1728, height: 1079 } };
const shapes = (sent) => sent.filter(([channel]) => channel === "ambient:layout").map(([, layout]) => layout.collapsed);

test("the island lays out on the menu bar's estimate at once, then on AppKit's measure once it comes, asking once per display", async () => {
  const { BrowserWindow, sent } = world();
  let asked = 0;
  const island = createIslandWindow({ BrowserWindow, url: () => "http://127.0.0.1:1/ambient.html", platform: "darwin", onMessage() {}, log() {},
    measure: async () => { asked++; return { 1: { width: 185, height: 32 } }; } });
  island.layout(builtIn, { size: "medium" });
  island.layout(builtIn, { size: "medium" });
  await sleep(10);
  assert.equal(asked, 1);
  const last = shapes(sent).at(-1);
  assert.deepEqual([last.notch, last.notchHeight], [183, 31]);
  // a display that changes scale is measured again
  island.layout({ ...builtIn, bounds: { ...builtIn.bounds, width: 1512, height: 982 } }, { size: "medium" });
  await sleep(10);
  assert.equal(asked, 2);
  island.close();
});

test("off macOS and on an external display it never asks", async () => {
  let asked = 0;
  const measure = async () => { asked++; return {}; };
  const external = { ...builtIn, id: 2, internal: false };
  createIslandWindow({ BrowserWindow: world().BrowserWindow, url: () => null, platform: "darwin", onMessage() {}, log() {}, measure }).layout(external, { size: "small" });
  createIslandWindow({ BrowserWindow: world().BrowserWindow, url: () => null, platform: "win32", onMessage() {}, log() {}, measure }).layout(builtIn, { size: "small" });
  await sleep(10);
  assert.equal(asked, 0);
});
