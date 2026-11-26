import fs from "node:fs";
import path from "node:path";

export const ROUTINE_WAKE_POLL_MS = 60_000;
/** After a wake, the network counts as back after this many online reads in a row, one per ONLINE_POLL_MS. */
export const ONLINE_READS = 2;
export const ONLINE_POLL_MS = 2_000;
/** Routines go ahead after this even without the network, as they did before the hold. */
export const ONLINE_WAIT_MS = 120_000;
const NOTIFY_ATTEMPTS = 3;

/** Keeps the system from idle-sleeping while letting the display turn off on macOS/Linux. */
export const ROUTINE_WAKE_BLOCKER = "prevent-app-suspension";
/** On Windows AC power, prevents Modern Standby (S0) entry when the display idles off. */
export const ROUTINE_WAKE_WINDOWS_BLOCKER = "prevent-display-sleep";

export function routineWakeBlockerType(platform = process.platform) {
  return platform === "win32" ? ROUTINE_WAKE_WINDOWS_BLOCKER : ROUTINE_WAKE_BLOCKER;
}

/**
 * `enabled`: hold the hour before a run is due. `pluggedIn`: hold whenever a routine is enabled on this computer
 * (`status.routines`, from GET /api/routines/wake). Either only on AC power.
 */
export function routineWakeDecision({ enabled, pluggedIn = false, onBattery, status }) {
  if (!enabled && !pluggedIn) return { hold: false, reason: "off", at: null };
  if (onBattery) return { hold: false, reason: "battery", at: null };
  if (pluggedIn && (status?.routines ?? 0) > 0) return { hold: true, reason: "plugged-in", at: null };
  if (!enabled || !status || status.hold !== true) return { hold: false, reason: "idle", at: null };
  return { hold: true, reason: status.reason === "running" ? "running" : "due", at: typeof status.at === "number" ? status.at : null };
}

/** Going to sleep is worth a word only while a routine here would miss its time and the person has not chosen to stay awake. */
export const sleepMissesRoutines = ({ pluggedIn, status }) => !pluggedIn && (status?.routines ?? 0) > 0;

const settingsFile = (userData) => path.join(userData, "routine-wake.json");

/** routine-wake.json: `keepAwake` (default on) and `keepAwakePluggedIn` (default off). */
export function routineWakeSettings(userData) {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(userData), "utf8"));
    return { keepAwake: parsed?.keepAwake !== false, pluggedIn: parsed?.keepAwakePluggedIn === true };
  } catch {
    return { keepAwake: true, pluggedIn: false };
  }
}

/** The renderer's `{ keepAwake?, pluggedIn? }`: only booleans pass. */
export function routineWakePatch(patch) {
  const out = {};
  for (const key of ["keepAwake", "pluggedIn"]) if (typeof patch?.[key] === "boolean") out[key] = patch[key];
  return out;
}

/** `patch`: `{ keepAwake?, pluggedIn? }`, merged over what is saved. */
export function rememberRoutineWake(userData, patch) {
  const next = { ...routineWakeSettings(userData), ...patch };
  const file = settingsFile(userData);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ keepAwake: next.keepAwake !== false, keepAwakePluggedIn: next.pluggedIn === true }, null, 2));
    fs.renameSync(temporary, file);
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
    }
  }
}

/**
 * `deps`:
 * - fetchStatus(): Promise<{hold, reason?, at?} | null>, the server's answer, null when unreachable
 * - isOnBattery(): boolean
 * - blocker: { start(type): id, stop(id), isStarted(id): boolean }, Electron's powerSaveBlocker
 * - settings(): { keepAwake: boolean, pluggedIn: boolean }
 * - log(line)
 * - powerMonitor?: { on(event, listener) }, Electron's, once the app is ready
 * - now?(): number
 * - isOnline?(): boolean, Electron's net.isOnline
 * - notify?(event): Promise<unknown>, tells the server "suspend", "resume" or "online" (POST /api/routines/wake)
 */
