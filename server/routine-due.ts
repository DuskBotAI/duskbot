// When routines next need this machine: the desktop's keep-awake (`wakeHold`) and a Cloud home's sleep check
// (server/cloud-power.ts). Pure over RoutineManager's routines and runs.
import type { Routine, RoutineRun } from "./routines.ts";
import { DUE_CLOCK_MS } from "./due-timer.ts";
import { flexOf } from "./routine-quiet.ts";
import { nextOccurrence } from "./routine-schedules.ts";
import { activeMs, QUESTION_WAIT_MS } from "./routine-waits.ts";

export const CATCH_UP_MS = 12 * 60 * 60_000;
type CatchUp = Pick<Routine, "schedule" | "catchUpMinutes" | "timing" | "checks">;
const ownCatchUp = (routine: CatchUp) =>
  routine.schedule.type === "once" || routine.schedule.type === "limit_reset" ? undefined : routine.catchUpMinutes;
/** How late after its time a missed run may still start. A routine's own window counts from the end of its "around"
 * window, plus one due-clock tick, so a run that starts on time is never missed. A once routine and a limit reset keep
 * the 12 hours. */
export const catchUpMsOf = (routine: CatchUp) => {
  const minutes = ownCatchUp(routine);
  return minutes === undefined ? CATCH_UP_MS : minutes * 60_000 + flexOf(routine) + DUE_CLOCK_MS;
};
export const missedError = (routine: CatchUp) => {
  const minutes = ownCatchUp(routine);
  return minutes === undefined
    ? "This computer was offline for more than 12 hours after the scheduled time"
    : `This computer could not start the run within ${minutes} minutes of the scheduled time`;
};

type Due = Pick<Routine, "enabled" | "nextRunAt" | "checks" | "wakeAt" | "checkedAt"> & Partial<Pick<Routine, "timing" | "schedule">>;
/** The latest a run may start: its time, or the end of its window when it may move. */
const latestOf = (routine: Due): number | null => routine.nextRunAt == null ? null : routine.nextRunAt + (routine.schedule ? flexOf(routine as Pick<Routine, "timing" | "schedule" | "checks">) : 0);
type Run = Pick<RoutineRun, "status" | "retryAt">;
const startsLater = (run: Run, now: number) => run.status === "queued" && (run.retryAt ?? 0) > now;
/** Every time a run is due: enabled routines' next runs and queued runs' retries. A routine with checks counts only the
 * next time they have something to do on time (`checksDue`). */
const dueTimes = (routines: readonly Due[], runs: readonly Run[], now: number, checksDue: (routine: Due) => number | undefined, at: (routine: Due) => number | null = (routine) => routine.nextRunAt) =>
  [...routines.filter((routine) => routine.enabled).map((routine) => routine.checks ? checksDue(routine) : at(routine)),
    ...runs.filter((run) => startsLater(run, now)).map((run) => run.retryAt)].filter((at): at is number => typeof at === "number");

/** On the desktop, plain checks run whenever the computer is awake and never keep it awake. */
const meetingsDue = (routine: Due) => routine.wakeAt;
/** A Cloud home wakes for its routines' checks exactly on their schedule (the routine's next check), or sooner when a
 * check has something to do on time. One already past stays due until the scheduler runs it. */
const cloudChecksDue = (_now: number) => (routine: Due) => {
  if (routine.nextRunAt == null || !routine.checks?.length) return routine.wakeAt;
  return Math.min(routine.wakeAt ?? Infinity, routine.nextRunAt);
};

/** Hold the desktop awake: a run that started (or waits on a person), or one due within the horizon. */
export function wakeHoldOf(routines: readonly Due[], runs: readonly Run[], now: number, horizonMs: number): { hold: boolean; reason?: "running" | "due"; at?: number } {
  if (runs.some((run) => ["queued", "running", "waiting"].includes(run.status) && !startsLater(run, now))) return { hold: true, reason: "running" };
  const due = dueTimes(routines, runs, now, meetingsDue).filter((at) => at <= now + horizonMs).sort((a, b) => a - b)[0];
  return due === undefined ? { hold: false } : { hold: true, reason: "due", at: due };
}

