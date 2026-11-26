import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createRoutineWakeHold, rememberRoutineWake, routineWakeDecision, routineWakePatch, routineWakeSettings, sleepMissesRoutines } from "./routine-wake.mjs";

test("the hold is on only when enabled, plugged in, and the server says a routine is due or running", () => {
  const due = { hold: true, reason: "due", at: 1_700_000_000_000 };
  assert.deepEqual(routineWakeDecision({ enabled: true, onBattery: false, status: due }), { hold: true, reason: "due", at: 1_700_000_000_000 });
  assert.deepEqual(routineWakeDecision({ enabled: true, onBattery: false, status: { hold: true, reason: "running" } }), { hold: true, reason: "running", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: true, onBattery: false, status: { hold: false } }), { hold: false, reason: "idle", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: true, onBattery: false, status: null }), { hold: false, reason: "idle", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: true, onBattery: true, status: due }), { hold: false, reason: "battery", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: false, onBattery: false, status: due }), { hold: false, reason: "off", at: null });
});

test("plugged in, keep awake while plugged in holds whenever a routine is enabled here, and never on battery", () => {
  const two = { hold: false, routines: 2 };
  assert.deepEqual(routineWakeDecision({ enabled: false, pluggedIn: true, onBattery: false, status: two }), { hold: true, reason: "plugged-in", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: true, pluggedIn: true, onBattery: false, status: two }), { hold: true, reason: "plugged-in", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: false, pluggedIn: true, onBattery: true, status: two }), { hold: false, reason: "battery", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: false, pluggedIn: true, onBattery: false, status: { hold: false, routines: 0 } }), { hold: false, reason: "idle", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: false, pluggedIn: true, onBattery: false, status: { hold: false } }), { hold: false, reason: "idle", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: false, pluggedIn: true, onBattery: false, status: null }), { hold: false, reason: "idle", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: false, pluggedIn: false, onBattery: false, status: two }), { hold: false, reason: "off", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: true, pluggedIn: true, onBattery: false, status: { hold: true, reason: "due", at: 7, routines: 0 } }), { hold: true, reason: "due", at: 7 });
});

test("the renderer's patch passes only booleans", () => {
  assert.deepEqual(routineWakePatch({ keepAwake: false, pluggedIn: true, extra: 1 }), { keepAwake: false, pluggedIn: true });
  assert.deepEqual(routineWakePatch({ pluggedIn: "yes" }), {});
  assert.deepEqual(routineWakePatch(true), {});
  assert.deepEqual(routineWakePatch(null), {});
});

test("a sleep misses routines only with one enabled here and keep awake while plugged in off", () => {
  assert.equal(sleepMissesRoutines({ pluggedIn: false, status: { hold: false, routines: 1 } }), true);
  assert.equal(sleepMissesRoutines({ pluggedIn: true, status: { hold: false, routines: 1 } }), false);
  assert.equal(sleepMissesRoutines({ pluggedIn: false, status: { hold: false, routines: 0 } }), false);
  assert.equal(sleepMissesRoutines({ pluggedIn: false, status: { hold: false } }), false);
  assert.equal(sleepMissesRoutines({ pluggedIn: false, status: null }), false);
});

