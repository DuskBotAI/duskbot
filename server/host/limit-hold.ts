// A one-on-one turn its AI's usage limit refused, with no other AI to carry it, waits for the reset and then carries on
// by itself on the same AI: the card above the composer says until when, and the chat itself stays as it was. Held turns are saved, so a restart keeps
// them. A known reset wakes the turn 30 s after it; an unknown one is checked against plan usage every 15 minutes. An
// API-key engine's unknown end (OpenRouter out of credit) shows in no usage, so a quick call to it outside the chat checks
// it, soon and then less often, and when the person opens the conversation; a top-up ends the wait within minutes. The
// person's Stop, a new message of theirs, or a change of AI ends the wait. Resumes are bounded: a turn refused again
// after its reset backs off and is told, and after MAX_RESUMES the wait ends for good.
import { readFileSync } from "node:fs";

import { writeFileAtomic } from "../atomic.ts";
import { batchNote } from "./batch-continue.ts";
import { counts, type Checklist } from "../batch-checklist.ts";
import { quoteInNote } from "../peer-provenance.ts";
import { RESUME_CAUSE, RESUME_OPENS } from "../limit-resume.ts";
import { serverLine } from "../server-lines.ts";
import type { RuntimeEvent, TextGenerationOptions } from "../contracts.ts";
import { classifyError } from "../drivers/retry.ts";
import type { LimitHoldState } from "../../shared/wire.ts";

export const AFTER_RESET_MS = 30_000;
export const UNKNOWN_RESET_RECHECK_MS = 15 * 60_000;
export const MAX_RESUMES = 3;
/** A weekly window plus a day: past this nothing the engine said is still worth waiting for. */
export const MAX_HOLD_MS = 8 * 24 * 60 * 60_000;
const BUSY_RECHECK_MS = 60_000;
/** The first check of an engine only a call can test; each further one waits twice as long, up to the 15 minutes. */
export const PROBE_RECHECK_MS = 2 * 60_000;
/** Opening the conversation checks again at most this often. */
export const OPEN_RECHECK_MS = 60_000;
/** A wait that fell due while the app was closed: the engines get a moment to start first. */
export const AFTER_START_MS = 30_000;
/** setTimeout's delay is a signed 32-bit number; a longer wait is armed in steps. */
const MAX_TIMER_MS = 2_147_000_000;
/** How long a resumed turn's failure waits for the limit path to claim it before the wait is dropped. */
const CLAIM_MS = 15_000;
const REQUEST_QUOTE_MAX = 1_500;

export interface HeldTurn {
  botId: string;
  threadId: string;
  /** The AI (instance id) the turn waits for. */
  engine: string;
  engineName: string;
  /** When the engine said its limit resets; null while that is unknown. */
  resetsAt: number | null;
  wakeAt: number;
  since: number;
  /** Resumes started so far. */
  resumes: number;
  /** A resume is running; its failure is ours to judge. */
  resuming?: boolean;
  /** The person's request, quoted for the resumed turn. */
  request?: string;
  /** Checks of an engine only a call can test that found it still refusing; never saved. */
  checks?: number;
  checkedAt?: number;
  checking?: boolean;
}

export interface HoldInput {
  botId: string;
  threadId: string;
  engine: string;
  engineName: string;
  resetsAt?: number | null;
  request?: string;
}

export interface LimitHoldDeps {
  file?: string;
  now?: () => number;
  after?: (ms: number, run: () => void) => { cancel(): void };
  /** Until when the engine refuses work as far as is known, or null. */
  blockedUntil(engine: string): number | null;
  /** When the engine's limit resets, when known. */
  resetAt(engine: string): number | null;
  /** Reads plan usage again; called at most once per wake of a turn whose reset is unknown. */
  refreshUsage(): Promise<void>;
  /** Whether a call can tell this engine works again: an API-key engine held without a reset (its credit ran out). */
  canProbe?(engine: string): boolean;
  /** Asks the engine once, outside the chat: true when it answers, false when its limit still refuses, null when unknown. */
  probe?(turn: Readonly<HeldTurn>): Promise<boolean | null>;
  /** The check found the engine working: its hold ends, so this turn and every other place see it free. */
  release?(engine: string): void;
  /** The AI the conversation runs on now, or undefined when it is gone. */
  threadEngine(botId: string, threadId: string): string | undefined;
  busy(botId: string, threadId: string): boolean;
  checklist?(botId: string, threadId: string): Checklist | null;
  resume(turn: Readonly<HeldTurn>, note: string): Promise<unknown>;
  /** A status row the person reads: the wait ended without the turn going on. */
  line(threadId: string, text: string): void;
  /** The turn waits: the card above the composer says until when, with Stop waiting; nothing is added to the chat. */
  paused(threadId: string, state: LimitHoldState): void;
  /** The turn stopped waiting here (it resumed, was stopped or gave up): the card says so no longer. */
  waitEnded?(threadId: string): void;
  language?(threadId: string): string | undefined;
}

