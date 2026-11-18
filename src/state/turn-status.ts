// What each thread's running turn is doing right now, read from the live runtime frames: the engine's own report of a
// tool call (turn.progress), reasoning or reply text streaming, and the turn's end. Held per thread outside the app
// reducer, so a frame re-renders only the chat that shows that thread, and only when what it shows changes.
import { useSyncExternalStore } from "react";

import type { RuntimeEvent } from "../../shared/runtime-events";
import { forgetCommandTails, noteCommandTail } from "./command-tails";
import { progressKey, STATUS_TOOL, type TurnProgressActivity, type TurnProgressFields } from "../../shared/turn-progress";

export type LiveStatus =
  | ({ activity: TurnProgressActivity } & Omit<TurnProgressFields, "type" | "activity">)
  | { activity: "thinking" | "reply"; itemId?: undefined };

export interface TurnLive {
  turnId?: string;
  /** The newest turn this thread showed has completed, failed or stopped. */
  ended: boolean;
  status: LiveStatus | null;
  /** The bot's own words for this turn's current phase (set_status), kept until it sets another or the turn ends. */
  label?: string;
}

const UNKNOWN: TurnLive = { ended: false, status: null };
const MAX_THREADS = 500;
const threads = new Map<string, TurnLive>();
const listeners = new Map<string, Set<() => void>>();
const anyListeners = new Set<() => void>();

function sameStatus(a: LiveStatus | null, b: LiveStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return ("bytes" in a ? a.bytes : undefined) === ("bytes" in b ? b.bytes : undefined) && progressKey(a) === progressKey(b);
}

function put(threadId: string, next: TurnLive): void {
  const current = threads.get(threadId);
  if (current && current.turnId === next.turnId && current.ended === next.ended && current.label === next.label && sameStatus(current.status, next.status)) return;
  threads.delete(threadId);
  threads.set(threadId, next);
  if (threads.size > MAX_THREADS) threads.delete(threads.keys().next().value!);
  for (const listener of Array.from(listeners.get(threadId) ?? [])) listener();
  for (const listener of Array.from(anyListeners)) listener();
}

/** One live runtime frame. A row in the chat supersedes the status it came from, except the row of the very tool call
 * the status describes: "Writing index.html · 14 KB" outlasts the call's own chip until the call finishes. */
export function noteTurnEvent(event: RuntimeEvent): void {
  noteCommandTail(event);
  const { threadId } = event;
  const current = threads.get(threadId);
  const sameTurn = current && (!event.turnId || event.turnId === current.turnId);
  const turnId = event.turnId ?? current?.turnId;
  const live: TurnLive = sameTurn ? current : { turnId, ended: false, status: null };
  switch (event.type) {
    case "turn.started":
      return put(threadId, { turnId, ended: false, status: null });
    case "turn.completed":
    case "cap.exhausted":
    case "session.exited":
      return put(threadId, { turnId, ended: true, status: null });
    case "turn.progress": {
      const { activity, tool, file, bytes, itemId, target, detail, quiet, tail } = event;
      const label = event.label || live.label;
      if (tool === STATUS_TOOL) return put(threadId, { turnId, ended: false, status: live.status, ...(label ? { label } : {}) });
      return put(threadId, { turnId, ended: false, ...(label ? { label } : {}), status: {
        activity, ...(tool ? { tool } : {}), ...(file ? { file } : {}), ...(bytes !== undefined ? { bytes } : {}), ...(itemId ? { itemId } : {}),
        ...(target ? { target } : {}), ...(detail ? { detail } : {}), ...(quiet ? { quiet } : {}), ...(tail?.length ? { tail } : {}),
      } });
    }
    case "content.delta":
      return put(threadId, { turnId, ended: false, ...(live.label ? { label: live.label } : {}), status: { activity: event.streamKind === "reasoning_text" ? "thinking" : "reply" } });
    case "item.started":
      return put(threadId, { ...live, ended: false, status: live.status?.itemId && live.status.itemId === event.itemId ? live.status : null });
    case "item.completed":
    case "request.opened":
      return put(threadId, { ...live, status: null });
    default:
      if (live !== current) put(threadId, live);
  }
}

export function turnLive(threadId: string | null | undefined): TurnLive {
  return (threadId && threads.get(threadId)) || UNKNOWN;
}

function subscribe(threadId: string | null | undefined, listener: () => void): () => void {
  if (!threadId) return () => {};
  let set = listeners.get(threadId);
  if (!set) listeners.set(threadId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(threadId);
  };
}

export function useTurnLive(threadId: string | null | undefined): TurnLive {
  return useSyncExternalStore(
    (listener) => subscribe(threadId, listener),
    () => turnLive(threadId),
    () => turnLive(threadId),
  );
}

/** The live stream restarted without the frames it missed: a turn's end may be among them, so no status it showed
 * stands. The next frame of a still running turn puts one back. */
export function forgetTurnStatuses(): void {
  forgetCommandTails();
  const shown = Array.from(threads.keys());
  threads.clear();
  for (const threadId of shown) for (const listener of Array.from(listeners.get(threadId) ?? [])) listener();
  for (const listener of Array.from(anyListeners)) listener();
}

/** Any thread's status changed: for a summary across every chat (the notch island). */
export function onAnyTurnLive(listener: () => void): () => void {
  anyListeners.add(listener);
  return () => { anyListeners.delete(listener); };
}

/** Tests only. */
export function resetTurnLive(): void {
  threads.clear();
}
