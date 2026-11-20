import type { MobileConnectionRecord } from "../../shared/mobile-link";
import { CONNECTIONS_KEY } from "./connection/connections";
import type { MobilePlatform } from "./platform";

const OLD = "omb.";
const NEW = "dusk.";

const renamed = (key: string) => (key.startsWith(OLD) ? NEW + key.slice(OLD.length) : key);

function records(json: string | null): MobileConnectionRecord[] {
  try {
    const parsed: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((record): record is MobileConnectionRecord => typeof record?.id === "string" && typeof record?.environmentId === "string") : [];
  } catch { return []; }
}

/** The places, sign-ins and settings a build from before the rename to dusk bot kept under its old names (omb.*), moved to
 * the names this build reads, so an update from one keeps the person signed in and linked. What the phone already holds
 * under the new name wins; an item it cannot read now (a locked Keychain) stays where it is for the next launch. */
export async function moveLegacyStorage(platform: Pick<MobilePlatform, "prefs" | "secrets" | "legacySecrets">): Promise<void> {
  // the tokens move before the places that name them, so no place is ever saved without its token
  const legacy = platform.legacySecrets;
  for (const key of legacy ? await legacy.keys().catch(() => []) : []) {
    const value = await legacy!.get(key).catch(() => null);
    if (value === null) continue;
    const next = renamed(key);
    if ((await platform.secrets.get(next)) === null) await platform.secrets.set(next, value);
    await legacy!.remove(key);
  }
  const keys = await platform.prefs.keys?.().catch(() => null);
  for (const key of (keys ?? []).filter((one) => one.startsWith(OLD))) {
    const value = await platform.prefs.get(key);
    if (value === null) continue;
    const next = renamed(key);
    if (next === CONNECTIONS_KEY) {
      const kept = records(await platform.prefs.get(next));
      const moved: MobileConnectionRecord[] = [], waiting: MobileConnectionRecord[] = [];
      for (const record of records(value)) {
        if (kept.some((one) => one.id === record.id || (one.environmentId === record.environmentId && one.origin === record.origin))) continue;
        const token = await platform.secrets.get(`token.${record.id}`);
        (token === null && legacy ? waiting : moved).push({ ...record, sessionRef: `token.${record.id}` });
      }
      if (moved.length) await platform.prefs.set(next, JSON.stringify([...kept, ...moved]));
      if (waiting.length) { await platform.prefs.set(key, JSON.stringify(waiting)); continue; }
    } else if ((await platform.prefs.get(next)) === null) {
      await platform.prefs.set(next, value);
    }
    await platform.prefs.remove(key);
  }
}
