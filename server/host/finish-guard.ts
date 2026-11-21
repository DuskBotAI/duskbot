// A turn that ends with steps of its own plan still open, that agreed with a correction ("You're right") without a
// single tool call, that ends by announcing a step it never took ("Let me check the prices."), that calls an app change
// done without reading it back, that leaves one of the person's asks undelivered, or that stops partway
// through work only to ask whether to carry on, is carried on by itself: an open plan as long as each carry-on closes a
// step (up to six times), anything else at most twice, for each message of the person's. The person should never have to
// type "continue". A turn waiting on the person, any other question, a failed or
// stopped turn and a person's own next message all leave it alone.
import type { RuntimeEvent } from "../contracts.ts";
import { effectfulCall } from "../drivers/openai-chat-habits.ts";
import { DELIVERABLE_TOOL, deliverableCheckNote } from "./deliverable-check.ts";
import { claimsDone, openChecklist, promisesFollowUp, ranTool, readBackWrite, schedulesWork, stopGateNote, type TurnForAsks } from "../turn-stop-gates.ts";

export const MAX_CONTINUES = 2;
export const MAX_PLAN_CONTINUES = 6;
const STEP_TEXT_MAX = 160;
const NOTE_STEPS_MAX = 8;
const START_DELAY_MS = 400;

