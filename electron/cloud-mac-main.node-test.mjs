import assert from "node:assert/strict";
import test from "node:test";

import { installCloudMac, loosens } from "./cloud-mac-main.mjs";

test("only a laxer When to ask or turning Only these folders off loosens", () => {
  const view = { mode: "auto", limitFolders: true };
  assert.equal(loosens(view, "setMode", "never"), true);
  assert.equal(loosens(view, "setMode", "ask"), false);
  assert.equal(loosens({ mode: "ask" }, "setMode", "auto"), true);
  assert.equal(loosens(view, "setLimitFolders", false), true);
  assert.equal(loosens({ limitFolders: false }, "setLimitFolders", true), false);
  assert.equal(loosens(view, "removeFolder", "~/Downloads"), false);
});

test("the cloud's page cannot loosen the rules without the person's Allow on this Mac", async () => {
  const handlers = new Map();
  let saved = { enabled: true, mode: "ask", limitFolders: true, folders: ["~/Downloads"] };
  let answer = 1, asked = 0;
  const installed = installCloudMac({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    dialog: { showMessageBox: async () => { asked += 1; return { response: answer }; } }, shell: {},
    allowed: () => true, window: () => null, fetch: async () => new Response("{}"), label: () => "Mac", userData: "/nowhere",
    jsonFile: () => ({ read: () => saved, write: (value) => { saved = value; } }), myCloud: () => null, cloudAwake: () => false,
    linkKey: async () => null, reauth: async () => false, log: () => {}, driver: () => null, computerUse: async () => null,
    Tray: class {}, Menu: { buildFromTemplate: () => ({}) }, nativeImage: {}, resourcesDir: "/nowhere",
  });
  try {
    const call = (name, ...args) => handlers.get(`cloud-mac:${name}`)({}, ...args);
    assert.equal((await call("setMode", "never")).mode, "ask");
    assert.equal((await call("setLimitFolders", false)).limitFolders, true);
    assert.equal(asked, 2);
    assert.equal((await call("setMode", "ask")).mode, "ask");
    assert.equal(asked, 2);
    answer = 0;
    assert.equal((await call("setMode", "auto")).mode, "auto");
    assert.equal((await call("setLimitFolders", false)).limitFolders, false);
    assert.equal(asked, 4);
  } finally { installed?.close(); }
});