const WAITING_SCOPES: ReadonlySet<string> = new Set(["engine", "model"]);

/** Whether a turn its AI's usage limit refused before it began waits for the reset, as one refused mid-turn does: the
 * person's own request, or a held turn's resume (which then backs off). */
export function refusedStartWaits(scope: string | undefined, turn: { person: boolean; resuming: boolean }): boolean {
  return scope !== undefined && WAITING_SCOPES.has(scope) && (turn.person || turn.resuming);
}

export function resumeNote(held: Pick<HeldTurn, "engineName" | "request">, list: Checklist | null, cause: string = RESUME_CAUSE): string {
  const asked = held.request ? ` The person's request was: "${quoteInNote(held.request, REQUEST_QUOTE_MAX)}".` : "";
  const base = `${RESUME_OPENS}${held.engineName}${cause}${asked} ` +
    "Read the conversation, pick up exactly where you left off and finish that request; do not redo anything already done or tell them again what you already told them. This adds no approval for anything else.]";
  return list && counts(list).open > 0 ? `${base}\n${batchNote(list)}` : base;
}

const PROBE_TIMEOUT_MS = 30_000;

/** One tiny request to the engine on the turn's model: a refusal for want of credit costs nothing, and an answer costs a
 * few tokens once. True when it answers, false when a limit or credit still refuses it, null for any other failure. */
