import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("phone relay startup waits for Electron readiness before reading the default session", async () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const marker = 'import("./phone-relay.mjs")';
  const start = main.lastIndexOf("void ", main.indexOf(marker));
  assert.ok(start >= 0);
  const statement = main.slice(start + "void ".length, main.indexOf("\n", start)).replace(marker, "loadRelay()");
  let ready = false;
  let release;
  const readiness = new Promise((resolve) => { release = resolve; });
  const defaultSession = {};
  const installed = [];
  let sessionReads = 0;
  const context = {
    app: { whenReady: () => readiness, getPath: () => "/fixture" },
    session: {
      get defaultSession() {
        sessionReads += 1;
        assert.ok(ready, "Electron rejects defaultSession before app readiness");
        return defaultSession;
      },
    },
    loadRelay: async () => ({
      installPhoneRelay: (options) => installed.push(options),
      systemProxy: (value) => { assert.equal(value, defaultSession); return "proxy"; },
    }),
    ipcMain: {},
    powerMonitor: {},
    localWorkspaceOnly: () => {},
    jsonFile: () => {},
    cloudEncryption: {},
    cloudFetch: () => {},
    slog: () => {},
  };
  const started = vm.runInNewContext(statement, context);
  const outcome = started.then(() => null, (error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessionReads, 0);
  assert.equal(installed.length, 0);
  ready = true;
  release();
  assert.equal(await outcome, null);
  assert.equal(sessionReads, 1);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].proxy, "proxy");
});
