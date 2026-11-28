import { useSyncExternalStore } from "react";

export const SHOW_PEER_REPLIES_KEY = "dusk-show-peer-replies";

let sessionChoice: boolean | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readShowPeerReplies(): boolean {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    return storage()?.getItem(SHOW_PEER_REPLIES_KEY) !== "0";
  } catch {
    return true;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== SHOW_PEER_REPLIES_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  sessionChoice = undefined;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

export function setShowPeerReplies(enabled: boolean): void {
  sessionChoice = enabled;
  try {
    storage()?.setItem(SHOW_PEER_REPLIES_KEY, enabled ? "1" : "0");
  } catch {
  }
  notify();
}

export function useShowPeerReplies(): boolean {
  return useSyncExternalStore(subscribe, readShowPeerReplies, () => true);
}
