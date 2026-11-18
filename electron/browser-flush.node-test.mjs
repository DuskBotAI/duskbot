import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

import { BROWSERS_FLUSH, BROWSERS_FLUSHED, createBrowsersFlush, installSessionEndFlush } from "./browser-flush.mjs";

function server() {
  const sent = [];
  return { sent, postMessage: (message) => sent.push(message) };
}

let ids = 0;
const randomId = () => `id-${++ids}`;

test("a flush waits for the server's answer", async () => {
  const proc = server();
  const flusher = createBrowsersFlush({ server: () => proc, randomId });
  const flushing = flusher.flush();
  assert.equal(proc.sent.length, 1);
  assert.equal(proc.sent[0].type, BROWSERS_FLUSH);
  assert.equal(proc.sent[0].final, true);
  let done = false;
  void flushing.then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  assert.equal(flusher.receive({ type: BROWSERS_FLUSHED, requestId: proc.sent[0].requestId, ok: true }), true);
  assert.equal(await flushing, true);
});

test("the final flush is asked once, however many events ask for it", async () => {
  const proc = server();
  const flusher = createBrowsersFlush({ server: () => proc, randomId });
  const first = flusher.flush();
  const second = flusher.flush();
  const prepared = flusher.prepare();
  assert.equal(first, second);
  assert.equal(prepared, first);
  assert.equal(proc.sent.length, 1);
  flusher.receive({ type: BROWSERS_FLUSHED, requestId: proc.sent[0].requestId, ok: true });
  assert.equal(await first, true);
});

test("a silent server cannot hold the quit: the flush gives up after its limit", async () => {
  const proc = server();
  const flusher = createBrowsersFlush({ server: () => proc, randomId, timeoutMs: 20 });
  const started = Date.now();
  assert.equal(await flusher.flush(), false);
  assert.ok(Date.now() - started < 1_000);
});

test("no server, or one that cannot be reached, answers false at once", async () => {
  assert.equal(await createBrowsersFlush({ server: () => null, randomId }).flush(), false);
  const broken = { postMessage() { throw new Error("gone"); } };
  assert.equal(await createBrowsersFlush({ server: () => broken, randomId, timeoutMs: 60_000 }).flush(), false);
});

test("a Windows query only prepares; the session end is final", () => {
  const proc = server();
  const flusher = createBrowsersFlush({ server: () => proc, randomId, timeoutMs: 20 });
  const app = new EventEmitter();
  const existing = new EventEmitter();
  installSessionEndFlush({ app, windows: () => [existing], powerMonitor: new EventEmitter(), flusher, quit: () => {} });
  existing.emit("query-session-end", { preventDefault() { throw new Error("never blocks the logoff"); } });
  assert.deepEqual(proc.sent.map((message) => message.final), [false]);
  const later = new EventEmitter();
  app.emit("browser-window-created", {}, later);
  later.emit("session-end");
  existing.emit("session-end");
  assert.deepEqual(proc.sent.map((message) => message.final), [false, true]);
});

test("the session's end is told on Windows' session-end and on a shutdown, never on a query", () => {
  const flusher = createBrowsersFlush({ server: () => null, randomId });
  const win = new EventEmitter(), power = new EventEmitter();
  let ends = 0;
  installSessionEndFlush({ app: new EventEmitter(), windows: () => [win], powerMonitor: power, flusher, quit: () => {}, onSessionEnd: () => { ends++; } });
  win.emit("query-session-end", {});
  assert.equal(ends, 0);
  win.emit("session-end");
  power.emit("shutdown", { preventDefault() {} });
  assert.equal(ends, 2);
});

test("a shutdown is delayed until the browsers quit, then the app quits once", async () => {
  const proc = server();
  const flusher = createBrowsersFlush({ server: () => proc, randomId });
  const power = new EventEmitter();
  let quits = 0;
  let prevented = 0;
  installSessionEndFlush({ app: new EventEmitter(), windows: () => [], powerMonitor: power, flusher, quit: () => { quits++; } });
  power.emit("shutdown", { preventDefault: () => { prevented++; } });
  power.emit("shutdown", { preventDefault: () => { prevented++; } });
  assert.equal(prevented, 2);
  assert.equal(proc.sent.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quits, 0);
  flusher.receive({ type: BROWSERS_FLUSHED, requestId: proc.sent[0].requestId, ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quits, 1);
});

test("main hears the answer, installs the session-end hooks once ready, and on Windows quits the browsers before the server", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /if \(browsersFlush\.receive\(message\)\) return;/);
  assert.match(main, /app\.whenReady\(\)\.then\(\(\) => installSessionEndFlush\(/);
  const quit = main.slice(main.indexOf('app.on("before-quit"'));
  assert.ok(quit.indexOf("browsersFlush.flush()") < quit.indexOf("serverSupervisor.shutdown()"));
  assert.match(quit, /process\.platform === "win32" \? browsersFlush\.flush\(\)/);
});
