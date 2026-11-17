import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import { api } from "./api";
import type { Action, AppState, Bot, Group, Message } from "./store";
import type { TranscriptCache } from "./transcript-cache";
import { friendlyError } from "@/lib/plain-error";

/** How many of each conversation's newest messages the one startup read brings. */
export const BULK_PAGE = 50;
/** Past this many conversations the read asks for all of them rather than naming each in its URL. */
const NAMED_THREADS = 40;
const BULK_RETRY_MS = 3_000;
/** After this many failures the person is told, once; the reads keep trying, further apart, so a late server still lands. */
const BULK_REPORT_AFTER = 3;

/** The wait before the next bulk read: 3 s, doubling, capped so a long outage costs one request every 30 s. */
export function bulkRetryDelay(attempts: number): number {
  return Math.min(30_000, BULK_RETRY_MS * 2 ** Math.max(0, Math.min(attempts - 1, 4)));
}

type Owner = Bot | Group;
const needsPage = (owner: Owner | undefined) => Boolean(owner && (owner.transcriptLoaded === false || owner.transcriptStale));
type Page = { messages: Message[]; hasMore?: boolean; activeLeafId?: string | null };

/** The conversations without a current transcript (none yet, or one held from before the last snapshot). */
export function threadsNeedingPages(state: Pick<AppState, "bots" | "groups">): string[] {
  return [...state.bots, ...state.groups].filter(needsPage).map((owner) => owner.threadId).sort();
}

/** The main threads a bot's chat opens to while another of its threads is current, that the cache does not hold current. */
export function mainThreadsNeedingPages(bots: readonly Bot[], cache: Pick<TranscriptCache, "current"> | undefined): string[] {
  if (!cache) return [];
  return bots.flatMap((bot) => bot.mainThreadId && bot.mainThreadId !== bot.threadId && bot.tasks?.some((task) => task.threadId === bot.mainThreadId) &&
    !cache.current(bot.mainThreadId) ? [bot.mainThreadId] : []).sort();
}

/** Loads every conversation without a current transcript in one read once the snapshot lands, so any chat opens with
 * its messages already there; the open one also reads its own page at once if that read has not brought it yet. */
