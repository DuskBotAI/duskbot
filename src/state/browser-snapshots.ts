import { useEffect, useSyncExternalStore } from "react";

import { listenLiveFrames } from "@/lib/live-events";
import type { ServerFrame } from "../../shared/wire";

export interface BrowserSnapshot { src: string; at: number }

const MAX_SNAPSHOTS = 8;
const snapshots = new Map<string, BrowserSnapshot>();
const watched = new Map<string, Map<string, number>>();
const listeners = new Set<() => void>();
let stopFrames: (() => void) | null = null;

const conversation = (botId: string, threadId: string) => `${botId}\n${threadId}`;
const changed = () => { for (const listener of Array.from(listeners)) listener(); };

export function noteBrowserFrame(frame: ServerFrame, now = Date.now()): void {
  if (frame.kind !== "screen" || frame.surface !== "browser" || !frame.png) return;
  const stretches = watched.get(conversation(frame.botId, frame.threadId));
  const stretchId = stretches && [...stretches.keys()].at(-1);
  if (!stretchId) return;
  snapshots.delete(stretchId);
  snapshots.set(stretchId, { src: `data:${frame.mime ?? "image/png"};base64,${frame.png}`, at: now });
  if (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
  changed();
}

export function watchBrowserSnapshots(botId: string, threadId: string, stretchId: string): () => void {
  const key = conversation(botId, threadId);
  const stretches = watched.get(key) ?? new Map<string, number>();
  watched.set(key, stretches);
  stretches.set(stretchId, (stretches.get(stretchId) ?? 0) + 1);
  stopFrames ??= listenLiveFrames({ screens: true, onFrame: (frame) => noteBrowserFrame(frame) });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const left = (stretches.get(stretchId) ?? 1) - 1;
    if (left > 0) stretches.set(stretchId, left);
    else stretches.delete(stretchId);
    if (stretches.size === 0) watched.delete(key);
    if (watched.size === 0) {
      stopFrames?.();
      stopFrames = null;
    }
  };
}

export function browserSnapshot(stretchId: string | null | undefined): BrowserSnapshot | null {
  return (stretchId && snapshots.get(stretchId)) || null;
}

export function forgetBrowserSnapshots(): void {
  if (snapshots.size === 0) return;
  snapshots.clear();
  changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useBrowserSnapshot(target: { botId?: string; threadId?: string; stretchId: string }, watching: boolean): BrowserSnapshot | null {
  const { botId, threadId, stretchId } = target;
  useEffect(() => {
    if (!watching || !botId || !threadId) return;
    return watchBrowserSnapshots(botId, threadId, stretchId);
  }, [watching, botId, threadId, stretchId]);
  return useSyncExternalStore(subscribe, () => browserSnapshot(stretchId), () => browserSnapshot(stretchId));
}
