import type { Bot, Group, Message } from "./store";
import { reconcileTranscript } from "./transcript-cache";

// One branch per transcript array and leaf: every sidebar row, the composer and the chat ask for it on each store
// change, and an unchanged transcript keeps the same array (so memos keyed on it hold).
const branches = new WeakMap<readonly Message[], { leafId: string; path: Message[] }>();

export function visibleMessages(bot: Pick<Bot, "messages" | "activeLeafId">): Message[] {
  const leafId = bot.activeLeafId;
  if (!leafId) return bot.messages;
  const cached = branches.get(bot.messages);
  if (cached?.leafId === leafId) return cached.path;
  const byId = new Map(bot.messages.map((m) => [m.id, m]));
  if (!byId.has(leafId)) return bot.messages;
  const path: Message[] = [];
  let cur = byId.get(leafId);
  while (cur) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  path.reverse();
  branches.set(bot.messages, { leafId, path });
  return path;
}

export function navigatedSince(
  owner: Pick<Bot, "threadId" | "switchingTo"> | undefined,
  since: Readonly<Record<string, number>> | undefined,
  current: Readonly<Record<string, number>>,
): boolean {
  return owner !== undefined && (owner.switchingTo !== undefined
    || (current[owner.threadId] ?? 0) !== (since?.[owner.threadId] ?? 0));
}

function keepNewTasks<T extends { threadId: string }>(previous: T[] | undefined, incoming: T[] | undefined, taskIdsAtStart: ReadonlySet<string> | undefined): T[] | undefined {
  if (!taskIdsAtStart) return incoming;
  const received = new Set(incoming?.map(task => task.threadId));
  const created = previous?.filter(task => !taskIdsAtStart.has(task.threadId) && !received.has(task.threadId)) ?? [];
  return created.length ? [...(incoming ?? []), ...created] : incoming;
}

export function keepBotNavigation(previous: Bot | undefined, incoming: Bot, preserve: boolean, taskIdsAtStart?: ReadonlySet<string>): Bot {
  if (!preserve || !previous) return incoming;
  return {
    ...incoming,
    threadId: previous.threadId,
    tasks: keepNewTasks(previous.tasks, incoming.tasks, taskIdsAtStart),
    switchingTo: previous.switchingTo,
    awaitingThreadSnapshot: previous.awaitingThreadSnapshot,
    messages: previous.messages,
    transcriptLoaded: previous.transcriptLoaded,
    transcriptStale: previous.transcriptStale,
    hasMore: previous.hasMore,
    activeLeafId: previous.activeLeafId,
    pinnedMessageId: previous.pinnedMessageId,
  };
}

export function openElsewhere(previous: Bot | undefined, incoming: Pick<Bot, "threadId" | "tasks">): previous is Bot {
  return previous !== undefined && previous.transcriptLoaded !== false && previous.threadId !== incoming.threadId
    && Boolean(incoming.tasks?.some((task) => task.threadId === previous.threadId));
}

export function keepGroupNavigation(previous: Group | undefined, incoming: Group, preserve: boolean, taskIdsAtStart?: ReadonlySet<string>): Group {
  if (!preserve || !previous) return incoming;
  return {
    ...incoming,
    threadId: previous.threadId,
    tasks: keepNewTasks(previous.tasks, incoming.tasks, taskIdsAtStart),
    messages: previous.messages,
    transcriptLoaded: previous.transcriptLoaded,
    transcriptStale: previous.transcriptStale,
    hasMore: previous.hasMore,
    pinnedCwd: previous.pinnedCwd,
    pinnedMessageId: previous.pinnedMessageId,
    usage: previous.usage,
    memberContext: previous.memberContext,
    busyBotId: previous.busyBotId,
    turnStartedAt: previous.turnStartedAt,
  };
}

/** A snapshot's conversation, keeping the transcript this device already holds for the same thread. A thread the
 * snapshot only previews keeps it as is, marked stale until its newest page confirms it; a thread the snapshot sends
 * whole keeps the older history above that page and every message object that did not change. */
export function heldTranscript<T extends Bot | Group>(previous: T | undefined, incoming: T, loaded: boolean): T {
  const held = previous && previous.threadId === incoming.threadId && previous.transcriptLoaded !== false ? previous : undefined;
  if (loaded) {
    if (!held) return { ...incoming, transcriptLoaded: true, transcriptStale: undefined };
    const kept = reconcileTranscript(held.messages, new Set(held.messages), incoming.messages, Boolean(incoming.hasMore), held.hasMore);
    const leaf = "modelSelection" in incoming && "modelSelection" in held ? leafAfterSnapshot(kept.messages, held.activeLeafId, incoming.activeLeafId) : undefined;
    return { ...incoming, ...kept, ...(leaf !== undefined ? { activeLeafId: leaf } : {}), transcriptLoaded: true, transcriptStale: undefined };
  }
  if (!held) return { ...incoming, transcriptLoaded: false, transcriptStale: undefined };
  const kept = { ...incoming, messages: held.messages, hasMore: held.hasMore, transcriptLoaded: true, transcriptStale: true };
  if (!("modelSelection" in kept) || !("modelSelection" in held)) return kept;
  const leaf = kept.activeLeafId && held.messages.some((message) => message.id === kept.activeLeafId) ? kept.activeLeafId : held.activeLeafId;
  return { ...kept, activeLeafId: leaf };
}

/** A snapshot asked for before a send can land after it: its leaf is then an ancestor of the one held (the send, or
 * what streamed in after it), and taking it would hide the send and every reply under it. Another branch still wins. */
function leafAfterSnapshot(messages: readonly Message[], held: string | null | undefined, incoming: string | null | undefined): string | null | undefined {
  if (!held || !incoming || held === incoming) return incoming;
  const byId = new Map(messages.map((message) => [message.id, message]));
  if (!byId.has(held)) return incoming;
  for (let at = byId.get(held)?.parentId; at; at = byId.get(at)?.parentId) if (at === incoming) return held;
  return incoming;
}

const NO_MESSAGES: Message[] = [];

/** What a chat may draw of a conversation: nothing while only the snapshot's preview of it is held, since a preview
 * is a few chosen lines, not the transcript. */
export function shownTranscript<T extends { messages: Message[]; transcriptLoaded?: boolean }>(owner: T): T {
  return owner.transcriptLoaded === false ? { ...owner, messages: NO_MESSAGES } : owner;
}

export function firstLivePage(
  held: Pick<Bot, "threadId" | "messages" | "transcriptLoaded" | "activeLeafId">,
  incoming: Pick<Bot, "threadId"> & Partial<Pick<Bot, "messages" | "hasMore" | "activeLeafId">>,
): Partial<Pick<Bot, "messages" | "hasMore" | "activeLeafId">> {
  if (incoming.threadId !== held.threadId || held.messages.length > 0 || held.transcriptLoaded === false || !incoming.messages?.length) return {};
  return { messages: incoming.messages, hasMore: incoming.hasMore, activeLeafId: incoming.activeLeafId ?? held.activeLeafId };
}
