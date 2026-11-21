// How much of a conversation ran at once, read from the live event stream: tool calls the engine asked for together
// (one model round), tool calls in flight at the same moment, and conversations of the bot busy at the same moment
// (separate jobs it opened with start_thread or handed to teammates).
import type { Frame } from "./events.ts";

/** A tool that starts this soon after the thread's previous tool settled was asked for in the same model round:
 * a new round waits for the model's first byte, which takes longer than this on every engine we run. */
export const SAME_ROUND_MS = 600;

export interface Parallelism {
  tools: number;
  /** Model rounds that asked for at least one tool. */
  toolRounds: number;
  /** Tools asked for in a round with at least one other tool. */
  batchedTools: number;
  maxToolsInFlight: number;
  /** Most of this bot's conversations with a turn running at one moment. */
  maxThreadsBusy: number;
  threadsWithTurns: number;
}

type Span = { start: number; end: number };

function maxOverlap(spans: Span[]): number {
  const edges = spans.flatMap((span) => [{ at: span.start, step: 1 }, { at: span.end, step: -1 }])
    .sort((a, b) => a.at - b.at || a.step - b.step);
  let now = 0, most = 0;
  for (const edge of edges) most = Math.max(most, now += edge.step);
  return most;
}

export function parallelism(frames: readonly Frame[], threads: readonly string[]): Parallelism {
  const events = frames.filter((frame) => frame.kind === "runtime" && threads.includes(frame.threadId ?? ""))
    .map((frame) => ({ at: frame.at, threadId: frame.threadId!, event: frame.data?.event }))
    .filter((row) => row.event);
  const last = events.at(-1)?.at ?? 0;
  const toolSpans = new Map<string, Span & { threadId: string }>();
  const turnSpans = new Map<string, Span>();
  for (const { at, threadId, event } of events) {
    if (event.itemType === "tool" && event.itemId) {
      const key = `${threadId}:${event.itemId}`;
      if (event.type === "item.started" && !toolSpans.has(key)) toolSpans.set(key, { start: at, end: last, threadId });
      if (event.type === "item.completed" && toolSpans.has(key)) toolSpans.get(key)!.end = at;
    }
    const turn = `${threadId}:${event.turnId ?? ""}`;
    if (event.type === "turn.started" && !turnSpans.has(turn)) turnSpans.set(turn, { start: at, end: last });
    if ((event.type === "turn.completed" || event.type === "session.exited") && turnSpans.has(turn)) turnSpans.get(turn)!.end = at;
  }
  const tools = [...toolSpans.values()].sort((a, b) => a.start - b.start);
  const rounds: number[] = [];
  const settled = new Map<string, number>();
  const roundOf = new Map<string, number>();
  for (const tool of tools) {
    const previous = settled.get(tool.threadId);
    const open = roundOf.get(tool.threadId);
    if (open !== undefined && previous !== undefined && tool.start - previous <= SAME_ROUND_MS) rounds[open]!++;
    else { roundOf.set(tool.threadId, rounds.length); rounds.push(1); }
    settled.set(tool.threadId, Math.max(previous ?? 0, tool.end));
  }
  return {
    tools: tools.length,
    toolRounds: rounds.length,
    batchedTools: rounds.filter((size) => size > 1).reduce((sum, size) => sum + size, 0),
    maxToolsInFlight: maxOverlap(tools),
    maxThreadsBusy: maxOverlap([...turnSpans.values()]),
    threadsWithTurns: new Set([...turnSpans.keys()].map((key) => key.split(":")[0])).size,
  };
}
