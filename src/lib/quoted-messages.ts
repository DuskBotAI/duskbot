import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/state/api";
import type { Message } from "@/state/store";

const found = new Map<string, Message | null>();
const reading = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function read(threadId: string, messageId: string, key: string): Promise<void> {
  reading.add(key);
  try {
    const page = await api<{ messages?: Message[] }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages?around=${encodeURIComponent(messageId)}&limit=1`,
    );
    found.set(key, page.messages?.find((message) => message.id === messageId) ?? null);
  } catch (error) {
    if ((error as { status?: number })?.status === 404) found.set(key, null);
  } finally {
    reading.delete(key);
    for (const listener of listeners) listener();
  }
}

/** The message a reply quotes: the loaded one, or else read on its own from the server, so a quote shows however far
 * back the quoted message is from the rows a client holds. */
export function useQuotedMessage(threadId: string, replyToId: string | undefined, loaded: Message | undefined): Message | undefined {
  const key = replyToId && !loaded ? `${threadId}\n${replyToId}` : "";
  const snapshot = () => (key ? found.get(key) : undefined);
  const fetched = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (key && replyToId && !found.has(key) && !reading.has(key)) void read(threadId, replyToId, key);
  }, [key, threadId, replyToId]);
  return loaded ?? fetched ?? undefined;
}
