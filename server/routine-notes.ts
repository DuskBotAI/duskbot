import { ROUTINE_NOTES_MAX } from "./routine-execution.ts";
import type { Routine, RoutineRun } from "./routines.ts";

export const ROUTINE_NOTE_MESSAGES = {
  notInRun: "trigger action=note works only inside a run of an automation: it keeps notes for that automation's next run.",
  confined: "This run only reads and drafts, so it keeps no notes.",
  text: `note: the whole notes for the next run, at most ${ROUTINE_NOTES_MAX} characters (an empty note clears them).`,
  gone: "That automation no longer exists.",
  failNotInRun: "trigger action=fail works only inside a run of an automation: it ends that run as failed.",
  failReason: "reason: one line saying why the job could not be done.",
} as const;

/** trigger action=note from a routine run: replaces the notes of the run's own automation, never another's. Null for any
 * other trigger request. */
export function routineNoteRequest(body: unknown, run: RoutineRun | null, setNotes: (routineId: string, notes: string) => Routine | null): { status: number; body: Record<string, unknown> } | null {
  if (!body || typeof body !== "object" || (body as { action?: unknown }).action !== "note") return null;
  if (!run || run.target !== "bot" || run.triggerSource === "webhook") return { status: 403, body: { error: ROUTINE_NOTE_MESSAGES.notInRun } };
  if (run.access === "read-and-draft") return { status: 403, body: { error: ROUTINE_NOTE_MESSAGES.confined } };
  const note = (body as { note?: unknown }).note;
  if (typeof note !== "string" || note.length > ROUTINE_NOTES_MAX) return { status: 400, body: { error: ROUTINE_NOTE_MESSAGES.text } };
  const routine = setNotes(run.routineId, note);
  if (!routine) return { status: 404, body: { error: ROUTINE_NOTE_MESSAGES.gone } };
  return { status: 200, body: { text: routine.notes ? `Saved the notes of “${routine.name}”: its next run reads them.` : `Cleared the notes of “${routine.name}”.` } };
}

const FAIL_REASON_MAX = 200;

/** trigger action=fail from a routine run: the run in progress ends as failed with the reason, like any failed run. Null for
 * any other trigger request. */
export function routineFailRequest(body: unknown, run: RoutineRun | null, markFailed: (runId: string, reason: string) => boolean): { status: number; body: Record<string, unknown> } | null {
  if (!body || typeof body !== "object" || (body as { action?: unknown }).action !== "fail") return null;
  if (!run || run.target !== "bot") return { status: 403, body: { error: ROUTINE_NOTE_MESSAGES.failNotInRun } };
  const raw = (body as { reason?: unknown }).reason;
  const reason = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, FAIL_REASON_MAX) : "";
  if (!reason) return { status: 400, body: { error: ROUTINE_NOTE_MESSAGES.failReason } };
  if (!markFailed(run.id, reason)) return { status: 409, body: { error: ROUTINE_NOTE_MESSAGES.failNotInRun } };
  return { status: 200, body: { text: `This run will end as failed: ${reason}` } };
}
