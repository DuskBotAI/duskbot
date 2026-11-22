import { useMemo } from "react";
import { routineStartOf } from "../../shared/routine-run";
import type { Routine } from "../../shared/routines";
import type { Message } from "@/state/store";

/** How a failed turn started by an automation is tried again: as a new run of its routine, never by sending its prompt
 * as the person's message. Only "ready" offers a retry; "event" is a webhook or app event's run, which only its sender
 * can start again. */
export type RoutineRetry =
  | { state: "ready" | "paused"; routineId: string; name: string }
  | { state: "gone" | "event"; name: string };

export function routineRetryFor(message: Pick<Message, "role" | "text" | "routineStart"> | undefined, routines: readonly Pick<Routine, "id" | "name" | "enabled">[]): RoutineRetry | null {
  const start = message ? routineStartOf(message) : null;
  if (!start) return null;
  if (!start.routineId) return { state: "event", name: start.name };
  const routine = routines.find((candidate) => candidate.id === start.routineId);
  if (!routine) return { state: "gone", name: start.name };
  return { state: routine.enabled ? "ready" : "paused", routineId: routine.id, name: routine.name };
}

/** The failed turn's routine, the one the card may name (a "gone" routine only once routines have loaded), and whether
 * Try again has anything to do. */
export function useRoutineRetry(message: Pick<Message, "role" | "text" | "routineStart"> | undefined, routines: readonly Pick<Routine, "id" | "name" | "enabled">[], loadState: string | undefined) {
  const retry = useMemo(() => routineRetryFor(message, routines), [message, routines]);
  const known = retry && (retry.state !== "gone" || loadState === "ready") ? retry : null;
  return { retry, known, canRetry: Boolean(message) && (!retry || retry.state === "ready") };
}
