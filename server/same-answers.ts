// The same call with the same arguments getting the same answer three times in one turn (OpenClaw's tool-repeat-guard,
// Hermes Agent's tool_guardrails): the turn gets one note to change approach, never a stop. Only lookups through MCP,
// connected apps and dusk bot's own search tools count: an engine's reads and edits, a browser's scrolls and clicks, and
// waiting and status tools repeat for good reasons, and shell commands are the loop guard's own.
import { createHash } from "node:crypto";

export const SAME_ANSWER_AT = 3;
const POLLING = /(?:^|[_\s:./-])(?:wait|waits|wait_until|status|poll|set_status|send_message|checklist|react|tool_result_read|assignment_status|list_threads|sleep|screenshot|snapshot)(?:$|[_\s:./-])/i;
const LOOKUP = /^mcp__|__|^use_tool$|^[A-Z][A-Z0-9]*_[A-Z0-9_]+$|^(?:web_search_many|x_search|research_call|research_search|session_search|read_pages|extract)$/;
const HANDS_ON = /browser|computer|scroll|click|type|key|navigate|mouse|drag|screen/i;
const MAX_KEYS = 256;

const digest = (text: string) => createHash("sha256").update(text).digest("base64");

/** One turn's calls by tool and arguments; only digests are kept, never what a call carried. */
export class SameAnswers {
  private readonly turns = new Map<string, { pending: Map<string, string>; seen: Map<string, { answer: string; count: number }>; noted: Set<string> }>();

  private turn(threadId: string) {
    let turn = this.turns.get(threadId);
    if (!turn) this.turns.set(threadId, (turn = { pending: new Map(), seen: new Map(), noted: new Set() }));
    return turn;
  }

  started(threadId: string, itemId: string | undefined, tool: string | undefined, input: string | undefined): void {
    const name = (tool ?? "").trim();
    if (!itemId || !name || !input?.trim() || !LOOKUP.test(name) || HANDS_ON.test(name) || POLLING.test(name)) return;
    const turn = this.turn(threadId);
    if (turn.pending.size >= MAX_KEYS) turn.pending.delete(turn.pending.keys().next().value!);
    turn.pending.set(itemId, digest(JSON.stringify([name, input.replace(/\s+/g, " ").trim()])));
  }

  /** True once, the third time this call got this answer in a row. */
  completed(threadId: string, itemId: string | undefined, output: string | undefined): boolean {
    const turn = this.turns.get(threadId);
    const key = itemId === undefined ? undefined : turn?.pending.get(itemId);
    if (!turn || !key || output === undefined) return false;
    turn.pending.delete(itemId!);
    const answer = digest(output);
    const last = turn.seen.get(key);
    const count = last?.answer === answer ? last.count + 1 : 1;
    if (!last && turn.seen.size >= MAX_KEYS) turn.seen.delete(turn.seen.keys().next().value!);
    turn.seen.set(key, { answer, count });
    if (count < SAME_ANSWER_AT || turn.noted.has(key)) return false;
    turn.noted.add(key);
    return true;
  }

  settle(threadId: string): void {
    this.turns.delete(threadId);
  }
}

/** Opened as `[dusk bot …]`, which model-written text cannot open. */
export function sameAnswerNote(tool: string): string {
  return `[dusk bot: ${tool.replace(/[[\]\n]/g, " ").slice(0, 80)} got the same answer to the same call ${SAME_ANSWER_AT} times. Calling it again will not change that: change the query, use another source, or answer with what you have.]`;
}
