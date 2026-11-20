import { useSyncExternalStore } from "react";

/** How a usage figure reads: the share already spent, or the share still available. */
export type UsageDisplay = "used" | "left";

export const USAGE_DISPLAY_KEY = "dusk-usage-display";

let sessionChoice: UsageDisplay | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readUsageDisplay(): UsageDisplay {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    return storage()?.getItem(USAGE_DISPLAY_KEY) === "left" ? "left" : "used";
  } catch {
    return "used";
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== USAGE_DISPLAY_KEY && event.key !== null) return;
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

export function setUsageDisplay(display: UsageDisplay): void {
  sessionChoice = display;
  try {
    storage()?.setItem(USAGE_DISPLAY_KEY, display);
  } catch {
  }
  notify();
}

export function useUsageDisplay(): UsageDisplay {
  return useSyncExternalStore(subscribe, readUsageDisplay, readUsageDisplay);
}

/** The whole percent a figure shows for a share used: that share, or what is left of it. */
export function shownShare(usedPercent: number, display: UsageDisplay): number {
  const used = Math.min(100, Math.max(0, Math.round(usedPercent)));
  return display === "left" ? 100 - used : used;
}
