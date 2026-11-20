import { SecretsLocked, type MobilePlatform } from "./platform";

/** The Keychain/Keystore plugin's own calls, by the full stored key. `access` is its accessibility code. */
export type KeychainStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, access?: number): Promise<void>;
  remove(key: string): Promise<void>;
};

/** @aparajita/capacitor-secure-storage 8's code for kSecAttrAccessibleAfterFirstUnlock (iOS; Android ignores it). Items
 * written without one get KeychainSwift 21's default, kSecAttrAccessibleWhenUnlocked, which a locked iPhone refuses. */
export const AFTER_FIRST_UNLOCK = 2;
/** the stored keys already rewritten after first unlock, in the app's preferences */
export const UPGRADED_KEY = "dusk.mobile.secretsAfterFirstUnlock";

/**
 * The phone's secrets over the Keychain/Keystore plugin. The plugin answers null for an item it could not read as well as
 * for one that is not there, so on iOS a null while the app is not in front (a locked phone) is SecretsLocked, never "no
 * secret". Every item is kept readable after the first unlock since the phone started: one written before is rewritten
 * that way the first time it is read.
 */
export function keychainSecrets({ store, prefix, ios, active, prefs }: {
  store: KeychainStore;
  prefix: string;
  ios: boolean;
  /** the app is in front, so the phone is unlocked */
  active(): Promise<boolean>;
  prefs: MobilePlatform["prefs"];
}): MobilePlatform["secrets"] {
  const queues = new Map<string, Promise<unknown>>();
  const queued = <T,>(key: string, work: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
    queues.set(key, next.catch(() => {}));
    return next;
  };
  let upgraded: Promise<Set<string>> | null = null;
  const done = () => (upgraded ??= prefs.get(UPGRADED_KEY).then((json) => new Set<string>(JSON.parse(json ?? "[]") as string[]), () => new Set<string>()));
  const mark = async (key: string, on: boolean) => {
    const keys = await done();
    if (keys.has(key) === on) return;
    if (on) keys.add(key); else keys.delete(key);
    await prefs.set(UPGRADED_KEY, JSON.stringify([...keys])).catch(() => {});
  };
  // KeychainSwift's set deletes the item, then adds it: an add that fails puts the value back the old way
  const write = async (key: string, value: string) => {
    if (!ios) { await store.set(key, value); return; }
    try { await store.set(key, value, AFTER_FIRST_UNLOCK); }
    catch (error) { await store.set(key, value); throw error; }
    await mark(key, true);
  };
  return {
    get: (key) => queued(prefix + key, async () => {
      const stored = prefix + key;
      const value = await store.get(stored);
      if (value === null) {
        if (ios && !(await active().catch(() => true))) throw new SecretsLocked();
        return null;
      }
      if (ios && !(await done()).has(stored)) await write(stored, value).catch(() => {});
      return value;
    }),
    set: (key, value) => queued(prefix + key, () => write(prefix + key, value)),
    remove: (key) => queued(prefix + key, async () => { await store.remove(prefix + key); if (ios) await mark(prefix + key, false); }),
  };
}
