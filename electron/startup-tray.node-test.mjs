import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createStartupScreen, STARTUP_TRY_AGAIN } from "./startup-screen.mjs";
import { createSystemTray, trayIcon } from "./system-tray.mjs";

const iconPath = fileURLToPath(new URL("./resources/app-icon.png", import.meta.url));
class Window extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.destroyed = false; this.visible = false;
    this.webContents = new EventEmitter();
    this.webContents.executeJavaScript = async () => {};
  }
  setMenu() {}
  loadURL() { queueMicrotask(() => this.emit("ready-to-show")); return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("closed"); }
  show() { this.visible = true; this.emit("show"); }
  showInactive() { this.show(); }
  hide() { this.visible = false; }
  focus() { this.focused = true; }
  isMinimized() { return this.minimized ?? false; }
  minimize() { this.minimized = true; }
  restore() { this.minimized = false; }
  maximize() { this.maximized = true; }
  setSkipTaskbar(value) { this.skipTaskbar = value; }
}
function fixture(options = {}) {
  const calls = [];
  let trayInstance;
  class Tray extends EventEmitter {
    constructor(_icon, guid) { super(); this.guid = guid; trayInstance = this; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menu = value; }
    isDestroyed() { return this.destroyed ?? false; }
    destroy() { this.destroyed = true; calls.push("destroy-tray"); }
  }
  let active;
  const tray = createSystemTray({ Tray, Menu: { buildFromTemplate: value => value },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, resourcesDir: "resources", platform: "win32",
    getWindow: () => active, onQuit: () => calls.push("quit") });
  const splash = createStartupScreen({ BrowserWindow: Window, iconPath, platform: "win32",
    isQuitting: () => false, onQuit: () => calls.push("quit"), onHide: win => tray.hide(win),
    isHidden: () => tray.isHidden(), onShow: win => tray.windowShown(win),
    onFinished: () => calls.push("finished"), ...options });
  active = splash.window;
  const win = new Window();
  win.on("show", () => tray.windowShown(win));
  return { tray, trayInstance, splash, win, calls, setActive: value => { active = value; } };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

class UnreadyWindow extends Window {
  loadURL() { return Promise.resolve(); }
}

test("a loading screen that never becomes ready cannot block server startup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { splash, win, calls } = fixture({ BrowserWindow: UnreadyWindow });
  let ready = false;
  void splash.ready.then(() => { ready = true; });
  t.mock.timers.tick(9999); await flush();
  assert.equal(ready, false);
  t.mock.timers.tick(1); await flush();
  assert.equal(ready, true);
  // Still the app's only window: destroying it would quit before the workspace exists.
  assert.equal(splash.window.destroyed, false);
  assert.deepEqual(calls, []);
  splash.attach(win);
  win.webContents.emit("did-finish-load"); await flush();
  assert.equal(win.visible, true); assert.equal(splash.window.destroyed, true);
  assert.deepEqual(calls, ["finished"]);
});

test("a loading renderer crash unblocks startup before ready-to-show", async () => {
  const { splash, calls } = fixture({ BrowserWindow: UnreadyWindow });
  let ready = false;
  void splash.ready.then(() => { ready = true; });
  splash.window.webContents.emit("render-process-gone");
  await flush();
  assert.equal(ready, true);
  assert.equal(splash.window.destroyed, false);
  assert.deepEqual(calls, []);
});

test("a loaded page shows without ready-to-show, as on COSMIC Wayland", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { splash, calls } = fixture({ BrowserWindow: UnreadyWindow });
  let ready = false;
  void splash.ready.then(() => { ready = true; });
  splash.window.webContents.emit("did-finish-load");
  t.mock.timers.tick(499); await flush();
  assert.equal(splash.window.visible, false); assert.equal(ready, false);
  t.mock.timers.tick(1); await flush();
  assert.equal(splash.window.visible, true); assert.equal(ready, true);
  assert.deepEqual(calls, []);
});

test("ready-to-show and a loaded page show the splash once", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let shows = 0;
  const { splash } = fixture({ onShow: () => { shows += 1; } });
  await splash.ready;
  splash.window.webContents.emit("did-finish-load");
  t.mock.timers.tick(500); await flush();
  assert.equal(shows, 1);
});