test("the toggles survive a reread: keep awake on and keep awake while plugged in off until switched", () => {
  const dir = mkdtempSync(join(tmpdir(), "dusk-routine-wake-"));
  try {
    assert.deepEqual(routineWakeSettings(dir), { keepAwake: true, pluggedIn: false });
    rememberRoutineWake(dir, { keepAwake: false });
    assert.deepEqual(routineWakeSettings(dir), { keepAwake: false, pluggedIn: false });
    rememberRoutineWake(dir, { pluggedIn: true });
    assert.deepEqual(routineWakeSettings(dir), { keepAwake: false, pluggedIn: true });
    rememberRoutineWake(dir, { keepAwake: true });
    assert.deepEqual(routineWakeSettings(dir), { keepAwake: true, pluggedIn: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one assertion is taken while a hold is warranted and released when it is not, or on stop", async () => {
  const calls = [];
  let nextId = 1;
  const started = new Set();
  const blocker = {
    start(type) { const id = nextId++; started.add(id); calls.push(["start", type, id]); return id; },
    stop(id) { started.delete(id); calls.push(["stop", id]); },
    isStarted: (id) => started.has(id),
  };
  let status = { hold: true, reason: "due", at: 42 };
  let onBattery = false;
  let keepAwake = true;
  const hold = createRoutineWakeHold({
    fetchStatus: async () => status,
    isOnBattery: () => onBattery,
    blocker,
    platform: "darwin",
    settings: () => ({ keepAwake }),
    log() {},
    pollMs: 60_000,
  });

  assert.deepEqual(await hold.poll(), { hold: true, reason: "due", at: 42, keepAwake: true, pluggedIn: undefined, onBattery: false, sleptAt: null });
  assert.equal(hold.holding(), true);
  await hold.poll();
  assert.deepEqual(calls, [["start", "prevent-app-suspension", 1]]);

  onBattery = true;
  assert.equal((await hold.poll()).reason, "battery");
  assert.equal(hold.holding(), false);
  onBattery = false;
  await hold.poll();
  assert.equal(hold.holding(), true);

  status = null;
  assert.equal((await hold.poll()).reason, "idle");
  assert.equal(hold.holding(), false);
  status = { hold: true, reason: "running" };
  keepAwake = false;
  assert.equal((await hold.poll()).reason, "off");
  assert.equal(hold.holding(), false);

  keepAwake = true;
  await hold.poll();
  assert.equal(hold.holding(), true);
  hold.stop();
  assert.equal(hold.holding(), false);
  assert.deepEqual(calls.at(-1), ["stop", 3]);
});

test("on Windows AC power, routine wake uses prevent-display-sleep to avoid Modern Standby entry", async () => {
  const calls = [];
  const started = new Set();
  const blocker = {
    start(type) { started.add(1); calls.push(["start", type, 1]); return 1; },
    stop(id) { started.delete(id); calls.push(["stop", id]); },
    isStarted: (id) => started.has(id),
  };
  let onBattery = false;
  const hold = createRoutineWakeHold({
    fetchStatus: async () => ({ hold: false, routines: 1 }),
    isOnBattery: () => onBattery,
    blocker,
    platform: "win32",
    settings: () => ({ keepAwake: true, pluggedIn: true }),
    log() {},
    pollMs: 60_000,
  });
  await hold.poll();
  assert.deepEqual(calls, [["start", "prevent-display-sleep", 1]]);
  onBattery = true;
  await hold.poll();
  assert.equal(hold.holding(), false);
  assert.deepEqual(calls.at(-1), ["stop", 1]);
});

test("plugged in, the hold follows the power source and the routines; a sleep with a routine here is remembered", async () => {
  const started = new Set();
  let nextId = 1;
  const blocker = { start() { const id = nextId++; started.add(id); return id; }, stop(id) { started.delete(id); }, isStarted: (id) => started.has(id) };
  const listeners = {};
  let status = { hold: false, routines: 1 };
  let onBattery = false;
  let settings = { keepAwake: true, pluggedIn: true };
  const hold = createRoutineWakeHold({
    fetchStatus: async () => status,
    isOnBattery: () => onBattery,
    blocker,
    settings: () => settings,
    log() {},
    pollMs: 60_000,
    now: () => 1_000,
    powerMonitor: { on: (event, listener) => { listeners[event] = listener; } },
  });
  hold.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hold.holding(), true);
  assert.equal(hold.state().reason, "plugged-in");

  onBattery = true;
  listeners["on-battery"]();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hold.holding(), false);
  onBattery = false;
  listeners["on-ac"]();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hold.holding(), true);

  status = { hold: false, routines: 0 };
  await hold.poll();
  assert.equal(hold.holding(), false);
  status = { hold: false, routines: 1 };
  settings = { keepAwake: true, pluggedIn: false };
  await hold.poll();
  assert.equal(hold.holding(), false);

  listeners.suspend();
  assert.equal(hold.state().sleptAt, 1_000);
  hold.stop();
  assert.equal(started.size, 0);
});

test("a sleep is not remembered while keep awake while plugged in is on, or with no routine here", async () => {
  const listeners = {};
  let status = { hold: false, routines: 0 };
  const hold = createRoutineWakeHold({
    fetchStatus: async () => status,
    isOnBattery: () => true,
    blocker: { start: () => 1, stop() {}, isStarted: () => false },
    settings: () => ({ keepAwake: true, pluggedIn: false }),
    log() {},
    powerMonitor: { on: (event, listener) => { listeners[event] = listener; } },
  });
  hold.start();
  await hold.poll();
  listeners.suspend();
  assert.equal(hold.state().sleptAt, null);
  hold.stop();
});

test("after a wake the server hears resume, then online once the network reads online twice in a row", async () => {
  const { watchWake } = await import("./routine-wake.mjs");
  const listeners = {};
  const told = [];
  const reads = [false, true, false, true, true];
  const wake = watchWake({
    powerMonitor: { on: (event, listener) => { listeners[event] = listener; } },
    isOnline: () => reads.shift() ?? true,
    notify: async (event) => { told.push(event); },
    onlinePollMs: 5,
    log: () => {},
  });
  wake.watch();
  wake.watch();
  listeners.suspend();
  listeners.resume();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(told, ["suspend", "resume", "online"]);
  assert.equal(reads.length, 0);
});

test("routines go ahead without the network after the wait, and a later sleep cancels a pending wait", async () => {
  const { watchWake } = await import("./routine-wake.mjs");
  const listeners = {};
  const told = [];
  const lines = [];
  const wake = watchWake({
    powerMonitor: { on: (event, listener) => { listeners[event] = listener; } },
    isOnline: () => false,
    notify: async (event) => { told.push(event); },
    onlinePollMs: 5,
    onlineWaitMs: 40,
    log: (line) => lines.push(line),
  });
  wake.watch();
  listeners.resume();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(told, ["resume", "online"]);
  assert.match(lines.join("\n"), /no network \d+ s after waking; routines go ahead/);
  told.length = 0;
  listeners.resume();
  await new Promise((resolve) => setTimeout(resolve, 10));
  listeners.suspend();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(told, ["resume", "suspend"]);
});

test("a server that does not answer is asked again, and the wait goes on", async () => {
  const { watchWake } = await import("./routine-wake.mjs");
  const listeners = {};
  let failures = 1;
  const told = [];
  const wake = watchWake({
    powerMonitor: { on: (event, listener) => { listeners[event] = listener; } },
    isOnline: () => true,
    notify: async (event) => { if (failures-- > 0) throw new Error("starting"); told.push(event); },
    onlinePollMs: 5,
    log: () => {},
  });
  wake.watch();
  listeners.resume();
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  assert.deepEqual(told, ["resume", "online"]);
});