export function useSelectedTranscript(state: AppState, dispatch: Dispatch<Action>, pageSize: number, cache?: TranscriptCache): () => void {
  const current = useRef(state);
  current.current = state;
  const epoch = useRef(0);
  const reads = useRef(new Map<string, { controller: AbortController; result: Promise<void> }>());
  const mounted = useRef(true);
  const invalidate = useCallback(() => {
    epoch.current += 1;
    for (const request of reads.current.values()) request.controller.abort();
    reads.current.clear();
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; invalidate(); };
  }, [invalidate]);

  const fence = (threadId: string) => {
    const owner = [...current.current.bots, ...current.current.groups].find((candidate) => candidate.threadId === threadId);
    if (!owner || !needsPage(owner)) return null;
    return { generation: current.current.transcriptGeneration[threadId] ?? 0, heldAtStart: owner.messages,
      leafAtStart: "activeLeafId" in owner ? owner.activeLeafId : undefined };
  };
  const deliver = useCallback((threadId: string, page: Page, start: NonNullable<ReturnType<typeof fence>>) => {
    if (!Array.isArray(page.messages)) throw new Error("Invalid conversation snapshot");
    dispatch({ type: "transcriptSnapshot", threadId, messages: page.messages, hasMore: Boolean(page.hasMore), activeLeafId: page.activeLeafId, ...start });
  }, [dispatch]);

  const read = useCallback((threadId: string): Promise<void> | null => {
    const start = fence(threadId);
    if (!start) return null;
    const startedEpoch = epoch.current;
    const key = `${startedEpoch}:${threadId}`;
    let pending = reads.current.get(key);
    if (!pending) {
      const controller = new AbortController();
      const result = api<Page>(`/api/threads/${threadId}/messages?limit=${pageSize}`, { signal: controller.signal, timeoutMs: 30_000 })
        .then((page) => { if (mounted.current && epoch.current === startedEpoch) deliver(threadId, page, start); })
        .finally(() => { if (reads.current.get(key)?.result === result) reads.current.delete(key); });
      pending = { controller, result };
      reads.current.set(key, pending);
    }
    return pending.result;
  }, [deliver, pageSize]);

  const selected = state.bots.find((bot) => bot.id === state.selectedId) ?? state.groups.find((group) => group.id === state.selectedId);
  const threadId = selected?.threadId;
  const missing = needsPage(selected);
  useEffect(() => {
    if (!state.hydrated || state.activeView !== "chat" || !threadId || !missing) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const load = () => {
      const pending = read(threadId);
      if (!pending) return;
      void pending.then(() => {
        if (!stopped) retry = setTimeout(load, 0);
      }, (error) => {
        if (stopped) return;
        attempts += 1;
        if (attempts === 3) dispatch({ type: "error", message: friendlyError(error) });
        retry = setTimeout(load, Math.min(30_000, 1_000 * 2 ** Math.min(attempts - 1, 5)));
      });
    };
    load();
    return () => { stopped = true; clearTimeout(retry); };
  }, [state.hydrated, state.activeView, state.selectedId, state.transcriptGeneration, threadId, missing, read, dispatch]);

  // one read for every conversation still without a current transcript; a conversation already asked for in this
  // snapshot's read is not asked for again, and a failed read is tried again a moment later
  const asked = useRef({ epoch: -1, threads: new Set<string>() });
  const [retry, setRetry] = useState(0);
  const bulkFailures = useRef(0);
  const missingThreads = state.hydrated ? [...threadsNeedingPages(state), ...mainThreadsNeedingPages(state.bots, cache)].join(",") : "";
  useEffect(() => {
    if (!missingThreads) return;
    if (asked.current.epoch !== epoch.current) asked.current = { epoch: epoch.current, threads: new Set() };
    const wanted = missingThreads.split(",").filter((threadId) => !asked.current.threads.has(threadId));
    if (!wanted.length) return;
    for (const threadId of wanted) asked.current.threads.add(threadId);
    const starts = new Map(wanted.flatMap((threadId) => { const start = fence(threadId); return start ? [[threadId, start] as const] : []; }));
    const cachedAtStart = new Map(wanted.map((threadId) => [threadId, cache?.get(threadId)?.messages ?? []]));
    const startedEpoch = epoch.current;
    const controller = new AbortController();
    const key = `${startedEpoch}:bulk:${wanted.join(",")}`;
    const named = wanted.length <= NAMED_THREADS ? `&threads=${wanted.join(",")}` : "";
    const result = api<{ threads: Array<Page & { threadId: string }> }>(`/api/transcripts?limit=${BULK_PAGE}${named}`, { signal: controller.signal, timeoutMs: 60_000 })
      .then(({ threads }) => {
        if (!mounted.current || epoch.current !== startedEpoch || !Array.isArray(threads)) return;
        bulkFailures.current = 0;
        for (const page of threads) {
          const start = starts.get(page.threadId);
          if (start) deliver(page.threadId, page, start);
          else if (cache && Array.isArray(page.messages) && !current.current.bots.some((bot) => bot.threadId === page.threadId)) cache.confirm(page.threadId, page.messages, page.hasMore, page.activeLeafId, cachedAtStart.get(page.threadId));
        }
      })
      .catch((error) => {
        if (!mounted.current || epoch.current !== startedEpoch) return;
        for (const threadId of wanted) asked.current.threads.delete(threadId);
        bulkFailures.current += 1;
        if (bulkFailures.current === BULK_REPORT_AFTER) dispatch({ type: "error", message: friendlyError(error) });
        setTimeout(() => setRetry((count) => count + 1), bulkRetryDelay(bulkFailures.current));
      })
      .finally(() => { if (reads.current.get(key)?.result === result) reads.current.delete(key); });
    reads.current.set(key, { controller, result });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fence reads the latest state through a ref
  }, [missingThreads, retry, deliver, cache, dispatch]);
  return invalidate;
}