test("loading screen waits for mounted content before revealing the restored workspace", async () => {
  const { splash, win, calls } = fixture();
  await splash.ready;
  assert.equal(splash.window.visible, true);
  let mounted;
  win.webContents.executeJavaScript = () => new Promise(resolve => { mounted = resolve; });
  splash.attach(win, { maximized: true });
  win.webContents.emit("did-finish-load");
  assert.equal(win.visible, false);
  mounted(); await flush();
  assert.equal(win.visible, true); assert.equal(win.maximized, true);
  assert.equal(win.focused, true); assert.equal(splash.window.destroyed, true);
  assert.deepEqual(calls, ["finished"]);
});

test("closing during startup keeps the eventual workspace hidden until tray restore", async () => {
  const { splash, win, tray, calls, setActive } = fixture();
  await splash.ready;
  let prevented = false;
  splash.window.emit("close", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(tray.isHidden(), true);
  splash.attach(win, { maximized: true });
  win.webContents.emit("did-finish-load"); await flush();
  assert.equal(win.visible, false); assert.equal(win.skipTaskbar, true);
  setActive(win); assert.equal(tray.show(), true);
  assert.equal(win.visible, true); assert.equal(win.skipTaskbar, false);
  assert.equal(win.maximized, true); assert.equal(tray.isHidden(), false);
  assert.deepEqual(calls, ["finished"]);
});

test("tray restores minimized windows, supports explicit quit, and disposes once", async () => {
  const { splash, win, tray, trayInstance, setActive, calls } = fixture();
  await splash.ready; splash.dispose(); setActive(win);
  win.minimize(); tray.hide(win); trayInstance.emit("click");
  assert.equal(win.minimized, false); assert.equal(win.focused, true);
  assert.equal(win.skipTaskbar, false);
  trayInstance.menu[2].click();
  tray.destroy(); tray.destroy();
  assert.deepEqual(calls, ["finished", "quit", "destroy-tray"]);
  win.destroy(); assert.equal(tray.show(), false);
});

test("renderer crash reveals the workspace recovery surface", async () => {
  const { splash, win } = fixture(); await splash.ready; splash.attach(win);
  win.webContents.emit("render-process-gone");
  assert.equal(win.visible, true); assert.equal(splash.window.destroyed, true);
});

test("a renderer that never mounts has a bounded fallback", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { splash, win } = fixture(); await splash.ready; splash.attach(win);
  t.mock.timers.tick(9999); assert.equal(win.visible, false);
  t.mock.timers.tick(1); assert.equal(win.visible, true);
  assert.equal(splash.window.destroyed, true);
});

test("quit never reveals a waiting workspace", async () => {
  let quitting = false;
  const { splash, win } = fixture({ isQuitting: () => quitting });
  await splash.ready; splash.attach(win); quitting = true; splash.dispose();
  win.webContents.emit("did-finish-load"); await flush();
  assert.equal(win.visible, false); assert.equal(splash.window.destroyed, true);
});

test("without a Windows tray or on another platform splash close quits", async () => {
  for (const options of [{ platform: "darwin" }, { onHide: undefined }]) {
    const { splash, calls } = fixture(options); await splash.ready;
    splash.window.emit("close", { preventDefault() {} });
    assert.deepEqual(calls, ["quit"]); splash.dispose();
  }
});

