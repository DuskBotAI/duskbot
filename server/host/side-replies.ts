// Reply while working: the person's own message, sent in their one-to-one chat while the bot works, gets a quick reply
// from a small fast model (side-reply-prompt.ts) instead of waiting for the turn. Its decision routes the message: a
// question is answered and the turn runs on untouched; a steer is acknowledged and passed into the running turn, or
// first in the queue with the running turn paused when its engine cannot take input mid-turn (queued for the continuation
// when the turn is already ending); a separate new ask (task) goes into the running turn to be done beside it, or the
// same way; a stop or redirect ends the turn through the person's own Stop. When no quick reply comes, the message takes the old path (fallback): steered or queued as it was.
import type { RuntimeEvent, SteerOutcome } from "../contracts.ts";
import type { Checklist } from "../batch-checklist.ts";
import { derivedLabel } from "../harness/derived-status.ts";
import { burstNote, continuationNote, parseSideDecision, queuedTaskNote, redirectNote, sideReplyPrompt, steerNote, taskNote, type SideDecision, type SideLine } from "../side-reply-prompt.ts";

export const SIDE_REPLY_TIMEOUT_MS = 12_000;
/** How long a turn that has said and done nothing yet counts as just started: a message then is part of the same burst. */
export const BURST_MS = 30_000;
const STEP_CHARS = 90;
const KEPT_STEPS = 12;
const KEPT_SAID = 4;
const RECENT_ROWS = 8;

export type SideWriter = (prompt: string, options: { signal: AbortSignal; timeoutMs: number }) => Promise<string>;

export interface SideRow {
  id: string;
  role: string;
  kind: string;
  text?: string;
  steered?: boolean;
}

export interface SideRequest {
  botId: string;
  threadId: string;
  /** The person's row, already in the transcript. */
  messageId: string;
  text: string;
  /** The person's words as the engine reads them. */
  prompt: string;
}

export interface SideSendFacts {
  /** The person typed it themselves: not an app, a teammate, a routine or a relayed external line. */
  personsOwn: boolean;
  /** Said on a Live call. */
  spoken: boolean;
  images: boolean;
  /** What the person chose for a follow-up, when they chose. */
  followUp?: string;
  /** A room thread: several people and bots share it, its messages queue for the room's next turn and routing picks
   * who answers, so a working bot never answers there on the side. */
  room: boolean;
  /** Their own chat with the bot: no routine run, internal turn or confined proactive thread. */
  oneOnOne: boolean;
  /** The turn waits on the person (a question, a sign-in) or on their choice of computer: the message is that answer. */
  waitingOnPerson: boolean;
  /** features.quickUpdates: the app may write short messages in the bot's name. */
  quickUpdates: boolean;
  writer: boolean;
}

/** Whether a message sent while the bot works gets a quick reply instead of the old steer-or-queue path. */
export function repliesWhileWorking(facts: SideSendFacts): boolean {
  return facts.personsOwn && !facts.spoken && !facts.images && (facts.followUp === undefined || facts.followUp === "steer") &&
    !facts.room && facts.oneOnOne && !facts.waitingOnPerson && facts.quickUpdates && facts.writer;
}

export type SideOutcome = "answered" | "steered" | "queued" | "paused" | "folded" | "added" | "added-next" | "stopped" | "redirected" | "fallback";

