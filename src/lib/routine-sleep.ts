import { useEffect, useState } from "react";

import { lateRoutineRuns } from "./late-routine";

/** A sleep the app saw is news for this long after it. */
export const SLEPT_FRESH_MS = 12 * 3_600_000;
export const MISSED_WITHIN_MS = 7 * 86_400_000;
export const MISSED_COUNT = 2;

export type RoutineSleep = { reason: "slept" } | { reason: "missed"; count: number };

type SleepRoutine = Parameters<typeof lateRoutineRuns>[0][number];
type SleepRun = Parameters<typeof lateRoutineRuns>[1][number];

/** Why this computer's sleep is costing its routines, or null: it went to sleep with a routine enabled here, or at least
 * two scheduled runs in the last week ran late or never ran while it slept. Never while keep awake while plugged in is
 * on, or with no routine enabled here. `wake` undefined: not known yet. */
export function routineSleep(
  wake: Pick<DesktopRoutineWake, "pluggedIn" | "sleptAt"> | null | undefined,
  routines: readonly SleepRoutine[],
  runs: readonly SleepRun[],
  now: number,
): RoutineSleep | null | undefined {
  if (!routines.some((routine) => routine.enabled && !routine.heldFor && routine.runOn === "maus")) return null;
  if (wake === undefined) return undefined;
  if (!wake || wake.pluggedIn) return null;
  if (typeof wake.sleptAt === "number" && now - wake.sleptAt >= 0 && now - wake.sleptAt < SLEPT_FRESH_MS) return { reason: "slept" };
  const count = lateRoutineRuns(routines, runs, now, MISSED_WITHIN_MS).length;
  return count >= MISSED_COUNT ? { reason: "missed", count } : null;
}

export type RoutinesBridge = NonNullable<NonNullable<Window["duskDesktop"]>["routines"]>;

/** The desktop's keep-awake state, read every `everyMs` and when the window comes back; null without the bridge or
 * when it fails, undefined until the first answer. */
export function useRoutineWake(bridge: RoutinesBridge | undefined, everyMs = 60_000): [DesktopRoutineWake | null | undefined, (next: DesktopRoutineWake) => void] {
  const [state, setState] = useState<DesktopRoutineWake | null | undefined>(bridge ? undefined : null);
  useEffect(() => {
    if (!bridge) { setState(null); return; }
    let cancelled = false;
    const load = () => bridge.wakeState().then((next) => { if (!cancelled) setState(next); }, () => { if (!cancelled) setState((was) => was ?? null); });
    void load();
    const timer = setInterval(load, everyMs);
    window.addEventListener("focus", load);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener("focus", load); };
  }, [bridge, everyMs]);
  return [state, setState];
}

/** "Mac", "PC" or "computer", for the sleep card and its setting. */
export function sleepDevice(platform: string | undefined): "mac" | "pc" | "computer" {
  return platform === "darwin" ? "mac" : platform === "win32" ? "pc" : "computer";
}