export async function probeEngine(generate: ((prompt: string, options?: TextGenerationOptions) => Promise<string>) | undefined, model: string | undefined,
  timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean | null> {
  if (!generate) return null;
  try {
    await generate("Reply with the single word OK.", { ...(model ? { model } : {}), timeoutMs, signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch (error) {
    const reason = classifyError(error instanceof Error ? error : { text: String(error) }).reason;
    return reason === "quota" || reason === "rate_limited" ? false : null;
  }
}

function savedTurn(value: unknown): HeldTurn | null {
  const row = value as Partial<HeldTurn> | null;
  const text = (field: unknown) => typeof field === "string" && field.length > 0 && field.length <= 500;
  if (!row || !text(row.botId) || !text(row.threadId) || !text(row.engine) || typeof row.engineName !== "string") return null;
  if (!Number.isFinite(row.wakeAt) || !Number.isFinite(row.since) || !Number.isInteger(row.resumes)) return null;
  const resetsAt = typeof row.resetsAt === "number" && Number.isFinite(row.resetsAt) ? row.resetsAt : null;
  return {
    botId: row.botId!, threadId: row.threadId!, engine: row.engine!, engineName: row.engineName.slice(0, 80), resetsAt, wakeAt: row.wakeAt!,
    since: row.since!, resumes: Math.max(0, Math.min(row.resumes!, MAX_RESUMES)), ...(typeof row.request === "string" ? { request: row.request.slice(0, 4_000) } : {}),
  };
}

export function createLimitHold(deps: LimitHoldDeps) {
  const now = deps.now ?? Date.now;
  const after = deps.after ?? ((ms: number, run: () => void) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  });
  const turns = new Map<string, HeldTurn>();
  const timers = new Map<string, { cancel(): void }>();
  let started = false;

  const say = (threadId: string, key: Parameters<typeof serverLine>[1], params?: Record<string, string | number>) =>
    deps.line(threadId, serverLine(deps.language?.(threadId), key, params));

  const save = (): void => {
    if (!deps.file) return;
    try {
      writeFileAtomic(deps.file, JSON.stringify([...turns.values()].map(({ resuming: _resuming, checks: _checks, checkedAt: _checkedAt, checking: _checking, ...turn }) => turn)), { mode: 0o600 });
    } catch (error) {
      console.error(`limit hold: could not save: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const disarm = (threadId: string): void => {
    timers.get(threadId)?.cancel();
    timers.delete(threadId);
  };

  const arm = (turn: HeldTurn): void => {
    disarm(turn.threadId);
    if (!started) return;
    const wait = Math.max(0, turn.wakeAt - now());
    timers.set(turn.threadId, after(Math.min(wait, MAX_TIMER_MS), () => {
      timers.delete(turn.threadId);
      if (turns.get(turn.threadId) !== turn) return;
      if (turn.wakeAt > now()) arm(turn);
      else void wake(turn);
    }));
  };

  const drop = (threadId: string): HeldTurn | undefined => {
    const turn = turns.get(threadId);
    if (!turn) return undefined;
    turns.delete(threadId);
    disarm(threadId);
    save();
    if (!turn.resuming) deps.waitEnded?.(threadId);
    return turn;
  };

  const probes = (engine: string) => Boolean(deps.probe && deps.canProbe?.(engine));
  const wakeFor = (resetsAt: number | null, at: number, turn?: Pick<HeldTurn, "engine" | "checks">) => (resetsAt !== null && resetsAt > at ? resetsAt + AFTER_RESET_MS
    : at + (turn && probes(turn.engine) ? Math.min(UNKNOWN_RESET_RECHECK_MS, PROBE_RECHECK_MS * 2 ** (turn.checks ?? 0)) : UNKNOWN_RESET_RECHECK_MS));

  const pausedLine = (turn: HeldTurn) => deps.paused(turn.threadId, turn.resetsAt !== null ? { resetsAt: turn.resetsAt } : {});

  /** The limit is over: the turn carries on, unless the person or the conversation moved on. */
  const wake = async (turn: HeldTurn): Promise<void> => {
    const at = now();
    if (deps.threadEngine(turn.botId, turn.threadId) !== turn.engine) { drop(turn.threadId); return; }
    if (at - turn.since > MAX_HOLD_MS || turn.resumes >= MAX_RESUMES) {
      drop(turn.threadId);
      say(turn.threadId, "server.limitHold.gaveUp", { engine: turn.engineName });
      return;
    }
    const probing = turn.resetsAt === null && probes(turn.engine);
    if (turn.resetsAt === null && !probing) {
      await deps.refreshUsage().catch(() => undefined);
      if (turns.get(turn.threadId) !== turn) return;
    }
    let blocked = deps.blockedUntil(turn.engine);
    if (probing && blocked !== null && blocked > now()) {
      turn.checking = true;
      const works = await deps.probe!(turn).catch(() => null);
      turn.checking = false;
      turn.checkedAt = now();
      if (turns.get(turn.threadId) !== turn) return;
      if (works) {
        deps.release?.(turn.engine);
        blocked = deps.blockedUntil(turn.engine);
      } else turn.checks = (turn.checks ?? 0) + 1;
    }
    if (blocked !== null && blocked > now()) {
      const known = deps.resetAt(turn.engine);
      const resetsAt = known !== null && known > now() ? known : null;
      const learned = turn.resetsAt === null && resetsAt !== null;
      Object.assign(turn, { resetsAt: resetsAt ?? turn.resetsAt, wakeAt: wakeFor(resetsAt, now(), turn) });
      if (turn.resetsAt !== null && turn.resetsAt <= now()) turn.resetsAt = null;
      save();
      arm(turn);
      if (learned) pausedLine(turn);
      return;
    }
    if (deps.busy(turn.botId, turn.threadId)) {
      turn.wakeAt = now() + BUSY_RECHECK_MS;
      save();
      arm(turn);
      return;
    }
    turn.resuming = true;
    deps.waitEnded?.(turn.threadId);
    turn.resumes += 1;
    save();
    try {
      await deps.resume(turn, resumeNote(turn, deps.checklist?.(turn.botId, turn.threadId) ?? null));
    } catch (error) {
      if (turns.get(turn.threadId) !== turn) return;
      drop(turn.threadId);
      say(turn.threadId, "server.limitHold.couldNotResume");
      console.warn(`limit hold: could not resume ${turn.threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    /** The turn in this conversation waits for its AI's limit to reset. A resumed turn refused again backs off; past
     * MAX_RESUMES it stops waiting. Null when it does not wait. */
    hold(input: HoldInput): HeldTurn | null {
      const at = now();
      const resetsAt = input.resetsAt && input.resetsAt > at ? input.resetsAt : null;
      const known = turns.get(input.threadId);
      if (known?.resuming) {
        known.resuming = false;
        if (known.resumes >= MAX_RESUMES) {
          drop(input.threadId);
          say(input.threadId, "server.limitHold.gaveUp", { engine: known.engineName });
          return null;
        }
        const backoff = at + UNKNOWN_RESET_RECHECK_MS * 2 ** (known.resumes - 1);
        Object.assign(known, { resetsAt, wakeAt: Math.max(backoff, resetsAt !== null ? resetsAt + AFTER_RESET_MS : 0) });
        save();
        arm(known);
        deps.paused(input.threadId, { retryAt: known.wakeAt, ...(resetsAt !== null ? { resetsAt } : {}) });
        return known;
      }
      if (known && known.engine === input.engine) {
        const before = known.resetsAt;
        Object.assign(known, { resetsAt: resetsAt ?? known.resetsAt, wakeAt: wakeFor(resetsAt ?? known.resetsAt, at, known), ...(input.request ? { request: input.request } : {}) });
        save();
        arm(known);
        if (before !== known.resetsAt) pausedLine(known);
        return known;
      }
      const turn: HeldTurn = {
        botId: input.botId, threadId: input.threadId, engine: input.engine, engineName: input.engineName, resetsAt, wakeAt: wakeFor(resetsAt, at, input), since: at, resumes: 0,
        ...(input.request ? { request: input.request } : {}),
      };
      disarm(input.threadId);
      turns.set(input.threadId, turn);
      save();
      arm(turn);
      pausedLine(turn);
      return turn;
    },

    /** Ends the wait: the person pressed Stop, sent another message, or chose another way on. */
    cancel(threadId: string): boolean {
      return Boolean(drop(threadId));
    },

    /** The person opened the conversation: a turn waiting on a limit only a call can see the end of checks it now. */
    checkNow(threadId: string): boolean {
      const turn = turns.get(threadId);
      if (!turn || turn.resuming || turn.checking || turn.resetsAt !== null || !probes(turn.engine)) return false;
      if (turn.checkedAt !== undefined && now() - turn.checkedAt < OPEN_RECHECK_MS) return false;
      turn.wakeAt = now();
      arm(turn);
      return true;
    },

    /** A resume of this conversation's held turn is under way. */
    resuming(threadId: string): boolean {
      return turns.get(threadId)?.resuming === true;
    },

    held(threadId: string): HeldTurn | undefined {
      const turn = turns.get(threadId);
      return turn && !turn.resuming ? { ...turn } : undefined;
    },

    list(): HeldTurn[] {
      return [...turns.values()].map((turn) => ({ ...turn }));
    },

    /** A resumed turn that works ends the wait; one that fails for any other reason than its limit does too. */
    onEvent(event: RuntimeEvent): void {
      if (event.type !== "turn.completed" && event.type !== "session.exited") return;
      const turn = turns.get(event.threadId);
      if (!turn?.resuming) return;
      if (event.type === "turn.completed" && event.ok) { drop(event.threadId); return; }
      after(CLAIM_MS, () => { if (turns.get(event.threadId) === turn && turn.resuming) drop(event.threadId); });
    },

    /** Loads what a restart left and arms every wait; a wake already due runs shortly after start. */
    start(): void {
      if (started) return;
      started = true;
      if (deps.file) {
        let saved: unknown;
        try { saved = JSON.parse(readFileSync(deps.file, "utf8")); } catch { saved = []; }
        for (const row of Array.isArray(saved) ? saved : []) {
          const turn = savedTurn(row);
          if (turn && !turns.has(turn.threadId) && now() - turn.since <= MAX_HOLD_MS) turns.set(turn.threadId, turn);
        }
      }
      for (const turn of turns.values()) {
        turn.wakeAt = Math.max(turn.wakeAt, now() + AFTER_START_MS);
        arm(turn);
      }
    },

    stop(): void {
      started = false;
      for (const threadId of timers.keys()) disarm(threadId);
    },
  };
}

export type LimitHold = ReturnType<typeof createLimitHold>;
