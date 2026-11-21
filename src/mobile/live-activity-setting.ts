import { useSyncExternalStore } from "react";
import type { MobilePlatform } from "./platform";

const LIVE_ACTIVITY_KEY = "dusk.mobile.liveActivity";
let platform: MobilePlatform | null = null;
let enabled: boolean | undefined;
let preferenceRevision = 0;
const listeners = new Set<() => void>();

export async function installLiveActivitySetting(next: MobilePlatform): Promise<void> {
  platform = next;
  const revision = ++preferenceRevision;
  const saved = (await next.prefs.get(LIVE_ACTIVITY_KEY)) !== "off";
  if (revision !== preferenceRevision) return;
  enabled = saved;
  for (const listener of listeners) listener();
}

export function liveActivityEnabled(): boolean {
  return enabled === true;
}

export function setLiveActivityEnabled(on: boolean): void {
  if (enabled === on) return;
  preferenceRevision++;
  enabled = on;
  void platform?.prefs.set(LIVE_ACTIVITY_KEY, on ? "on" : "off");
  for (const listener of listeners) listener();
}

export function subscribeLiveActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLiveActivitySettingReady(): boolean {
  return useSyncExternalStore(subscribeLiveActivity, () => enabled !== undefined, () => false);
}

export function useLiveActivityEnabled(): boolean {
  return useSyncExternalStore(subscribeLiveActivity, liveActivityEnabled);
}
