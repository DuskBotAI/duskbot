import type { Routine, RoutineRun } from "./routines";

/** A scheduled run that started this much after its time waited on this computer, most often for it to wake. */
export const LATE_MS = 30 * 60_000;
/** Only a run from the last few days is worth a word: an older one is news nobody needs. */
export const RECENT_MS = 3 * 86_400_000;

export interface LateRoutineRun {
  runId: string;
  routineId: string;
  name: string;
  dueAt: number;
  /** When it ran; null when it never did (this computer was off past the catch-up window). */
  ranAt: number | null;
}

type LateRoutine = Pick<Routine, "id" | "name" | "enabled" | "heldFor" | "runOn" | "schedule">;
type LateRun = Pick<RoutineRun, "id" | "routineId" | "runOn" | "manual" | "dryRun" | "triggerSource" | "status" | "error" | "scheduledFor" | "startedAt" | "retried">;

/** Every scheduled run on this computer, due in the last `withinMs`, that ran late or never ran because the computer
 * was off. Manual, test, event and limit-reset runs never count, nor a routine that is off or held. */
export function lateRoutineRuns(routines: readonly LateRoutine[], runs: readonly LateRun[], now: number, withinMs = RECENT_MS): LateRoutineRun[] {
  const found: LateRoutineRun[] = [];
  for (const run of runs) {
    if (run.runOn !== "maus" || run.manual || run.dryRun || (run.triggerSource ?? "schedule") !== "schedule") continue;
    if (run.scheduledFor > now || now - run.scheduledFor > withinMs) continue;
    const routine = routines.find((entry) => entry.id === run.routineId);
    if (!routine || !routine.enabled || routine.heldFor || routine.runOn !== "maus" || routine.schedule.type === "limit_reset") continue;
    const offline = run.status === "missed" && /offline/i.test(run.error ?? "");
    const late = !["missed", "cancelled"].includes(run.status) && !run.retried && run.startedAt !== undefined && run.startedAt - run.scheduledFor >= LATE_MS;
    if (!offline && !late) continue;
    found.push({ runId: run.id, routineId: routine.id, name: routine.name, dueAt: run.scheduledFor, ranAt: offline ? null : run.startedAt ?? null });
  }
  return found;
}

/** The newest of `lateRoutineRuns` from the last few days: the moment dusk cloud is plainly worth it. */
export function lateRoutineRun(routines: readonly LateRoutine[], runs: readonly LateRun[], now: number): LateRoutineRun | null {
  let found: LateRoutineRun | null = null;
  for (const run of lateRoutineRuns(routines, runs, now)) if (!found || run.dueAt > found.dueAt) found = run;
  return found;
}