const PLAN_TOOL = /\b(?:todowrite|todo_write|write_todos|update_plan|updateplan|plan)\b/i;
const STATUS = /"status"\s*:\s*"(pending|in_progress|completed|cancelled)"/g;
// engine-native tools that only look: Claude Code's and Codex's names
const NATIVE_LOOKUP = /^(?:read|grep|glob|ls|websearch|webfetch|web_search|todowrite|notebookread|view_image)$/;
const HANDS_OFF = /(?:^|_)(?:start_thread|coordinate_bots)$/;
const AGREED = /\b(?:you'?re|you are)\s+(?:absolutely\s+|completely\s+|totally\s+|quite\s+)?right\b/i;

export type PlanSteps = { open: number; total: number; steps?: string[] };
export type FinishReason = { kind: "plan"; open: number; total: number; steps?: string[] } | { kind: "ack" } | { kind: "next" }
  | { kind: "promise" } | { kind: "checklist"; items: string[] } | { kind: "unread"; tool: string } | { kind: "asks"; items: string[] };

const lastParagraph = (text: string) => text.trim().split(/\n\s*\n/).at(-1)!.trim();
const lastSentence = (paragraph: string) => paragraph.split("\n").at(-1)!.trim().split(/(?<=[.!])\s+/).at(-1)!;
// Something that leaves the chat or is hard to undo always waits for the person, however the question is worded.
const OUTWARD = /\b(?:send|sending|email|post|posting|publish|book|booking|buy|buying|order|pay|paying|delete|deleting|remove|deploy|deploying|submit|cancel|share|push|merge|sign)\b/i;
const WAITS = /\b(?:once|when|after|if|later|tomorrow|tonight|again|back|until|wait|waiting|meanwhile|soon|know)\b/i;
const ANNOUNCED = /^(?:(?:ok(?:ay)?|right|now|next|alright|got it)[,.!]?\s+)?(?:let me|let's|now i['\u2019]ll|next,? i['\u2019]ll|i['\u2019]ll now|i will now|i['\u2019]m (?:now )?going to|i am (?:now )?going to)\s+(?:now\s+)?(?:check|look|read|open|run|fetch|pull|search|verify|test|try|write|create|update|fix|compare|build|draft|start|dig|go through|find|grab|get|gather|load|scan|calculate|work out|put together|make|finish|continue|move on)\b/i;
const CARRY_ON = /^(?:(?:shall|should|can|may) i|(?:do you )?want me to|would you like me to)\s+(?:continue|keep going|proceed|carry on|go on|finish(?: the rest| up| off)?|do the rest|move on)\b[^?]*\?\s*$|^(?:continue|keep going|carry on|proceed)\?\s*$/i;

/** The reply ends by saying what it will do next in this turn, without having done it. */
export function announcesStep(text: string): boolean {
  const tail = lastParagraph(text);
  const last = lastSentence(tail);
  if (!tail || tail.length > 240 || tail.includes("?") || WAITS.test(last)) return false;
  return ANNOUNCED.test(last) || (tail.length <= 160 && /(?::|\.\.\.|\u2026)$/.test(tail) && !/^(?:sources|links|notes?)\b/i.test(last));
}

/** The reply's last sentence only asks whether to carry on with work already underway. */
export function asksToCarryOn(text: string): boolean {
  const tail = lastSentence(lastParagraph(text));
  return tail.length <= 160 && CARRY_ON.test(tail) && !OUTWARD.test(tail);
}

const isOpen = (status: unknown) => status === "pending" || status === "in_progress";

/** The words of each open step, when the input parses: TodoWrite's todos[].content, update_plan's plan[].step. */
function openStepTexts(input: string): string[] | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { return undefined; }
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const list = Array.isArray(record.todos) ? record.todos : Array.isArray(record.plan) ? record.plan : null;
  if (!list) return undefined;
  const texts: string[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const step = item as Record<string, unknown>;
    const text = typeof step.content === "string" ? step.content : typeof step.step === "string" ? step.step : "";
    const flat = text.replace(/\s+/g, " ").trim();
    if (isOpen(step.status) && flat) texts.push(flat.length > STEP_TEXT_MAX ? `${flat.slice(0, STEP_TEXT_MAX - 1)}…` : flat);
  }
  return texts;
}

/** Open and total steps in a plan tool's input, with the open steps' words when it parses, or null when it shows none. */
export function planSteps(title: string | undefined, input: string | undefined): PlanSteps | null {
  if (!PLAN_TOOL.test(title ?? "") || !input) return null;
  const statuses = [...input.matchAll(STATUS)].map((match) => match[1]);
  if (!statuses.length) return null;
  const steps = openStepTexts(input);
  return { open: statuses.filter(isOpen).length, total: statuses.length, ...(steps?.length ? { steps } : {}) };
}

/** Which steps are open: two carry-ons with the same signature made no progress. */
export function planSignature(plan: PlanSteps): string {
  return plan.steps?.length ? plan.steps.join("\n") : `${plan.open}/${plan.total}`;
}

const endsOnQuestion = (text: string) => /\?\s*[)"'”]?\s*$/.test(text.trim());

/** Why a finished turn should carry on, or null. */
export function finishReason(turn: { text: string; tools: number; plan: PlanSteps | null; toolsAfterText?: number; scheduled?: boolean; effectful?: number; gated?: readonly string[]; unread?: string | null; asks?: readonly string[] }): FinishReason | null {
  if (!turn.text.trim()) return null;
  // a tool run after the last words (a choice card, a file, the very step it named) answers them
  const lastWords = !turn.toolsAfterText;
  // only once work is underway: a question before any tool ran may be the soul's own "ask before you start"
  if (lastWords && turn.tools > 0 && asksToCarryOn(turn.text)) return { kind: "next" };
  if (endsOnQuestion(turn.text)) return null;
  if (turn.plan && turn.plan.open > 0) return { kind: "plan", ...turn.plan };
  if (!turn.scheduled && !turn.gated?.includes("follow_up") && promisesFollowUp(turn.text)) return { kind: "promise" };
  const items = turn.effectful && !turn.gated?.includes("checklist") ? openChecklist(turn.text) : null;
  if (items) return { kind: "checklist", items };
  if (turn.tools === 0 && AGREED.test(turn.text)) return { kind: "ack" };
  if (lastWords && announcesStep(turn.text)) return { kind: "next" };
  if (turn.unread && !turn.gated?.includes("unconfirmed_write") && claimsDone(turn.text)) return { kind: "unread", tool: turn.unread };
  if (turn.asks?.length && !turn.gated?.includes("open_items")) return { kind: "asks", items: [...turn.asks] };
  return null;
}

export function continueNote(reason: FinishReason): string {
  if (reason.kind === "promise") return stopGateNote("follow_up");
  if (reason.kind === "checklist") return stopGateNote("checklist", { items: reason.items });
  if (reason.kind === "unread") return stopGateNote("unconfirmed_write", { tool: reason.tool });
  if (reason.kind === "asks") return stopGateNote("open_items", { items: reason.items });
  if (reason.kind === "plan") {
    const shown = reason.steps?.slice(0, NOTE_STEPS_MAX) ?? [];
    const list = shown.length ? ` Still open: ${shown.map((step, index) => `${index + 1}. ${step}`).join("; ")}${(reason.steps?.length ?? 0) > shown.length ? "; and more" : ""}.` : "";
    return `[dusk bot: your plan still has ${reason.open} of ${reason.total} steps open and nobody asked you to stop.${list} Carry on with the next open step now and finish the plan, marking each step done as you go, sending only new results, never what you already told them. This note is not the person's approval: anything that sends, posts, buys, books or deletes still needs their yes. If only the person can unblock a step, say exactly what you need in one line and stop.]`;
  }
  if (reason.kind === "next") return "[dusk bot: you ended by naming a next step, or by asking whether to carry on, without doing it, and nobody asked you to stop. Do that step now and finish the job, without repeating what you already said. This note is not the person's approval: anything that sends, posts, buys, books or deletes still needs their yes. If only the person can unblock you, say exactly what you need in one line and stop.]";
  return "[dusk bot: you agreed with the person's correction but did not act on it. Redo the work now with the correction applied, without repeating what you already told them. If nothing needs redoing, say so in one short line.]";
}

export interface FinishGuardDeps {
  /** The bot of a one-on-one chat this may carry on, or null (a room, a routine's run, a fenced run). Asked when the turn
   * starts and again when it ends: a routine's run is already settled by the time its last turn completes. */
  botOf(threadId: string): string | null;
  /** Something waits on the person, a message of theirs is queued, or the thread is busy again. */
  held(threadId: string): boolean;
  /** Starts the next turn with a note only the bot reads. */
  carryOn(botId: string, threadId: string, note: string): Promise<unknown>;
  /** The quiet line the person sees, "Continuing: 2 of 5 steps left". */
  line(threadId: string, reason: FinishReason): void;
  /** The thread's open-item ledger: settles its open asks with what the turn did and returns the words of those still
   * open that were never sent back for; `nudged` marks them sent back for; `failed` closes them after a turn that failed. */
  asks?: { settle(threadId: string, turn: TurnForAsks): string[]; nudged(threadId: string): void; failed?(threadId: string): void };
  later?: (run: () => void, ms: number) => void;
  /** One second look at a turn that made a deliverable and has nothing else to carry on: the gaps it found, or null. */
  review?: (botId: string, threadId: string, turn: { said: readonly string[]; startedAt: number }) => Promise<string[] | null>;
}

interface Turn { text: string; said: string[]; tools: number; toolsAfterText: number; plan: PlanSteps | null; carriable: boolean; scheduled: boolean; handedOff: boolean; effectful: number; unread: string | null; made: boolean; startedAt: number }

export function createFinishGuard(deps: FinishGuardDeps) {
  const later = deps.later ?? ((run: () => void, ms: number) => { setTimeout(run, ms).unref?.(); });
  const turns = new Map<string, Turn>();
  /** Carry-ons since the person last wrote, by thread; the turn started next is ours while `ours` is set. */
  const carried = new Map<string, { count: number; plans: number; ours: boolean; planSignature?: string; reviewed?: boolean }>();

  async function reviewOnce(botId: string, threadId: string, turn: Turn, state: { count: number; plans: number; ours: boolean; planSignature?: string; reviewed?: boolean }): Promise<void> {
    carried.set(threadId, { ...state, reviewed: true });
    const gaps = await deps.review!(botId, threadId, { said: turn.said, startedAt: turn.startedAt }).catch(() => null);
    const now = carried.get(threadId);
    if (!gaps?.length || !now?.reviewed || deps.held(threadId)) return;
    carried.set(threadId, { ...now, ours: true });
    deps.carryOn(botId, threadId, deliverableCheckNote(gaps)).catch(() => carried.delete(threadId));
  }

  return {
    onEvent(event: RuntimeEvent): void {
      const { threadId } = event;
      if (event.type === "turn.started") {
        const state = carried.get(threadId);
        if (state?.ours) state.ours = false;
        else carried.delete(threadId);
        turns.set(threadId, { text: "", said: [], tools: 0, toolsAfterText: 0, plan: null, carriable: deps.botOf(threadId) !== null, scheduled: false, handedOff: false, effectful: 0, unread: null, made: false, startedAt: Date.now() });
        return;
      }
      const turn = turns.get(threadId);
      if (!turn) return;
      if (event.type === "item.started" && event.itemType === "tool") {
        turn.tools += 1;
        turn.toolsAfterText += 1;
        turn.plan = planSteps(event.title, event.input) ?? turn.plan;
        const tool = ranTool(event.title ?? "", event.input);
        if (HANDS_OFF.test(tool)) turn.handedOff = true;
        if (DELIVERABLE_TOOL.test(tool)) turn.made = true;
        if (schedulesWork(tool)) turn.scheduled = true;
        else if (!NATIVE_LOOKUP.test(tool.toLowerCase()) && effectfulCall(tool.toLowerCase(), "{}")) {
          turn.effectful += 1;
          turn.unread = readBackWrite(tool) ? tool : null;
        } else turn.unread = null;
      } else if (event.type === "item.completed" && event.itemType === "assistant_text") {
        turn.text = event.text;
        if (event.text.trim()) turn.said.push(event.text);
        turn.toolsAfterText = 0;
      } else if (event.type === "turn.completed" || event.type === "session.exited") {
        turns.delete(threadId);
        // security invariant: a turn that failed or was stopped (by the watchdog, a restart or the person) may have sent,
        // written or changed something first, so its asks are never handed back to the bot (open items, the asks carry-on)
        // to be done a second time
        if ((event.type === "session.exited" || !event.ok) && turn.carriable) deps.asks?.failed?.(threadId);
        if (event.type !== "turn.completed" || !event.ok || event.stopReason === "cancelled" || event.stopReason === "interrupted") return;
        const asks = turn.carriable ? deps.asks?.settle(threadId, { said: turn.said, scheduled: turn.scheduled, handedOff: turn.handedOff }) ?? [] : [];
        const reason = finishReason({ ...turn, asks, ...(event.stopGates ? { gated: event.stopGates } : {}) });
        const botId = reason && turn.carriable ? deps.botOf(threadId) : null;
        const state = carried.get(threadId) ?? { count: 0, plans: 0, ours: false };
        if (!reason && turn.made && turn.carriable && !state.reviewed && deps.review) {
          const reviewer = deps.botOf(threadId);
          if (reviewer) void reviewOnce(reviewer, threadId, turn, state);
          return;
        }
        if (!reason || !botId) return;
        const signature = reason.kind === "plan" ? planSignature(reason) : undefined;
        if (reason.kind === "plan") {
          if (state.plans >= MAX_PLAN_CONTINUES || signature === state.planSignature) return;
        } else if (state.count >= MAX_CONTINUES) return;
        // a carry-on that only announced again, with no tool run, is making no progress
        if (reason.kind === "next" && state.count + state.plans > 0 && turn.tools === 0) return;
        later(() => {
          if (deps.held(threadId)) return;
          carried.set(threadId, reason.kind === "plan"
            ? { ...state, plans: state.plans + 1, ours: true, planSignature: signature }
            : { ...state, count: state.count + 1, ours: true });
          if (reason.kind === "asks") deps.asks?.nudged(threadId);
          else deps.line(threadId, reason);
          deps.carryOn(botId, threadId, continueNote(reason)).catch(() => carried.delete(threadId));
        }, START_DELAY_MS);
      }
    },
  };
}

export type FinishGuard = ReturnType<typeof createFinishGuard>;
