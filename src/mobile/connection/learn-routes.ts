import { BACKGROUND_HEADERS } from "@/lib/cloud-power";
import { mobileTransports, type MobileConnectionRecord, type MobileRelayChannel, type MobileRoutesResponse, type MobileTransport } from "../../../shared/mobile-link";
import { sha256hex, type RelaySecrets } from "../transport/link-crypto";
import type { PhoneTransport } from "../transport/transport";

/** a pairing's routes as saved, an older pairing's one address included */
const savedRoutes = (record: Pick<MobileConnectionRecord, "via" | "origin" | "transport">): MobileTransport[] => record.via ?? (record.origin ? [record.transport === "companion"
  ? { kind: "companion", url: record.origin, net: "lan", priority: 0 }
  : { kind: "https", url: record.origin }] : []);

/** The saved routes with the place's current ones in: its https addresses and (when the computer said) its Wi-Fi and
 * tailnet addresses replace the old, the relay entries stay, and the route this connect just worked over is never
 * dropped. Null when nothing changes. */
export function mergedRoutes(record: Pick<MobileConnectionRecord, "via" | "origin" | "transport">, now: MobileRoutesResponse, working: PhoneTransport): MobileTransport[] | null {
  const saved = savedRoutes(record);
  const companion = now.companion ?? saved.filter((route) => route.kind === "companion");
  const fresh = mobileTransports([...now.https, ...saved.filter((route) => route.kind === "relay"), ...companion]);
  const urlOf = (route: MobileTransport) => (route.kind === "relay" ? null : route.url);
  const kept = working.kind === "bearer" ? saved.find((route) => urlOf(route) === working.origin) : undefined;
  const merged = kept && !fresh.some((route) => urlOf(route) === urlOf(kept)) ? [kept, ...fresh] : fresh;
  return JSON.stringify(merged) === JSON.stringify(saved) ? null : merged;
}

const relayChannel = (value: unknown): value is MobileRelayChannel => {
  const one = value as Partial<MobileRelayChannel> | null;
  return Boolean(one) && typeof one!.base === "string" && /^https?:\/\/[^/\s]+$/.test(one!.base) && typeof one!.channel === "string" && /^[a-z2-7]{10}$/.test(one!.channel)
    && typeof one!.agentPub === "string" && /^[A-Za-z0-9_-]{43}$/.test(one!.agentPub);
};
const sameChannel = (a: MobileConnectionRecord["relay"], b: MobileRelayChannel) => a?.base === b.base && a.channel === b.channel && a.agentPub === b.agentPub;

/** The phone's relay channel as the place serves it now: the one it said, or, when it has a relay but no channel for this
 * phone (paired while it had none, or it lost the phone's), one it opens now with this pairing's keys. Null when nothing
 * changes. */
async function healedRelay(record: MobileConnectionRecord, said: unknown, ask: typeof fetch, keys?: () => Promise<RelaySecrets>): Promise<MobileRelayChannel | null> {
  if (relayChannel(said)) return sameChannel(record.relay, said) ? null : said;
  if (said !== null || !keys) return null;
  const mine = await keys();
  const response = await ask("/api/mobile/relay", {
    method: "POST", headers: { "Content-Type": "application/json", ...BACKGROUND_HEADERS }, body: JSON.stringify({ pub: mine.pub, verifier: await sha256hex(mine.token) }), signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
  const opened: unknown = await response.json();
  return relayChannel(opened) && !sameChannel(record.relay, opened) ? opened : null;
}

/** Asks the place it just connected to for its routes now and saves them, so an address that changed since pairing is
 * learned instead of walked past forever, and a pairing without a working relay channel gets one without pairing again.
 * Quiet: an older place without the route, or no answer, keeps what is saved. */
export async function learnRoutes(record: MobileConnectionRecord, working: PhoneTransport & { asleep?: true },
  save: (id: string, via: MobileTransport[], relay?: MobileRelayChannel) => Promise<void>, ask: typeof fetch = fetch, keys?: () => Promise<RelaySecrets>): Promise<void> {
  if (working.asleep || working.kind === "same-origin") return;
  try {
    const response = await ask("/api/mobile/routes", { headers: BACKGROUND_HEADERS, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return; }
    const answer = await response.json() as Partial<MobileRoutesResponse>;
    if (!Array.isArray(answer.https) || !(answer.companion === null || Array.isArray(answer.companion))) return;
    const via = mergedRoutes(record, { https: answer.https, companion: answer.companion }, working);
    const relay = await healedRelay(record, answer.relay, ask, keys).catch(() => null);
    if (relay) await save(record.id, via ?? savedRoutes(record), relay);
    else if (via) await save(record.id, via);
  } catch { /* the saved routes stay */ }
}