test("the loading screen says what the app waits on, before its page has loaded and after", async () => {
  const ran = [];
  class Said extends Window {
    constructor(options) { super(options); this.webContents.executeJavaScript = async (code) => { ran.push(code); }; }
  }
  const { splash } = fixture({ BrowserWindow: Said });
  splash.status("Waking My Cloud…");
  splash.window.webContents.emit("did-finish-load");
  assert.equal(ran.length, 2);
  for (const code of ran) { assert.match(code, /^window\.card\?\.say\(/); assert.ok(code.includes(JSON.stringify("Waking My Cloud…"))); }
  splash.dispose();
  splash.status("Opening My Cloud…");
  assert.equal(ran.length, 2, "nothing after it is gone");
});

test("the workspace fades in over the splash", async () => {
  const ran = [];
  class Fading extends Window {
    constructor(options) { super(options); this.webContents.executeJavaScript = async code => { ran.push(code); }; }
    setOpacity(value) { this.opacity = value; }
    isVisible() { return this.visible; }
  }
  const { splash, calls } = fixture({ BrowserWindow: Fading, platform: "darwin" });
  await splash.ready;
  const win = new Fading();
  splash.attach(win);
  win.webContents.emit("did-finish-load");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(ran.includes("window.card?.ready()"));
  assert.equal(win.visible, false, "the crew cheers before the app fades in");
  while (!splash.window.destroyed) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(win.visible, true); assert.equal(win.opacity, 1); assert.equal(splash.window.opacity, 0);
  assert.deepEqual(calls, ["finished"]);
});

test("a failed startup shows on the card with try again and quit, never a hang", async () => {
  const ran = [];
  class Said extends UnreadyWindow {
    constructor(options) { super(options); this.webContents.executeJavaScript = async (code) => { ran.push(code); }; }
  }
  const { splash, calls } = fixture({ BrowserWindow: Said, onRetry: () => calls.push("retry") });
  splash.fail(new Error("the server exited"));
  assert.equal(splash.window.visible, true);
  assert.ok(ran.some(code => code === `window.card?.fail(${JSON.stringify(STARTUP_TRY_AGAIN)})`));
  splash.window.webContents.emit("did-finish-load");
  assert.equal(ran.filter(code => code.startsWith("window.card?.fail(")).length, 2, "a reload still shows it");
  splash.window.webContents.emit("ipc-message", {}, "startup-screen:retry");
  splash.window.webContents.emit("ipc-message", {}, "startup-screen:quit");
  assert.deepEqual(calls, ["retry", "quit"]);
  assert.equal(splash.window.destroyed, false);
});

test("startup marks move the card forward, never back, and a reload shows the step reached", async () => {
  const ran = [];
  class Said extends UnreadyWindow {
    constructor(options) { super(options); this.webContents.executeJavaScript = async (code) => { ran.push(code); }; }
  }
  const loads = [];
  let clock = 1_000;
  const { splash } = fixture({ BrowserWindow: Said, dark: true, now: () => clock, onLoaded: ms => loads.push(ms) });
  assert.equal(splash.window.options.backgroundColor, "#141418");
  assert.equal(splash.window.options.transparent, undefined);
  splash.progress("splash"); splash.progress("server"); splash.progress("credentials");
  assert.deepEqual(ran, ["window.card?.step(3)"]);
  splash.window.webContents.emit("did-finish-load");
  assert.deepEqual(ran, ["window.card?.step(3)", "window.card?.step(3)"]);
  clock = 8_200;
  splash.progress("loaded");
  assert.equal(ran.at(-1), "window.card?.step(5)");
  assert.deepEqual(loads, [7_200], "the load time is kept so the next launch paces itself");
});

test("the macOS tray icon is a template image, elsewhere the logo", () => {
  const loaded = [];
  const nativeImage = { createFromPath: (file) => { const image = { file, setTemplateImage: (on) => { image.template = on; }, resize: () => image }; loaded.push(image); return image; } };
  const mac = trayIcon(nativeImage, "res", "darwin");
  assert.equal(mac.file, "res/trayTemplate.png");
  assert.equal(mac.template, true);
  assert.equal(trayIcon(nativeImage, "res", "win32").file, "res/tray-icon.png");
});

test("hold pauses the stuck timer across reloads and keeps update waits out of the load-time median", async () => {
  const ran = [];
  class Said extends Window {
    constructor(options) { super(options); this.webContents.executeJavaScript = async (code) => { ran.push(code); }; }
  }
  const loads = [];
  let clock = 1_000;
  const { splash } = fixture({ BrowserWindow: Said, now: () => clock, onLoaded: ms => loads.push(ms) });
  await splash.ready;
  splash.hold(true);
  splash.status("Finishing update to 1.1.0\u2026");
  splash.window.webContents.emit("did-finish-load");
  assert.ok(ran.includes("window.card?.hold(true)"));
  assert.equal(ran.filter(code => code === "window.card?.hold(true)").length, 2);
  clock = 65_000;
  splash.status(null);
  splash.hold(false);
  assert.ok(ran.includes("window.card?.say(null)"));
  assert.ok(ran.includes("window.card?.hold(false)"));
  clock = 68_500;
  splash.progress("loaded");
  assert.deepEqual(loads, [3_500]);
});
