// A model that is stuck says so by repeating itself: the same call, the same answer, until the round limit. Counted per
// call rather than back to back, so taking turns between two stuck calls is still stuck. A different answer starts the
// count over, because that is progress. Every model gets the notes; a local model, whose rounds cost tens of seconds on a
// laptop, is also refused a call that keeps failing and stopped long before the limit.
import { createHash } from "node:crypto";

const REFUSE_AFTER_FAILURES = 3;
const REFUSALS_BEFORE_STOP = 2;
const SAME_ANSWER_NOTE_AT = 3;
const SAME_ANSWER_STOP_AT = 10;
const IN_A_ROW_NOTE_AT = 3;
const LONGEST_CYCLE = 4;
const HISTORY = 64;
/** A repeated answer this long goes back to the model as a pointer to the first one. */
export const STUB_MIN_CHARS = 512;

interface Seen {
  ok: boolean;
  answer: string;
  streak: number;
}

/** The same arguments in another key order are the same call. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(source).sort().map((key) => [key, canonical(source[key])]));
}

function callKey(name: string, args: string): string {
  try { return `${name}:${JSON.stringify(canonical(JSON.parse(args)))}`; } catch { return `${name}:${args}`; }
}

const digest = (text: string) => createHash("sha256").update(text).digest("base64");

const ordinal = (count: number) => count === 3 ? "third" : count === 4 ? "fourth" : count === 5 ? "fifth" : `${count}th`;

export class ChatRepeatGuard {
  private readonly seen = new Map<string, Seen>();
  private readonly history: string[] = [];
  private readonly firstCall = new Map<string, string>();
  private readonly sent = new Map<string, string>();
  private readonly stops: boolean;
  private refusals = 0;
  private stuck: string | null = null;
  private unique = 0;
  private calls = 0;
  private cycleNotedAt = -Infinity;

  /** `stops`: refuse a call that keeps failing the same way and end the turn of a model that cannot stop repeating. */
  constructor({ stops = true }: { stops?: boolean } = {}) {
    this.stops = stops;
  }

  /** Why this call must not run again, or null. Asked before it runs. */
  refuses(name: string, args: string): string | null {
    if (!this.stops) return null;
    const seen = this.seen.get(callKey(name, args));
    if (!seen || seen.ok || seen.streak < REFUSE_AFTER_FAILURES) return null;
    if (++this.refusals >= REFUSALS_BEFORE_STOP) {
      this.stuck = `The model kept repeating a call to ${name} that had already failed ${seen.streak} times the same way, so the turn was stopped. Try again with a clearer request, or choose a stronger model.`;
    }
    return `[dusk bot: this exact call was not run. It already failed ${seen.streak} times the same way. Use different inputs, try another approach, or say what is blocking.]`;
  }

  /** A result the model has seen before, with a note to add to it. A screenshot is never the same answer: its text says
   * little, and the picture is what changed. */
  noteAfter(name: string, args: string, result: { ok: boolean; text: string; images?: readonly unknown[] }): string | undefined {
    const key = callKey(name, args);
    if (result.images?.length) {
      this.seen.delete(key);
      this.remember(`screenshot:${this.unique++}`);
      return undefined;
    }
    const answer = digest(result.text);
    const before = this.seen.get(key);
    const streak = before && before.ok === result.ok && before.answer === answer ? before.streak + 1 : 1;
    this.seen.set(key, { ok: result.ok, answer, streak });
    this.remember(`${key}\n${result.ok}\n${answer}`);
    const inARow = this.inARow();
    if (!result.ok) {
      if (streak === REFUSE_AFTER_FAILURES && this.stops) return `[dusk bot: this exact call has now failed ${streak} times the same way, so it will not run again this turn. Change approach, or say what is blocking.]`;
      return inARow === IN_A_ROW_NOTE_AT ? `[dusk bot: this is the ${ordinal(inARow)} identical call to ${name} in a row and it failed the same way each time. Do not repeat it: change the inputs, use another tool, or say what is blocking.]` : undefined;
    }
    if (streak >= SAME_ANSWER_STOP_AT && this.stops) {
      this.stuck = `The model made the same call to ${name} ${streak} times and got the same answer each time, so the turn was stopped. Try again with a clearer request, or choose a stronger model.`;
    }
    if (inARow >= IN_A_ROW_NOTE_AT) return `[dusk bot: this is the ${ordinal(inARow)} identical call to ${name} in a row, with the same result each time. Do not repeat it: change the inputs, use another tool, or answer with what you have.]`;
    const cycle = this.cycle();
    if (cycle && this.calls - this.cycleNotedAt >= cycle * 2) {
      this.cycleNotedAt = this.calls;
      return `[dusk bot: your last ${cycle * 2} tool calls repeated the same ${cycle} calls twice, with the same inputs and the same results. If you are waiting on something that has not changed yet, that is fine; otherwise do not run that round again: change the inputs, use another tool, or answer with what you have.]`;
    }
    return streak >= SAME_ANSWER_NOTE_AT ? `[dusk bot: this call has returned this same result ${streak} times. If that was expected, carry on. Otherwise use the result, try something else, or give your answer.]` : undefined;
  }

  /** The id of an earlier call this turn whose long answer this one repeats word for word, or undefined. Each call of
   * the turn that runs should come through here once, after `noteAfter`. */
  sameAnswerAs(name: string, args: string, result: { ok: boolean; text: string; images?: readonly unknown[] }, callId: string): string | undefined {
    if (!result.ok || result.images?.length || result.text.length < STUB_MIN_CHARS) return undefined;
    const key = `${callKey(name, args)}\n${digest(result.text)}`;
    const first = this.firstCall.get(key);
    if (!first) this.firstCall.set(key, callId);
    return first;
  }

  /** The words to send back for a call's result: a pointer to the earlier call when that call's result, as `sent`
   * recorded it, is still in `messages` word for word, else `text`. */
  shown(call: { id: string; name: string; args: string }, result: { ok: boolean; text: string; images?: readonly unknown[] }, text: string, messages: ReadonlyArray<{ tool_call_id?: string; content: unknown }>): string {
    const earlier = this.sameAnswerAs(call.name, call.args, result, call.id);
    const kept = earlier !== undefined && messages.some((message) => message.tool_call_id === earlier && message.content === this.sent.get(earlier));
    return kept ? `[dusk bot: the same result, word for word, as your earlier call ${earlier} in this turn; read it there.]` : text;
  }

  /** The content a call's result went to the model as. */
  record(callId: string, content: string): string {
    this.sent.set(callId, content);
    return content;
  }

  private remember(entry: string): void {
    this.calls += 1;
    this.history.push(entry);
    if (this.history.length > HISTORY) this.history.shift();
  }

  private inARow(): number {
    const last = this.history.at(-1);
    let count = 0;
    for (let at = this.history.length - 1; at >= 0 && this.history[at] === last; at--) count += 1;
    return count;
  }

  /** The period, 2 to LONGEST_CYCLE, of the cycle the last calls just went round twice; one call repeating is not one. */
  private cycle(): number | null {
    const history = this.history;
    for (let period = 2; period <= LONGEST_CYCLE; period++) {
      if (history.length < period * 2) break;
      const lap = history.slice(-period);
      if (new Set(lap).size === 1) continue;
      if (lap.every((entry, at) => history[history.length - period * 2 + at] === entry)) return period;
    }
    return null;
  }

  /** Set once the turn should end: the words to end it with. */
  get stopped(): string | null {
    return this.stuck;
  }
}
