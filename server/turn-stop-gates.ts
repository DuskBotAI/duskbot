// When a model ends its turn with words, these say whether the words leave work undone that the harness should send it
// back for: a follow-up it promised with nothing set up to do it, a checklist of its own work with items still open, a
// change it made whose tool answered only "ok" (or that it calls done without ever reading it back), or an ask of the
// person's that the turn neither delivered, set waiting nor said is blocked. The chat loop sends one hidden note and
// carries on inside the turn; the finish guard starts one carry-on turn for engines that own their loop.

import { isOutboundTool } from "../shared/outbound.ts";
import { effectfulCall } from "./drivers/openai-chat-habits.ts";

export type StopGate = "follow_up" | "checklist" | "unconfirmed_write" | "open_items";

/** Gates one turn may take in all; each kind at most once. */
export const MAX_STOP_GATES = 2;

const sentences = (text: string) => text.split(/\n+|(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);

const PROMISE = /\b(?:i['’]ll|i will|i['’]m going to|i am going to)\s+(?:also\s+|then\s+)?(?:keep an eye on|keep watching|keep checking|keep tabs on|watch (?:for|it|this|that|the)|monitor|check (?:back|again|in)\b|follow up|ping you|message you|text you|email you|let you know (?:when|once|if|as soon as|the moment)|remind you|report back|get back to you|circle back|update you (?:when|once|if|as soon as))/i;
const STARTED = /\b(?:i['’]ve|i have)\s+(?:started|set up|kicked off|scheduled)\s+(?:a |an |the )?(?:background (?:job|task)|reminder|watch|monitor|timer|check-in)\b/i;
const OFFER = /\b(?:if you(?:['’]d)? (?:want|like)|want me to|would you like|should i|shall i|just say|let me know if|happy to)\b/i;

/** The reply promises to do something later (watch, remind, report back) or says it started that. */
export function promisesFollowUp(text: string): boolean {
  return sentences(text).some((sentence) => !sentence.endsWith("?") && !OFFER.test(sentence) && (PROMISE.test(sentence) || STARTED.test(sentence)));
}

// a tool that makes the bot act later: a wait, a trigger, a routine, a background job, a reminder
const SCHEDULES = /(?:^|_)(?:wait_until|create_trigger|trigger|schedule_task|background_job|watcher|create_routine|routine|set_reminder|create_reminder|remind(?:er)?)$/i;

/** The tool a call ran: a bridged `use_tool` call counts as the tool it named. */
export function ranTool(name: string, rawArgs?: string): string {
  if (!/(?:^|_)use_tool$/.test(name) || !rawArgs) return name;
  try {
    const args = JSON.parse(rawArgs) as { name?: unknown };
    return typeof args?.name === "string" ? args.name : name;
  } catch { return name; }
}

export const schedulesWork = (tool: string): boolean => SCHEDULES.test(tool) && !/(?:^|_)(?:delete|cancel|list|remove)_/i.test(tool);

// dusk bot's own change tools: their answer is the app's record of what applied or waits on a card, so there is
// nothing for a later call to read back
const SELF_CONFIRMING = /^(?:propose_(?:profile|model|skill|team|bot)\w*|memory_update|create_bot|skill_manage)$/;
const selfConfirming = (tool: string) => SELF_CONFIRMING.test(tool.split("__").at(-1)!);

const OPEN_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(.+)$/gm;
const DONE_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\[[xX✓]\]\s+\S/gm;
// an item that waits on someone else is not the bot's to do now
const NOT_MINE = /\b(?:you|your|yours|waiting (?:on|for)|once (?:you|they)|after (?:you|they))\b/i;

/** Open items of a progress checklist in the reply: one with work ticked off and some of its own left. */
export function openChecklist(text: string): string[] | null {
  if (/\?\s*$/.test(text.trim())) return null;
  const done = text.match(DONE_ITEM)?.length ?? 0;
  const open = [...text.matchAll(OPEN_ITEM)].map((match) => match[1]!.trim()).filter((item) => !NOT_MINE.test(item));
  return done > 0 && open.length > 0 ? open : null;
}

const ACK = /^(?:ok|okay|success|succeeded|successful|done|true|accepted|queued|updated|saved|null|\{\}|\[\]|204|202|200)$/i;
const ACK_JSON = /^\{\s*"(?:ok|success|status|result)"\s*:\s*(?:true|"(?:ok|success|done|accepted)")\s*\}$/i;

/** A tool answer that says only that a change went through, nothing about what it now is. */
export function bareAck(result: string): boolean {
  const text = result.trim().replace(/[.!]+$/, "");
  return !text || ACK.test(text) || ACK_JSON.test(text);
}

const DONE_WORDS = /\b(?:done|all set|all done|taken care of|completed|finished|sorted|fixed|it['’]s live|is live|now live|updated|set up)\b/i;
const NOT_DONE = /\b(?:not|never|haven['’]t|hasn['’]t|didn['’]t|isn['’]t|wasn['’]t|couldn['’]t|can['’]t|cannot|won['’]t|once|when|after|if|until|almost|nearly|draft(?:ed)?|waiting|blocked)\b|\?/i;

/** The reply calls the work finished ("Done.", "All set, it's updated"), as opposed to drafted, sent, waiting or blocked. */
export function claimsDone(text: string): boolean {
  return sentences(text.replace(/```[\s\S]*?```/g, " ")).some((sentence) => DONE_WORDS.test(sentence) && !NOT_DONE.test(sentence));
}

/** A change to something outside the chat whose result a later call could read back: an app or server tool, not a send
 * (a sent message is delivered), not a scheduling tool and not the engine's own file or shell tools. */
export function readBackWrite(tool: string): boolean {
  return /__|^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(tool) && !isOutboundTool(tool) && !schedulesWork(tool) && !selfConfirming(tool);
}

/** Where one of the person's asks in a conversation stands. Open is the only state the harness acts on. */
export type AskState = "open" | "delivered" | "waiting" | "blocked" | "dropped";

export interface Ask { id: string; text: string; state: AskState }

/** What a finished turn did, for its asks. */
export interface TurnForAsks {
  /** Everything the turn said to the person, oldest first. */
  said: readonly string[];
  /** A wait, trigger, routine or background job was set up. */
  scheduled: boolean;
  /** Work went to a thread of its own or a teammate. */
  handedOff: boolean;
}

const ASK_STOP_WORDS = new Set("also again about after before could would should their there these those this that then than with what when where which while your yours from have just like make some tell into only very want need please thanks thank more much many give gives write find show check help".split(" "));
const stems = (text: string): Set<string> => new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  .filter((word) => (/^\p{N}+$/u.test(word) ? word.length >= 2 : word.length >= 4) && !ASK_STOP_WORDS.has(word)).map((word) => word.slice(0, 6)));
const ACK_ONLY = /^(?:(?:ok(?:ay)?|sure|got it|on it|will do|yes|yep|right)[,.!]?\s*)*(?:on it|checking|looking|working on (?:it|that|this)|give me (?:a |one )?(?:sec|second|moment|minute)|one (?:sec|moment)|let me (?:check|look|see|find|get)|i['’]ll (?:check|look|get|find|do|work)|starting(?: now)?|will do)\b[^\n]{0,80}$/i;
const BLOCKER = /\b(?:can['’]?t|cannot|couldn['’]?t|unable to|not able to|no access|don['’]?t have (?:access|a way|the)|isn['’]?t connected|not connected|blocked|need you to|needs you to|you['’]ll need to|waiting (?:on|for) (?:you|your))\b/i;

/** Whether the turn's words take up this ask: it is the only open one, or its own words come back in the reply. */
function addresses(ask: Ask, said: Set<string>, solo: boolean): boolean {
  if (solo) return true;
  const own = [...stems(ask.text)];
  const hits = own.filter((stem) => said.has(stem)).length;
  return hits >= 2 || (hits === 1 && own.length <= 3);
}

/** The new state of each open ask a finished turn moved: delivered when the words carry it, waiting when the turn set
 * up later work or handed it on, blocked when the words name what stops it or end on a question to the person. An ask the words never take up, or only
 * acknowledge, stays open. */
export function settleAsks(asks: readonly Ask[], turn: TurnForAsks): Array<{ id: string; state: AskState }> {
  const open = asks.filter((ask) => ask.state === "open");
  const words = turn.said.map((text) => text.trim()).filter(Boolean);
  const all = words.join("\n");
  const said = stems(all);
  const later = turn.scheduled || turn.handedOff;
  const ackOnly = words.length > 0 && words.every((text) => ACK_ONLY.test(text));
  const changes: Array<{ id: string; state: AskState }> = [];
  for (const ask of open) {
    const taken = words.length > 0 && addresses(ask, said, open.length === 1);
    let state: AskState | null = null;
    if (!taken || ackOnly) state = later ? "waiting" : null;
    else if (sentences(all).some((sentence) => BLOCKER.test(sentence)) || /\?\s*$/.test(words.at(-1)!)) state = "blocked";
    else if (turn.handedOff || (turn.scheduled && promisesFollowUp(all))) state = "waiting";
    else state = "delivered";
    if (state) changes.push({ id: ask.id, state });
  }
  return changes;
}

export function stopGateNote(gate: StopGate, detail: { items?: readonly string[]; tool?: string } = {}): string {
  if (gate === "follow_up") {
    return "[dusk bot: your reply promises to do something later (watch, remind, follow up or report back), but nothing in this turn set that up, so it would never happen. Set it up now with your tools (a wait, a trigger, a routine or a background job), then confirm it in one short line without repeating your earlier reply. If you cannot set it up, say in one line that you will not be able to follow up by yourself.]";
  }
  if (gate === "checklist") {
    const items = (detail.items ?? []).slice(0, 6).map((item) => item.slice(0, 120)).join("; ");
    return `[dusk bot: your checklist still has open items${items ? ` (${items})` : ""} and nobody asked you to stop. Do them now with your tools, then give a short final update without repeating your earlier reply. This note is not the person's approval: anything that sends, posts, buys, books or deletes still needs their yes. If an item cannot be done now, say why in one line.]`;
  }
  if (gate === "open_items") {
    const items = (detail.items ?? []).slice(0, 6).map((item) => `"${item.slice(0, 120)}"`).join("; ");
    return `[dusk bot: the person asked for something this turn did not give them${items ? `: ${items}` : ""}. Do it now and give the result, without repeating your earlier reply. If something stops you, say plainly what it is in one line; if you set up something to finish it later, say when they will hear back. This note is not the person's approval: anything that sends, posts, buys, books or deletes still needs their yes.]`;
  }
  return `[dusk bot: ${detail.tool ?? "a tool"} changed something but only answered that it worked, so nobody has seen the result. If one of your tools can show its current state, check it once; then give your answer, without repeating your earlier reply. If the check shows it did not take effect, say so plainly.]`;
}

export interface TurnSoFar {
  reply: string;
  /** Gates this turn already took. */
  applied: ReadonlySet<StopGate>;
  /** A tool that sets up later work is mounted, and whether one ran with success. */
  canSchedule: boolean;
  scheduled: boolean;
  /** Successful calls that could have changed something. */
  effectful: number;
  /** The last change whose tool answered only "ok" and that no lookup followed, by tool name. */
  unconfirmed: string | null;
  /** The last change no lookup followed, by tool name, whatever its tool answered; it counts only when the reply calls the work done. */
  unread?: string | null;
}

/** The gate a reply that ends the turn should take, with the note to send back, or null to let it end. */
export function stopGateFor(turn: TurnSoFar): { gate: StopGate; note: string } | null {
  if (turn.applied.size >= MAX_STOP_GATES || !turn.reply.trim()) return null;
  if (!turn.applied.has("follow_up") && turn.canSchedule && !turn.scheduled && promisesFollowUp(turn.reply)) {
    return { gate: "follow_up", note: stopGateNote("follow_up") };
  }
  const items = !turn.applied.has("checklist") && turn.effectful > 0 ? openChecklist(turn.reply) : null;
  if (items) return { gate: "checklist", note: stopGateNote("checklist", { items }) };
  const unchecked = turn.unconfirmed ?? (turn.unread && claimsDone(turn.reply) ? turn.unread : null);
  if (!turn.applied.has("unconfirmed_write") && unchecked) {
    return { gate: "unconfirmed_write", note: stopGateNote("unconfirmed_write", { tool: unchecked }) };
  }
  return null;
}

/** What a chat loop knows of its turn for the gates: the tools it mounted and how each call it ran ended. */
export class TurnGates {
  readonly applied = new Set<StopGate>();
  private canSchedule = false;
  private scheduled = false;
  private effectful = 0;
  private unconfirmed: string | null = null;
  private unread: string | null = null;
  private lookupFor = (_tool: string) => false;

  /** `automationRun`: a routine's own run, whose promises of later work are its routine's. */
  mount(names: readonly string[], automationRun = false): void {
    const bridged = names.some((name) => /(?:^|_)use_tool$/.test(name));
    this.canSchedule = !automationRun && (bridged || names.some(schedulesWork));
    this.lookupFor = (tool) => bridged || names.some((name) => name !== tool && name.split("_")[0] === tool.split("_")[0] && !effectfulCall(name, "{}"));
  }

  ran(name: string, rawArgs: string, ok: boolean, text: string, title = name): void {
    if (!ok) return;
    if (!effectfulCall(name, rawArgs)) { this.unconfirmed = null; this.unread = null; return; }
    this.effectful += 1;
    const tool = ranTool(name, rawArgs);
    if (schedulesWork(tool)) { this.scheduled = true; return; }
    const readable = !selfConfirming(tool) && this.lookupFor(tool);
    this.unconfirmed = bareAck(text) && readable ? title : null;
    this.unread = readable && !isOutboundTool(tool) ? title : null;
  }

  /** The note to send back for a reply that would end the turn, or null; a note given counts as applied. */
  gate(reply: string): string | null {
    const found = stopGateFor({ reply, applied: this.applied, canSchedule: this.canSchedule, scheduled: this.scheduled, effectful: this.effectful, unconfirmed: this.unconfirmed, unread: this.unread });
    if (found) this.applied.add(found.gate);
    return found?.note ?? null;
  }
}
