import { useSyncExternalStore } from "react";

import type { RuntimeEvent } from "../../shared/runtime-events";

const NONE: readonly string[] = [];
const MAX_THREADS = 200;
const threads = new Map<string, Map<string, readonly string[]>>();
const listeners = new Set<() => void>();

const changed = () => { for (const listener of Array.from(listeners)) listener(); };

export function noteCommandTail(event: RuntimeEvent): void {
  if (event.type === "turn.started" || event.type === "turn.completed" || event.type === "cap.exhausted" || event.type === "session.exited") {
    if (threads.delete(event.threadId)) changed();
    return;
  }
  if (event.type !== "turn.progress" || event.activity !== "command" || !event.itemId || !event.tail?.length) return;
  let calls = threads.get(event.threadId);
  if (!calls) {
    threads.set(event.threadId, (calls = new Map()));
    if (threads.size > MAX_THREADS) threads.delete(threads.keys().next().value!);
  }
  if (calls.get(event.itemId)?.join("\n") === event.tail.join("\n")) return;
  calls.set(event.itemId, event.tail);
  changed();
}

export function commandTail(threadId: string | null | undefined, itemId: string | null | undefined): readonly string[] {
  return (threadId && itemId && threads.get(threadId)?.get(itemId)) || NONE;
}

export function forgetCommandTails(): void {
  if (threads.size === 0) return;
  threads.clear();
  changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useCommandTail(threadId: string | null | undefined, itemId: string | null | undefined): readonly string[] {
  return useSyncExternalStore(subscribe, () => commandTail(threadId, itemId), () => commandTail(threadId, itemId));
}
