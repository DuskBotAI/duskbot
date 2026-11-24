// A Cloud home, or a self-hosted server started with DUSK_ADOPT_TIME_ZONE=1, tells time in its owner's zone
// (server/time-zone.ts), or "every day at 9 AM" picked here would run at 9 AM UTC. The server decides: GET /api/time-zone
// says `adopts`, and only then does the owner's own app give it this device's zone whenever they differ, the way a
// laptop's clock follows its owner. Any other server costs one background read. Nothing shows; a failure is tried again
// on the next connect.
import { useEffect } from "react";

import type { WelcomeViewer } from "@/lib/onboarding";
import { api, useStore } from "@/state/store";

export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Only the owner's own devices: a guest or teammate has no admin scope, and their zone is not the owner's. */
export async function syncCloudTimeZone(zone: string | null, request: typeof api = api): Promise<boolean> {
  if (!zone) return false;
  // A read after every reconnect, not someone using My Cloud (src/state/api.ts `background`); the rare change below is.
  const current = await request<{ timeZone?: string; adopts?: boolean }>("/api/time-zone", { timeoutMs: 10_000, background: true });
  if (!current?.adopts || current.timeZone === zone) return false;
  await request("/api/time-zone", { method: "PUT", body: JSON.stringify({ timeZone: zone }), timeoutMs: 10_000 });
  return true;
}

export function CloudTimeZoneSync({ viewer }: { viewer: WelcomeViewer | null }) {
  const { state } = useStore();
  const due = Boolean(viewer?.canSave && state.connected);
  useEffect(() => {
    if (due) void syncCloudTimeZone(deviceTimeZone()).catch(() => {});
  }, [due]);
  return null;
}
