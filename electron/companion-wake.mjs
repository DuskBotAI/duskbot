/** Electron powerSaveBlocker modes for remote phone access. */
export const COMPANION_APP_BLOCKER = "prevent-app-suspension";
export const COMPANION_DISPLAY_BLOCKER = "prevent-display-sleep";

/**
 * Picks the Electron powerSaveBlocker type for remote phone access.
 * Never holds the computer awake on battery power (matching routine wake and
 * VPS link). On Windows AC power, uses prevent-display-sleep so Modern Standby
 * (S0) systems do not suspend child processes when the display turns off.
 */
export function companionWakeBlockerType({
  enabled,
  keepAwake,
  platform = process.platform,
  onBattery = false,
}) {
  if (!enabled || !keepAwake || onBattery) return null;
  return platform === "win32" ? COMPANION_DISPLAY_BLOCKER : COMPANION_APP_BLOCKER;
}

/**
 * Manages the Electron powerSaveBlocker for remote phone access and re-evaluates
 * immediately whenever powerMonitor switches between AC and battery power.
 */
export function createCompanionWakeHold({
  blocker,
  powerMonitor,
  platform = process.platform,
  isOnBattery = () => false,
  log = () => {},
}) {
  let blockerId = null;
  let activeType = null;
  let desired = { enabled: false, keepAwake: false };
  let listening = false;
  let stopped = false;

  const battery = () => {
    try {
      return isOnBattery() === true;
    } catch {
      return false;
    }
  };

  const evaluate = () => {
    const onBattery = battery();
    const nextType = stopped
      ? null
      : companionWakeBlockerType({
          enabled: desired.enabled,
          keepAwake: desired.keepAwake,
          platform,
          onBattery,
        });

    if (nextType === activeType && (nextType === null || (blockerId !== null && blocker.isStarted(blockerId)))) {
      return activeType;
    }

    const previousId = blockerId;
    if (nextType !== null) {
      blockerId = blocker.start(nextType);
      activeType = nextType;
      log(`companion wake: holding this computer awake (${nextType})`);
    } else {
      blockerId = null;
      activeType = null;
      if (previousId !== null) {
        const reason = stopped ? "stopped" : onBattery ? "battery" : "disabled";
        log(`companion wake: released (${reason})`);
      }
    }

    if (previousId !== null && blocker.isStarted(previousId)) {
      blocker.stop(previousId);
    }
    return activeType;
  };

  const onPowerChange = () => {
    evaluate();
  };

  const listen = () => {
    if (listening || !powerMonitor?.on) return;
    listening = true;
    powerMonitor.on("on-ac", onPowerChange);
    powerMonitor.on("on-battery", onPowerChange);
  };

  return {
    sync(enabled, keepAwake) {
      stopped = false;
      desired = { enabled: Boolean(enabled), keepAwake: Boolean(keepAwake) };
      listen();
      return evaluate();
    },
    stop() {
      stopped = true;
      desired = { enabled: false, keepAwake: false };
      if (listening && powerMonitor?.removeListener) {
        powerMonitor.removeListener("on-ac", onPowerChange);
        powerMonitor.removeListener("on-battery", onPowerChange);
        listening = false;
      }
      evaluate();
    },
    activeType: () => activeType,
    holding: () => blockerId !== null,
  };
}
