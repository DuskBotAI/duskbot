import { useEffect, useRef } from "react";
import { engineReady } from "@/components/EngineLibrary";
import { api, type InstanceInfo } from "@/state/store";
import { freeModel } from "./funnel";

/** While the hello is on screen: once the free model is downloaded and ready, one test message through the server's check
 * starts it, so "Use free models" answers the first message warm. Once per first run. */
export function useFreeWarmup(instances: readonly InstanceInfo[], on: boolean): void {
  const id = on ? freeModel(instances, engineReady)?.instanceId : undefined;
  const warmed = useRef(false);
  useEffect(() => {
    if (!id || warmed.current) return;
    warmed.current = true;
    void api(`/api/instances/${encodeURIComponent(id)}/check`, { method: "POST", body: "{}", timeoutMs: 60_000 }).catch(() => {});
  }, [id]);
}
