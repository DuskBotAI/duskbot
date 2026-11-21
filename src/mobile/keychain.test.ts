import { beforeEach, expect, it } from "vitest";
import { AFTER_FIRST_UNLOCK, keychainSecrets, UPGRADED_KEY } from "./keychain";
import { SecretsLocked, type MobilePlatform } from "./platform";

type Item = { value: string; access?: number };
let items: Map<string, Item>, prefs: Map<string, string>, active: boolean, failAccess: boolean;
const prefStore: MobilePlatform["prefs"] = { get: async (key) => prefs.get(key) ?? null, set: async (key, value) => { prefs.set(key, value); }, remove: async (key) => { prefs.delete(key); } };
// KeychainSwift's set: delete, then add; a locked phone refuses to read an item kept only while unlocked
const store = {
  get: async (key: string) => { const item = items.get(key); return item && (active || item.access === AFTER_FIRST_UNLOCK) ? item.value : null; },
  set: async (key: string, value: string, access?: number) => { items.delete(key); if (access !== undefined && failAccess) throw new Error("add failed"); items.set(key, { value, ...(access === undefined ? {} : { access }) }); },
  remove: async (key: string) => { items.delete(key); },
};
const secrets = (ios = true) => keychainSecrets({ store, prefix: "dusk.", ios, active: async () => active, prefs: prefStore });

beforeEach(() => { items = new Map(); prefs = new Map(); active = true; failAccess = false; });

it("a new secret is kept readable after the first unlock", async () => {
  await secrets().set("token.mac", "t");
  expect(items.get("dusk.token.mac")).toEqual({ value: "t", access: AFTER_FIRST_UNLOCK });
});

it("an item kept the old way is rewritten after first unlock the first time it is read, its value unchanged, once", async () => {
  items.set("dusk.token.mac", { value: "t" });
  const keychain = secrets();
  expect(await keychain.get("token.mac")).toBe("t");
  expect(items.get("dusk.token.mac")).toEqual({ value: "t", access: AFTER_FIRST_UNLOCK });
  expect(JSON.parse(prefs.get(UPGRADED_KEY)!)).toEqual(["dusk.token.mac"]);
  active = false;
  expect(await secrets().get("token.mac"), "a locked phone reads it now").toBe("t");
});

it("a rewrite the Keychain refuses puts the value back the old way", async () => {
  items.set("dusk.account", { value: "grant" });
  failAccess = true;
  expect(await secrets().get("account")).toBe("grant");
  expect(items.get("dusk.account")).toEqual({ value: "grant" });
  expect(prefs.has(UPGRADED_KEY)).toBe(false);
});

it("on a locked iPhone an unreadable item is SecretsLocked, never no secret; in front, missing is null", async () => {
  items.set("dusk.token.mac", { value: "t" });
  active = false;
  await expect(secrets().get("token.mac")).rejects.toBeInstanceOf(SecretsLocked);
  await expect(secrets().get("token.none")).rejects.toBeInstanceOf(SecretsLocked);
  active = true;
  expect(await secrets().get("token.none")).toBeNull();
  expect(await secrets(false).get("token.none"), "Android's Keystore has no lock to wait for").toBeNull();
});

it("a write right after a read is never undone by the read's rewrite", async () => {
  items.set("dusk.account", { value: "old" });
  const keychain = secrets();
  const [read] = await Promise.all([keychain.get("account"), keychain.set("account", "new")]);
  expect(read).toBe("old");
  expect(items.get("dusk.account")?.value).toBe("new");
});
