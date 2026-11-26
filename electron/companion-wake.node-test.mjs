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

test("companionWakeBlockerType uses display blocker only on Windows AC when keepScreenOn is opted in", () => {
  assert.equal(
    companionWakeBlockerType({ enabled: true, keepAwake: true, keepScreenOn: false, platform: "win32", onBattery: false }),
    COMPANION_APP_BLOCKER,
  );
  assert.equal(
    companionWakeBlockerType({ enabled: true, keepAwake: true, keepScreenOn: true, platform: "win32", onBattery: false }),
    COMPANION_DISPLAY_BLOCKER,
  );
  assert.equal(
    companionWakeBlockerType({ enabled: true, keepAwake: true, keepScreenOn: true, platform: "win32", onBattery: true }),
    null,
  );
  assert.equal(
    companionWakeBlockerType({ enabled: true, keepAwake: true, keepScreenOn: true, platform: "darwin", onBattery: false }),
    COMPANION_APP_BLOCKER,
  );
  assert.equal(
    companionWakeBlockerType({ enabled: true, keepAwake: false, keepScreenOn: true, platform: "win32", onBattery: false }),
    null,
  );
  assert.equal(
    companionWakeBlockerType({ enabled: false, keepAwake: true, keepScreenOn: true, platform: "win32", onBattery: false }),
    null,
  );
});

test("createCompanionWakeHold swaps blocker types cleanly when keepScreenOn or AC power changes", () => {
  const blocker = fakeBlocker();
  const powerMonitor = new EventEmitter();
  let onBattery = false;
  const hold = createCompanionWakeHold({
    blocker,
    powerMonitor,
    platform: "win32",
    isOnBattery: () => onBattery,
  });

  // Default Windows AC without opt-in uses prevent-app-suspension.
  assert.equal(hold.sync(true, true, false), COMPANION_APP_BLOCKER);
  assert.deepEqual(blocker.calls, [["start", COMPANION_APP_BLOCKER, 1]]);

  // Opting into keepScreenOn starts prevent-display-sleep before stopping the old blocker.
  assert.equal(hold.sync(true, true, true), COMPANION_DISPLAY_BLOCKER);
  assert.deepEqual(blocker.calls, [
    ["start", COMPANION_APP_BLOCKER, 1],
    ["start", COMPANION_DISPLAY_BLOCKER, 2],
    ["stop", 1],
  ]);

  // Switching to battery releases the display wake lock immediately.
  onBattery = true;
  powerMonitor.emit("on-battery");
  assert.equal(hold.holding(), false);
  assert.equal(hold.activeType(), null);
  assert.deepEqual(blocker.calls.at(-1), ["stop", 2]);

  // Returning to AC restores prevent-display-sleep.
  onBattery = false;
  powerMonitor.emit("on-ac");
  assert.equal(hold.activeType(), COMPANION_DISPLAY_BLOCKER);
  assert.deepEqual(blocker.calls.at(-1), ["start", COMPANION_DISPLAY_BLOCKER, 3]);

  // Toggling keepScreenOn back off returns to prevent-app-suspension.
  assert.equal(hold.sync(true, true, false), COMPANION_APP_BLOCKER);
  assert.equal(hold.activeType(), COMPANION_APP_BLOCKER);

  hold.stop();
  assert.equal(hold.holding(), false);
  assert.equal(powerMonitor.listenerCount("on-ac"), 0);
  assert.equal(powerMonitor.listenerCount("on-battery"), 0);
});
