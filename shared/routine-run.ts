/** Durable, non-actionable projection of one background routine run.
 *
 * The provider still runs in its isolated execution task. This small card is
 * upserted into the trusted conversation that created the routine so the user
 * can see progress, results, and where to review an approval without hunting
 * through the routines calendar.
 */
import type { RoutineRunTrigger } from "./routines.ts";

export interface RoutineRunCardData {
  runId: string;
  routineId: string;
  routineName: string;
  scheduledFor?: number;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "missed";
  /** Present while a queued run is being held because its target bot or room
   * is busy. The status stays queued; this is the surfaced deferral fact. */
  deferredAt?: number;
  /** Exact terminal team-goal outcome when this run targeted a room. */
  goalStatus?: "completed" | "needs-input" | "blocked" | "limit-reached" | "paused" | "stopped" | "failed";
  executionThreadId?: string;
  summary?: string;
  error?: string;
}

/** A bot line one automation run wrote into the chat it reports to: the run's
 * result, a copy of a card the run waits on (answering it there answers the
 * run), or why the run failed. The run works in its own hidden conversation,
 * `executionThreadId`, which keeps its full transcript. */
export interface AutomationLine {
  routineId: string;
  runId: string;
  name: string;
  /** What started the run; "app" is a connected-app event, "wait" a wait's follow-up. A Bot API call starts a turn,
   * never a run, so "api" is never seen here. */
  trigger: RoutineRunTrigger | "app" | "wait" | "job";
  executionThreadId: string;
  scheduledFor: number;
  /** The run needs the person: it asked them something or cannot go on without them. */
  needsYou?: true;
  failed?: true;
  /** With `failed`: the run's reply came back; only a step it ran failed or wasn't allowed. */
  partial?: true;
  /** A run that had nothing new, posted only because this automation's line before it in the chat said a run failed. */
  recovered?: true;
  /** The card in the run's conversation this line stands for: an option card
   * is copied whole, a sign-in, connection or credential card is named. */
  copyOf?: string;
}

/** A routine run's opening line in its own conversation: what the person sees instead of the prompt the bot was given. */
export interface RoutineStartLine { name: string }

const ROUTINE_PROMPT_HEAD = /^\[(?:Scheduled routine|Routine) ("(?:[^"\\]|\\.)*"), do this now:\]/u;

/** The routine's name from a run's prompt (server/routine-execution.ts writes the header), else null. Older lines carry no
 * `routineStart` mark, so the header is how they are known. */
export function routinePromptName(text: string | undefined): string | null {
  const head = text ? ROUTINE_PROMPT_HEAD.exec(text) : null;
  if (!head) return null;
  try { const name = JSON.parse(head[1]!); return typeof name === "string" ? name : null; } catch { return null; }
}

/** The exact silence token a routine run answers with when nothing needs the person: a line of its own, never shown. */
export const SILENT_LINE = /^[\s*_`"'.!-]*nothing new[\s*_`"'.!-]*$/i;
