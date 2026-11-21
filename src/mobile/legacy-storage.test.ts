import { beforeEach, expect, it } from "vitest";
import type { MobileConnectionRecord } from "../../shared/mobile-link";
import { createConnectionStore } from "./connection/connections";
import { moveLegacyStorage } from "./legacy-storage";
import type { MobilePlatform } from "./platform";

let prefs: Map<string, string>, secrets: Map<string, string>, legacy: Map<string, string>, locked: Set<string>;
const platform = () => ({
  prefs: { get: async (key: string) => prefs.get(key) ?? null, set: async (key: string, value: string) => { prefs.set(key, value); }, remove: async (key: string) => { prefs.delete(key); }, keys: async () => [...prefs.keys()] },
  secrets: { get: async (key: string) => secrets.get(key) ?? null, set: async (key: string, value: string) => { secrets.set(key, value); }, remove: async (key: string) => { secrets.delete(key); } },
  legacySecrets: { keys: async () => [...legacy.keys()], get: async (key: string) => (locked.has(key) ? null : legacy.get(key) ?? null), remove: async (key: string) => { legacy.delete(key); } },
}) as unknown as MobilePlatform;
const record = (id: string, environmentId: string, origin: string): MobileConnectionRecord =>
  ({ id, environmentId, origin, label: id, transport: "https", sessionRef: `token.${id}`, createdAt: 1 } as unknown as MobileConnectionRecord);
const account = JSON.stringify({ origin: "https://dusk.bot", token: "omc_x", expiresAt: 9e15, account: { id: "a", email: "a@example.com" }, deviceId: "d" });

beforeEach(() => { prefs = new Map(); secrets = new Map(); legacy = new Map(); locked = new Set(); });

it("an update from a build with the old names keeps its places, its open place, its sign-in and its settings", async () => {
  legacy.set("token.mac", "session-mac").set("relay.mac", "{}").set("omb.account", account);
  prefs.set("omb.mobile.connections.v1", JSON.stringify([record("mac", "env-mac", "https://mac.example.org")]))
    .set("omb.mobile.active.v1", "mac").set("omb.mobile.haptics", "off").set("dusk.mobile.installed", "1");
  const phone = platform();
  await moveLegacyStorage(phone);
  expect(secrets.get("token.mac")).toBe("session-mac");
  expect(secrets.get("relay.mac")).toBe("{}");
  expect(secrets.get("dusk.account")).toBe(account);
  expect(prefs.get("dusk.mobile.haptics")).toBe("off");
  expect([...legacy.keys()], "the old items are gone once moved").toEqual([]);
  expect([...prefs.keys()].filter((key) => key.startsWith("omb."))).toEqual([]);
  const active = await createConnectionStore(phone).active();
  expect(active?.record.id).toBe("mac");
  expect(active?.token).toBe("session-mac");
});

it("what the phone holds under the new names wins, and old places it lost join the new ones", async () => {
  legacy.set("token.old-cloud", "session-cloud").set("token.mac-before", "stale").set("omb.account", "old-sign-in");
  secrets.set("token.mac", "session-mac").set("dusk.account", account);
  prefs.set("dusk.mobile.connections.v1", JSON.stringify([record("mac", "env-mac", "https://mac.example.org")])).set("dusk.mobile.active.v1", "mac")
    .set("omb.mobile.connections.v1", JSON.stringify([record("mac-before", "env-mac", "https://mac.example.org"), record("old-cloud", "env-cloud", "https://d1.dusk.bot")]))
    .set("omb.mobile.active.v1", "mac-before");
  await moveLegacyStorage(platform());
  expect(secrets.get("dusk.account")).toBe(account);
  expect(prefs.get("dusk.mobile.active.v1")).toBe("mac");
  expect((JSON.parse(prefs.get("dusk.mobile.connections.v1")!) as MobileConnectionRecord[]).map((one) => one.id)).toEqual(["mac", "old-cloud"]);
});

it("a Keychain item it cannot read now stays for the next launch, and its place waits with it", async () => {
  legacy.set("token.mac", "session-mac");
  locked.add("token.mac");
  prefs.set("omb.mobile.connections.v1", JSON.stringify([record("mac", "env-mac", "https://mac.example.org")]));
  await moveLegacyStorage(platform());
  expect(legacy.get("token.mac")).toBe("session-mac");
  expect(prefs.get("dusk.mobile.connections.v1") ?? null).toBeNull();
  locked.clear();
  await moveLegacyStorage(platform());
  expect((JSON.parse(prefs.get("dusk.mobile.connections.v1")!) as MobileConnectionRecord[]).map((one) => one.id)).toEqual(["mac"]);
  expect(secrets.get("token.mac")).toBe("session-mac");
  expect(prefs.has("omb.mobile.connections.v1")).toBe(false);
});

it("a phone with nothing old is left alone", async () => {
  prefs.set("dusk.mobile.installed", "1");
  await moveLegacyStorage(platform());
  expect([...prefs.entries()]).toEqual([["dusk.mobile.installed", "1"]]);
});
