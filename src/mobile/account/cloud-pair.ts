import type { TypedPairing } from "../connection/pair";
import type { CloudPairResult, MobileCloud } from "./account-client";

export const WAKE_POLL_MS = 3_000;
export const WAKE_TRIES = 40;

type Pairing = { pairCloud(cloud: MobileCloud): Promise<CloudPairResult>; wakeCloud(): Promise<boolean> };

/** A pairing grant for the Cloud; an asleep one is woken first and asked again until it answers. The wake route
 * answers only for the account's primary Cloud, so another asleep one is reported asleep at once. */
export async function cloudPairing(account: Pairing, cloud: MobileCloud, options: {
  onWaking?: () => void; wait?: (ms: number) => Promise<void>; tries?: number; signal?: AbortSignal;
} = {}): Promise<CloudPairResult> {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let result = await account.pairCloud(cloud);
  if (result.outcome !== "asleep" || !cloud.primary) return result;
  options.onWaking?.();
  if (!(await account.wakeCloud())) return result;
  for (let tries = options.tries ?? WAKE_TRIES; tries > 0 && result.outcome === "asleep"; tries--) {
    if (options.signal?.aborted) return { outcome: "failed" };
    await wait(WAKE_POLL_MS);
    result = await account.pairCloud(cloud);
  }
  return result;
}

export function cloudPairingPayload(cloud: Pick<MobileCloud, "name">, grant: { origin: string; code: string; expiresAt: number }): TypedPairing {
  return { v: 1, transport: "https", origin: grant.origin, credential: "", code: grant.code.replace(/-/g, ""), name: cloud.name, expiresAt: grant.expiresAt };
}
