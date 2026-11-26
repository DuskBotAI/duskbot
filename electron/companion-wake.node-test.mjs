import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  COMPANION_APP_BLOCKER,
  COMPANION_DISPLAY_BLOCKER,
  companionWakeBlockerType,
  createCompanionWakeHold,
} from "./companion-wake.mjs";

function fakeBlocker() {
  let nextId = 1;
  const active = new Map();
  const calls = [];
  return {
    calls,
    active,
    start(type) {
      const id = nextId++;
      active.set(id, type);
      calls.push(["start", type, id]);
      return id;
    },
    stop(id) {
      active.delete(id);
      calls.push(["stop", id]);
    },
    isStarted(id) {
      return active.has(id);
    },
  };
}

test("companionWakeBlockerType chooses display sleep blocker on Windows AC and releases on battery", () => {
  assert.equal(
    companionWakeBlockerType({ enabled: true, keepAwake: true, platform: "win32", onBattery: false }),
    COMPANION_DISPLAY_BLOCKER,
  );
  assert.equal(
    companionWakeBlockerType({ enabled: true, keepAwake: true, platform: "win32", onBattery: true }),
    null,
  );
  assert.equal(
    companionWakeBlockerType({ enabled: true, keepAwake: true, platform: "darwin", onBattery: false }),
    COMPANION_APP_BLOCKER,
  );
  assert.equal(
    companionWakeBlockerType({ enabled: true, keepAwake: true, platform: "linux", onBattery: false }),
    COMPANION_APP_BLOCKER,
  );
  assert.equal(
    companionWakeBlockerType({ enabled: true, keepAwake: true, platform: "darwin", onBattery: true }),
    null,
  );
  assert.equal(
    companionWakeBlockerType({ enabled: false, keepAwake: true, platform: "win32", onBattery: false }),
    null,
  );
  assert.equal(
    companionWakeBlockerType({ enabled: true, keepAwake: false, platform: "win32", onBattery: false }),
    null,
  );
});

test("createCompanionWakeHold reacts to AC and battery changes on Windows", () => {
  const blocker = fakeBlocker();
  const powerMonitor = new EventEmitter();
  let onBattery = false;
  const logs = [];
  const hold = createCompanionWakeHold({
    blocker,
    powerMonitor,
    platform: "win32",
    isOnBattery: () => onBattery,
    log: (line) => logs.push(line),
  });

  assert.equal(hold.sync(true, true), COMPANION_DISPLAY_BLOCKER);
  assert.equal(hold.holding(), true);
  assert.deepEqual(blocker.calls, [["start", COMPANION_DISPLAY_BLOCKER, 1]]);

  // Calling sync again with the same state is a no-op.
  assert.equal(hold.sync(true, true), COMPANION_DISPLAY_BLOCKER);
  assert.equal(blocker.calls.length, 1);

  // Unplugging releases the display wake lock immediately.
  onBattery = true;
  powerMonitor.emit("on-battery");
  assert.equal(hold.holding(), false);
  assert.equal(hold.activeType(), null);
  assert.deepEqual(blocker.calls, [
    ["start", COMPANION_DISPLAY_BLOCKER, 1],
    ["stop", 1],
  ]);

  // Plugging back in re-acquires the display wake lock.
  onBattery = false;
  powerMonitor.emit("on-ac");
  assert.equal(hold.holding(), true);
  assert.equal(hold.activeType(), COMPANION_DISPLAY_BLOCKER);
  assert.deepEqual(blocker.calls, [
    ["start", COMPANION_DISPLAY_BLOCKER, 1],
    ["stop", 1],
    ["start", COMPANION_DISPLAY_BLOCKER, 2],
  ]);

  // Stopping cleans up the blocker and detaches powerMonitor listeners.
  hold.stop();
  assert.equal(hold.holding(), false);
  assert.equal(powerMonitor.listenerCount("on-ac"), 0);
  assert.equal(powerMonitor.listenerCount("on-battery"), 0);
  assert.ok(logs.some((line) => line.includes("prevent-display-sleep")));
  assert.ok(logs.some((line) => line.includes("battery")));
});

test("createCompanionWakeHold keeps app suspension blocker on macOS AC and handles battery query errors", () => {
  const blocker = fakeBlocker();
  const hold = createCompanionWakeHold({
    blocker,
    platform: "darwin",
    isOnBattery: () => {
      throw new Error("unavailable");
    },
  });

  assert.equal(hold.sync(true, true), COMPANION_APP_BLOCKER);
  assert.equal(hold.holding(), true);
  assert.equal(hold.sync(true, false), null);
  assert.equal(hold.holding(), false);
});