export function createRoutineWakeHold(deps) {
  let blockerId = null;
  let timer = null;
  let last = { hold: false, reason: "idle", at: null };
  let status = null;
  let sleptAt = null;
  let listening = false;

  const blockerType = routineWakeBlockerType(deps.platform);

  const apply = (decision) => {
    if (decision.hold && blockerId === null) {
      blockerId = deps.blocker.start(blockerType);
      deps.log?.(`routine wake: holding this computer awake (${decision.reason}${decision.at ? ` at ${new Date(decision.at).toISOString()}` : ""})`);
    } else if (!decision.hold && blockerId !== null) {
      if (deps.blocker.isStarted(blockerId)) deps.blocker.stop(blockerId);
      blockerId = null;
      deps.log?.(`routine wake: released (${decision.reason})`);
    }
    last = decision;
  };

  const poll = async () => {
    status = await Promise.resolve()
      .then(() => deps.fetchStatus())
      .catch(() => null);
    const settings = deps.settings();
    apply(routineWakeDecision({ enabled: settings.keepAwake, pluggedIn: settings.pluggedIn, onBattery: deps.isOnBattery(), status }));
    return state();
  };

  const state = () => {
    const settings = deps.settings();
    return { ...last, keepAwake: settings.keepAwake, pluggedIn: settings.pluggedIn, onBattery: deps.isOnBattery(), sleptAt };
  };

  const suspended = () => {
    if (sleepMissesRoutines({ pluggedIn: deps.settings().pluggedIn, status })) sleptAt = (deps.now ?? Date.now)();
  };

  const listen = () => {
    if (listening || !deps.powerMonitor) return;
    listening = true;
    deps.powerMonitor.on("suspend", suspended);
    // a plug or unplug changes the answer at once, not at the next poll
    deps.powerMonitor.on("on-ac", () => void poll());
    deps.powerMonitor.on("on-battery", () => void poll());
  };

  const wake = watchWake(deps);

  return {
    start() {
      if (timer) return;
      wake.watch();
      listen();
      void poll();
      timer = setInterval(() => void poll(), deps.pollMs ?? ROUTINE_WAKE_POLL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      apply({ hold: false, reason: "stopped", at: null });
    },
    poll,
    state,
    holding: () => blockerId !== null,
  };
}

/** Tells the server when this computer sleeps and wakes, and when the network is back after a wake. */
export function watchWake(deps) {
  let watching = false;
  let waking = null;
  const pause = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

  const tell = async (event) => {
    for (let attempt = 1; attempt <= NOTIFY_ATTEMPTS; attempt++) {
      try {
        await deps.notify(event);
        return true;
      } catch {
        if (attempt < NOTIFY_ATTEMPTS) await pause(1_000);
      }
    }
    deps.log?.(`routine wake: the server did not hear "${event}"`);
    return false;
  };

  const awaitNetwork = async (run) => {
    const started = Date.now();
    let online = 0;
    while (run === waking && Date.now() - started < (deps.onlineWaitMs ?? ONLINE_WAIT_MS)) {
      online = deps.isOnline() ? online + 1 : 0;
      if (online >= ONLINE_READS) break;
      await pause(deps.onlinePollMs ?? ONLINE_POLL_MS);
    }
    if (run !== waking) return;
    waking = null;
    if (online < ONLINE_READS) deps.log?.(`routine wake: no network ${Math.round((deps.onlineWaitMs ?? ONLINE_WAIT_MS) / 1_000)} s after waking; routines go ahead`);
    await tell("online");
  };

  return {
    watch() {
      if (watching || !deps.powerMonitor || !deps.notify || !deps.isOnline) return;
      watching = true;
      deps.powerMonitor.on("suspend", () => {
        waking = null;
        void tell("suspend");
      });
      deps.powerMonitor.on("resume", () => {
        const run = {};
        waking = run;
        void tell("resume").then(() => awaitNetwork(run));
      });
    },
  };
}