/** Enabled routines that run on this machine and are not held: what the desktop's keep-awake while plugged in waits on. */
export const enabledHereOf = (routines: readonly Pick<Routine, "enabled" | "runOn" | "heldFor">[]) =>
  routines.filter((routine) => routine.enabled && !routine.heldFor && (routine.runOn ?? "maus") === "maus").length;

/** A Cloud home's sleep check: a run queued to start now, or running, keeps it awake. One waiting for a person does
 * not: their answer wakes the home. */
export const activeRunsOf = (runs: readonly Run[], now: number) => runs.some((run) => run.status === "running" || (run.status === "queued" && !startsLater(run, now)));

/** The earliest time a run is due; null when none. A run that may move counts at the end of its window: an Admin that
 * reads only this still wakes the home in time, and one that reads `upcomingOf` can fold it into an earlier wake. */
export function nextDueOf(routines: readonly Due[], runs: readonly Run[], now: number): number | null {
  const due = dueTimes(routines, runs, now, cloudChecksDue(now), latestOf);
  return due.length ? Math.min(...due) : null;
}

const UPCOMING_MS = 24 * 60 * 60_000;
export const UPCOMING_MAX = 96;

/** The runs due in the next day for a Cloud home's power report (apps/cloud-service/docs/power.md): each with how far
 * it may move (`flexMs`, 0 for its exact time), at most 96, in order. Checks and retries keep their exact times. */
export function upcomingOf(routines: readonly Due[], runs: readonly Run[], now: number): Array<{ at: number; flexMs: number }> {
  const out = dueTimes(routines.filter((routine) => routine.checks), runs, now, cloudChecksDue(now)).map((at) => ({ at, flexMs: 0 }));
  for (const routine of routines) {
    if (!routine.enabled || routine.checks || routine.nextRunAt == null || !routine.schedule) continue;
    const flexMs = flexOf(routine as Pick<Routine, "timing" | "schedule" | "checks">);
    for (let at: number | null = routine.nextRunAt, count = 0; at !== null && at <= now + UPCOMING_MS && count < UPCOMING_MAX; at = nextOccurrence(routine.schedule, at), count += 1) {
      out.push({ at, flexMs });
    }
  }
  return out.filter((run) => run.at <= now + UPCOMING_MS).sort((a, b) => a.at - b.at).slice(0, UPCOMING_MAX);
}

type Started = Run & Pick<RoutineRun, "startedAt" | "timeoutMinutes" | "waitedMs" | "asked">;
/** When this process's scheduler next has work: a routine's next run, or its checks once `checksFrom` has passed; a queued
 * run (now, or its retry); a started run reaching its time limit. `skip` leaves out routines whose target is gone. */
export function schedulerDueOf<R extends Due>(routines: readonly R[], runs: readonly Started[], now: number, checksFrom: number, skip: (routine: R) => boolean = () => false, early?: (routine: R) => number): number | null {
  let at = Infinity;
  for (const routine of routines) {
    if (!routine.enabled || skip(routine)) continue;
    const next = Math.min(routine.nextRunAt == null ? Infinity : routine.nextRunAt - (early?.(routine) ?? 0), routine.checks ? routine.wakeAt ?? Infinity : Infinity);
    if (next !== Infinity) at = Math.min(at, routine.checks ? Math.max(next, checksFrom) : next);
  }
  for (const run of runs) {
    if (run.status === "queued") at = Math.min(at, run.retryAt ?? now);
    else if ((run.status === "running" || run.status === "waiting") && run.startedAt != null && run.timeoutMinutes != null) {
      at = Math.min(at, now + Math.max(0, run.timeoutMinutes * 60_000 - activeMs(run, now)));
    }
    if (run.status === "waiting" && run.asked && !run.asked.approval) at = Math.min(at, run.asked.since + QUESTION_WAIT_MS);
  }
  return at === Infinity ? null : at;
}
