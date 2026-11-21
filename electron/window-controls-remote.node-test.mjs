import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const LOCAL = "http://127.0.0.1:48993";
const REMOTE = "https://remote.example.test";
const preloadSource = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");

function loadPreload(origin, activation) {
  let bridge;
  const invoked = [];
  vm.runInNewContext(preloadSource, {
    process: { platform: "win32", argv: [`--dusk-local-origin=${LOCAL}`] },
    location: { origin },
    navigator: { userActivation: { isActive: activation === true } },
    TextEncoder,
    localStorage: { getItem: () => null },
    require: () => ({
      webUtils: {},
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke: (...args) => { invoked.push(args); return Promise.resolve(true); } },
    }),
  });
  return { bridge, invoked };
}

// Windows hides the native caption buttons (titleBarStyle "hidden"), so a remote server's page must still be able to draw them.
test("a remote server's page gets the window controls, and they reach only the window channels", async () => {
  const remote = loadPreload(REMOTE, true);
  assert.deepEqual(Object.keys(remote.bridge.windowControls).sort(), ["close", "minimize", "onMaximizedChanged", "resizeWidthBy", "state", "toggleMaximize"]);
  await remote.bridge.windowControls.minimize();
  await remote.bridge.windowControls.toggleMaximize();
  await remote.bridge.windowControls.state();
  await remote.bridge.windowControls.close();
  await remote.bridge.windowControls.resizeWidthBy(120);
  assert.deepEqual(remote.invoked, [["window:minimize"], ["window:toggle-maximize"], ["window:state"], ["window:close"], ["window:resize-width-by", 120]]);
  assert.equal(remote.bridge.copyText, undefined, "local-only APIs stay off the remote bridge");
});

test("a remote page moves the window only on the person's click", async () => {
  const remote = loadPreload(REMOTE, false);
  await assert.rejects(remote.bridge.windowControls.minimize());
  await assert.rejects(remote.bridge.windowControls.toggleMaximize());
  await assert.rejects(remote.bridge.windowControls.close());
  await assert.rejects(remote.bridge.windowControls.resizeWidthBy(120));
  await assert.rejects(remote.bridge.applySkin("light"));
  await remote.bridge.windowControls.state();
  assert.deepEqual(remote.invoked, [["window:state"]], "reads stay available without a click, moves do not");
});

test("the local page keeps its window controls", () => {
  const local = loadPreload(LOCAL);
  assert.equal(typeof local.bridge.windowControls.minimize, "function");
});

test("the local page keeps its window controls", () => {
  const local = loadPreload(LOCAL);
  assert.equal(typeof local.bridge.windowControls.minimize, "function");
});
