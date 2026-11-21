import { cloneAttachments } from "./routine-attachments.ts";
import { cloneSchedule } from "./routine-schedules.ts";
import type { Routine, RoutineManagerOptions, RoutineRequestOwner, RoutineRun } from "./routines.ts";

export type ResultsThreadAllocation = { botId: string; threadId: string };

export function cloneRoutine(routine: Routine): Routine {
  return { ...routine, schedule: cloneSchedule(routine.schedule), attachments: cloneAttachments(routine.attachments) };
}

export const routineRequestOwnerKey = (owner: RoutineRequestOwner): string => JSON.stringify([owner.requestId, owner.messageId, owner.botId, owner.threadId]);

export function cloneRun(run: RoutineRun): RoutineRun {
  return {
    ...run,
    ...(run.asked ? { asked: structuredClone(run.asked) } : {}),
    attachments: cloneAttachments(run.attachments),
    denials: run.denials ? [...run.denials] : undefined,
  };
}

export function resolveRoutineResultsThread(
  routine: Routine,
  resolve: RoutineManagerOptions["resolveResultsThread"],
  allocations: ResultsThreadAllocation[],
  now: number,
  sourceThreadId = routine.sourceThreadId,
): string | undefined {
  if (routine.target !== "bot" || !resolve) return routine.resultsThreadId;
  const destination = resolve({ ...routine, sourceThreadId }, false);
  const own = destination?.main ? undefined : destination?.threadId;
  if (own !== routine.resultsThreadId) {
    if (own) allocations.push({ botId: routine.botId, threadId: own });
    if (own) routine.resultsThreadId = own;
    else delete routine.resultsThreadId;
    routine.updatedAt = Math.max(now, routine.updatedAt + 1);
  }
  return destination?.threadId;
}

export function routineRunDefinition(routine: Routine): Pick<RoutineRun,
  "routineName" | "prompt" | "durationMinutes" | "timeoutMinutes" | "attachments" | "target" | "groupId" | "botId" | "runOn" | "access" | "deliver"> {
  return {
    routineName: routine.name,
    prompt: routine.prompt,
    durationMinutes: routine.durationMinutes,
    ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
    attachments: cloneAttachments(routine.attachments),
    target: routine.target,
    groupId: routine.groupId,
    botId: routine.botId,
    runOn: routine.runOn ?? "maus",
    access: routine.access,
    deliver: routine.deliver,
  };
}

/** A bot routine's run works in the chat it reports to, as any message there would. A webhook's payload, a room goal, a
 * run whose answer goes to the brief and a read-and-draft run keep a conversation of their own.
 * Security invariant: a read-and-draft run is confined by its conversation (server/read-and-draft.ts), so it never
 * joins one a person works in. */
export function runAnswersInItsChat(run: Pick<RoutineRun, "target" | "triggerSource" | "resultsThreadId" | "deliver" | "access">): boolean {
  return run.target === "bot" && run.triggerSource !== "webhook" && run.deliver !== "brief" && run.access !== "read-and-draft" && Boolean(run.resultsThreadId);
}

/** The run worked in a conversation of its own, not one it joined, so that conversation stays the run's once it ends. */
export function ranApart(run: Pick<RoutineRun, "threadId" | "resultsThreadId" | "sourceThreadId">): boolean {
  return Boolean(run.threadId) && run.threadId !== run.resultsThreadId && run.threadId !== run.sourceThreadId;
}
