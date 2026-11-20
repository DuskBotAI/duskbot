// A routine run that asks the person something waits for them: its run limit bounds active work only, and an
// approval nobody answered ends the run with that reason. The engines' own prompts stay the only gates.
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import { redactSecretsInText } from "./redact.ts";
import type { RoutineRun } from "./routines.ts";

type Opened = RuntimeEvent & { type: "request.opened" };
type Resolved = RuntimeEvent & { type: "request.resolved" };

/** The open request a run waits on, from when it opened. */
export interface RoutineRunAsk {
  requestId?: string;
  approval: boolean;
  /** "to use COMPOSIO_SEARCH_TOOLS", "to run “ls”", or the question asked. */
  subject: string;
  since: number;
  pending?: RoutineRunAsk[];
}

// ACP permission kinds and the drivers' generic names say nothing about which tool asked.
const GENERIC_TOOLS = new Set(["edit", "tool", "mcp", "other", "permissions", "read", "fetch", "search", "delete", "move", "think"]);
const SHELL_TOOLS = new Set(["shell", "bash", "execute"]);

const plain = (text: string, max: number) => {
  const line = redactSecretsInText(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

function approvalSubject(tool: string, summary: string): string {
  const named = tool.startsWith("mcp__") ? tool.split("__").slice(2).join("__") : tool;
  const what = plain(summary, 120) || named || "an action";
  if (SHELL_TOOLS.has(named.toLowerCase())) return `to run “${what}”`;
  return named && !GENERIC_TOOLS.has(named.toLowerCase()) ? `to use ${plain(named, 80)}` : `for “${what}”`;
}

export function askOf(event: Opened, now: number): RoutineRunAsk {
  const approval = event.requestType === "permission" && !event.questions?.length;
  return {
    ...(event.requestId ? { requestId: event.requestId } : {}),
    approval,
    subject: approval ? approvalSubject(event.tool, event.summary) : plain(event.summary, 500),
    since: now,
  };
}

export function openAsk(run: RoutineRun, event: Opened, now: number): RoutineRunAsk {
  if (!run.asked) return run.asked = askOf(event, now);
  if (!event.requestId || !run.asked.requestId || event.requestId === run.asked.requestId || run.asked.pending?.some((ask) => ask.requestId === event.requestId)) return run.asked;
  (run.asked.pending ??= []).push(askOf(event, now));
  return run.asked;
}

export function matchesAsk(run: RoutineRun, event: Resolved): boolean {
  const ask = run.asked;
  return Boolean(ask && (!ask.requestId || !event.requestId || ask.requestId === event.requestId || ask.pending?.some((pending) => pending.requestId === event.requestId)));
}

export function loadAsk(value: unknown): RoutineRunAsk | undefined {
  const basic = (candidate: unknown): RoutineRunAsk | undefined => {
    if (!candidate || typeof candidate !== "object") return undefined;
    const ask = candidate as Partial<RoutineRunAsk>;
    if (typeof ask.approval !== "boolean" || typeof ask.subject !== "string" || !Number.isSafeInteger(ask.since) || ask.since! < 0) return undefined;
    return { approval: ask.approval, subject: ask.subject.slice(0, 500), since: ask.since!, ...(typeof ask.requestId === "string" ? { requestId: ask.requestId } : {}) };
  };
  const ask = basic(value);
  if (!ask) return undefined;
  const pending = (value as RoutineRunAsk).pending;
  if (Array.isArray(pending)) {
    const loaded = pending.flatMap((candidate) => basic(candidate) ?? []);
    if (loaded.length) ask.pending = loaded;
  }
  return ask;
}

/** What the run's card and the Routines log show while it waits. */
export function waitingFor(ask: RoutineRunAsk): string | undefined {
  return ask.approval ? `Waiting for your approval ${ask.subject}` : ask.subject || undefined;
}

/** Ends the run's wait on the person. Returns why the run stops when an approval closed with nobody's answer. */
export function settleAsk(run: RoutineRun, event: Resolved | undefined, now: number): string | null {
  const ask = run.asked;
  if (!ask || event && !matchesAsk(run, event)) return null;
  const all = [ask, ...ask.pending ?? []];
  const answered = event?.requestId ? all.find((candidate) => candidate.requestId === event.requestId) ?? ask : ask;
  const unanswered = answered.approval && event?.source === "timeout" ? `Stopped: nobody answered the approval ${answered.subject}` : null;
  if (event && !unanswered) {
    const remaining = all.filter((candidate) => candidate !== answered);
    if (remaining.length) {
      const [next, ...pending] = remaining;
      run.asked = { ...next!, since: ask.since };
      if (pending.length) run.asked.pending = pending;
      else delete run.asked.pending;
      return null;
    }
  }
  run.waitedMs = (run.waitedMs ?? 0) + Math.max(0, now - ask.since);
  delete run.asked;
  return unanswered;
}

/** Time the run has worked: waiting on the person never counts toward its limit. */
export function activeMs(run: Pick<RoutineRun, "startedAt" | "waitedMs" | "asked">, now: number): number {
  return now - (run.startedAt ?? now) - (run.waitedMs ?? 0) - (run.asked ? Math.max(0, now - run.asked.since) : 0);
}

/** How long a run waits on a question nobody answers before it stops. */
export const QUESTION_WAIT_MS = 24 * 60 * 60_000;

/** The person wrote in the run's chat: their words answer its questions, while an approval still waits for its card. */
export function answeredInChat(run: RoutineRun, now: number): boolean {
  const ask = run.asked;
  if (!ask) return false;
  const all = [ask, ...ask.pending ?? []];
  const approvals = all.filter((candidate) => candidate.approval);
  if (approvals.length === all.length) return false;
  if (!approvals.length) {
    run.waitedMs = (run.waitedMs ?? 0) + Math.max(0, now - ask.since);
    delete run.asked;
    return true;
  }
  const [next, ...pending] = approvals;
  run.asked = { ...next!, since: ask.since, ...(pending.length ? { pending } : {}) };
  if (!pending.length) delete run.asked.pending;
  return true;
}

/** Why the run stops when the question it waits on went unanswered for QUESTION_WAIT_MS. */
export function unansweredQuestion(run: Pick<RoutineRun, "asked">, now: number): string | null {
  const ask = run.asked;
  return ask && !ask.approval && now - ask.since >= QUESTION_WAIT_MS ? `Stopped: nobody answered the question “${plain(ask.subject, 120)}”` : null;
}

/** Why a started run stops now: a question nobody answered, or its run limit. */
export function stopDue(run: RoutineRun, now: number): { detail: string; status: "stopped" | "limit-reached" } | null {
  if (run.status !== "running" && run.status !== "waiting") return null;
  const unanswered = run.status === "waiting" ? unansweredQuestion(run, now) : null;
  if (unanswered) return { detail: unanswered, status: "stopped" };
  return run.startedAt != null && run.timeoutMinutes != null && activeMs(run, now) >= run.timeoutMinutes * 60_000
    ? { detail: `Stopped after reaching the ${run.timeoutMinutes}-minute run limit`, status: "limit-reached" } : null;
}