export interface SideRepliesDeps<R extends SideRequest> {
  writer(botId: string, threadId: string): SideWriter | null;
  bot(botId: string): { name: string; soul?: string } | null | undefined;
  transcript(threadId: string): readonly SideRow[];
  checklist(botId: string, threadId: string): Checklist | null;
  /** The thread's turn still runs. */
  busy(botId: string, threadId: string): boolean;
  /** The running turn's engine takes input mid-turn. */
  canSteer(threadId: string): boolean;
  steer(request: R, prompt: string): Promise<SteerOutcome>;
  /** Queued ahead of the thread's queue, as the person's row, so the continuation runs it first. */
  queueNext(request: R, prompt: string): void;
  /** Queues `prompt` first and stops the running turn of an engine that cannot take input mid-turn, so it carries on with
   * the message at once instead of after the whole task. */
  pause?(request: R, prompt: string): Promise<void>;
  stop(request: R): Promise<void>;
  /** Queues `prompt` first and stops the running turn, so it runs next. */
  redirect(request: R, prompt: string): Promise<void>;
  /** The quick reply, a bot message of its own outside any turn. */
  post(threadId: string, text: string): void;
  /** The message is a separate new ask of its own, for the chat's open-item ledger. */
  asked?(request: R): void;
  /** The message's path without a quick reply. */
  fallback(request: R): Promise<void>;
  timeoutMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

interface Progress {
  turnId?: string;
  startedAt: number;
  status?: string;
  steps: string[];
  said: string[];
  added: string[];
}

const textOf = (row: SideRow) => (row.kind === "text" && typeof row.text === "string" ? row.text.trim() : "");

/** The request the running turn works on: the person's last message that started a turn of its own. */
export function runningAsk(rows: readonly SideRow[], newMessageId: string): string {
  return textOf(rows.findLast((row) => row.id !== newMessageId && row.role === "user" && !row.steered && textOf(row)) ?? { id: "", role: "", kind: "" });
}

export function recentLines(rows: readonly SideRow[], newMessageId: string): SideLine[] {
  const lines: SideLine[] = [];
  for (let i = rows.length - 1; i >= 0 && lines.length < RECENT_ROWS; i -= 1) {
    const row = rows[i]!;
    if (row.id === newMessageId || (row.role !== "user" && row.role !== "bot")) continue;
    const text = textOf(row);
    if (text) lines.unshift({ who: row.role === "user" ? "person" : "bot", text });
  }
  return lines;
}

function checklistState(list: Checklist | null): { title?: string; done: number; total: number; next?: string } | undefined {
  if (!list?.items.length) return undefined;
  const done = list.items.filter((item) => item.state !== "open").length;
  const next = list.items.find((item) => item.state === "open")?.text;
  return { ...(list.title ? { title: list.title } : {}), done, total: list.items.length, ...(next ? { next } : {}) };
}

export function createSideReplies<R extends SideRequest>(deps: SideRepliesDeps<R>) {
  const now = deps.now ?? Date.now;
  const progress = new Map<string, Progress>();
  /** Separate asks queued for a thread's next turn, so a later message's responder knows they are coming. */
  const waiting = new Map<string, string[]>();
  const chains = new Map<string, Promise<unknown>>();

  const decide = async (request: R): Promise<SideDecision | null> => {
    const writer = deps.writer(request.botId, request.threadId);
    const bot = deps.bot(request.botId);
    if (!writer || !bot) return null;
    const rows = deps.transcript(request.threadId);
    const live = progress.get(request.threadId);
    const prompt = sideReplyPrompt({
      name: bot.name,
      soul: bot.soul,
      task: {
        ask: runningAsk(rows, request.messageId),
        minutes: live ? (now() - live.startedAt) / 60_000 : 1,
        ...(live?.status ? { status: live.status } : {}),
        steps: live?.steps ?? [],
        checklist: checklistState(deps.checklist(request.botId, request.threadId)),
        said: live?.said ?? [],
        added: [...(live?.added ?? []), ...(waiting.get(request.threadId) ?? [])],
      },
      recent: recentLines(rows, request.messageId),
      message: request.text,
      notesNow: deps.canSteer(request.threadId) || Boolean(deps.pause),
      tasksNow: deps.busy(request.botId, request.threadId) && (deps.canSteer(request.threadId) || Boolean(deps.pause)),
    });
    const timeoutMs = deps.timeoutMs ?? SIDE_REPLY_TIMEOUT_MS;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    timer.unref?.();
    const startedAt = now();
    try {
      const raw = await Promise.race([
        writer(prompt, { signal: abort.signal, timeoutMs }),
        new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true })),
      ]);
      const decision = parseSideDecision(raw);
      deps.log?.(decision
        ? `side reply: ${decision.kind} in ${request.threadId} after ${now() - startedAt} ms`
        : `side reply: unreadable answer in ${request.threadId}, the message takes its usual path`);
      return decision;
    } catch (error) {
      deps.log?.(`side reply: none in ${request.threadId} (${error instanceof Error ? error.message.slice(0, 160) : "unknown"}), the message takes its usual path`);
      return null;
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  };

  const steerOrQueue = async (request: R, reply: string): Promise<SideOutcome> => {
    if (deps.busy(request.botId, request.threadId) && deps.canSteer(request.threadId)) {
      const outcome = await deps.steer(request, `${request.prompt}\n\n${steerNote(reply)}`).catch((): SteerOutcome => "indeterminate");
      if (outcome !== "refused") return "steered";
    } else if (deps.pause && deps.busy(request.botId, request.threadId)) {
      await deps.pause(request, `${request.prompt}\n\n${continuationNote(reply)}`);
      return "paused";
    }
    deps.queueNext(request, `${request.prompt}\n\n${continuationNote(reply)}`);
    return "queued";
  };

  const addTask = async (request: R, reply: string): Promise<SideOutcome> => {
    if (deps.busy(request.botId, request.threadId) && deps.canSteer(request.threadId)) {
      const outcome = await deps.steer(request, `${request.prompt}\n\n${taskNote(reply)}`).catch((): SteerOutcome => "indeterminate");
      if (outcome !== "refused") {
        const live = progress.get(request.threadId);
        if (live) live.added = [...live.added, request.text];
        return "added";
      }
    } else if (deps.pause && deps.busy(request.botId, request.threadId)) {
      await deps.pause(request, `${request.prompt}\n\n${queuedTaskNote(reply)}`);
      waiting.set(request.threadId, [...(waiting.get(request.threadId) ?? []), request.text]);
      return "paused";
    }
    deps.queueNext(request, `${request.prompt}\n\n${queuedTaskNote(reply)}`);
    waiting.set(request.threadId, [...(waiting.get(request.threadId) ?? []), request.text]);
    return "added-next";
  };

  /** A turn that started moments ago and has neither said nor done anything: the new message is the rest of its ask. */
  const justStarted = (request: R): boolean => {
    const live = progress.get(request.threadId);
    return deps.busy(request.botId, request.threadId) && (!live || (!live.said.length && !live.steps.length && now() - live.startedAt < BURST_MS));
  };

  const fold = async (request: R): Promise<SideOutcome> => {
    const prompt = `${request.prompt}\n\n${burstNote(runningAsk(deps.transcript(request.threadId), request.messageId))}`;
    if (deps.canSteer(request.threadId)) {
      const outcome = await deps.steer(request, prompt).catch((): SteerOutcome => "indeterminate");
      if (outcome !== "refused") return "folded";
    } else if (deps.pause) {
      await deps.pause(request, prompt);
      return "folded";
    }
    deps.queueNext(request, prompt);
    return "queued";
  };

  const act = async (request: R): Promise<SideOutcome> => {
    if (justStarted(request)) return fold(request);
    const decision = await decide(request);
    if (!decision) {
      await deps.fallback(request);
      return "fallback";
    }
    const { botId, threadId } = request;
    switch (decision.kind) {
      case "answer":
        deps.post(threadId, decision.reply);
        return "answered";
      case "steer": {
        const outcome = await steerOrQueue(request, decision.reply);
        deps.post(threadId, decision.reply);
        return outcome;
      }
      case "task": {
        deps.asked?.(request);
        const outcome = await addTask(request, decision.reply);
        deps.post(threadId, decision.reply);
        return outcome;
      }
      case "stop":
        deps.post(threadId, decision.reply);
        if (deps.busy(botId, threadId)) await deps.stop(request);
        return "stopped";
      case "redirect":
        deps.post(threadId, decision.reply);
        if (deps.busy(botId, threadId)) await deps.redirect(request, `${request.prompt}\n\n${redirectNote(decision.reply)}`);
        else deps.queueNext(request, `${request.prompt}\n\n${redirectNote(decision.reply)}`);
        return "redirected";
    }
  };

  return {
    /** Whether a quick reply can be written for this thread's bot now. */
    available(botId: string, threadId: string): boolean {
      return Boolean(deps.writer(botId, threadId) && deps.bot(botId));
    },

    /** Handles one message; a thread's messages are handled in the order they came. Never throws. */
    handle(request: R): Promise<SideOutcome> {
      const before = chains.get(request.threadId) ?? Promise.resolve();
      const run = before.then(() => act(request)).catch((error: unknown) => {
        deps.log?.(`side reply: failed in ${request.threadId} (${error instanceof Error ? error.message.slice(0, 160) : "unknown"})`);
        return "fallback" as const;
      });
      chains.set(request.threadId, run);
      void run.finally(() => { if (chains.get(request.threadId) === run) chains.delete(request.threadId); });
      return run;
    },

    onEvent(event: RuntimeEvent): void {
      const { threadId } = event;
      if (event.type === "turn.started") {
        progress.set(threadId, { turnId: event.turnId, startedAt: now(), steps: [], said: [], added: waiting.get(threadId) ?? [] });
        waiting.delete(threadId);
        return;
      }
      if (event.type === "turn.completed" || event.type === "session.exited") {
        progress.delete(threadId);
        return;
      }
      const live = progress.get(threadId);
      if (!live || (event.turnId && live.turnId && event.turnId !== live.turnId)) return;
      if (event.type === "item.started" && event.itemType === "tool") {
        const step = derivedLabel(event, "en", undefined, STEP_CHARS)?.label;
        if (step && live.steps.at(-1) !== step) live.steps = [...live.steps, step].slice(-KEPT_STEPS);
      } else if (event.type === "turn.progress" && event.label) {
        live.status = event.label;
      } else if (event.type === "item.completed" && event.itemType === "assistant_text" && event.text.trim()) {
        live.said = [...live.said, event.text.replace(/\s+/g, " ").trim().slice(0, 300)].slice(-KEPT_SAID);
      }
    },
  };
}

export type SideReplies<R extends SideRequest> = ReturnType<typeof createSideReplies<R>>;
