// The key itself is never kept, only a hash of it beside the provider's base URL.
import { createHash } from "node:crypto";

export const KEY_REJECTED_REASON = "The provider rejected this key. Change it in Settings → API keys.";

/** A refusal holds the key this long: a 401 from one route of a gateway or a provider's bad minute must not leave an AI
 * signed out for good (its turns were refused at the start, so nothing could prove the key works again). */
export const KEY_REJECTION_HOLD_MS = 10 * 60_000;
const rejected = new Map<string, number>();
const listeners = new Set<() => void>();

const fingerprint = (key: string) => createHash("sha256").update(key.trim()).digest("hex").slice(0, 32);
const markOf = (url: string, key: string) => `${url.trim().replace(/\/+$/, "")} ${fingerprint(key)}`;
const changed = () => { for (const listener of listeners) listener(); };

export function keyRejected(url: string, key: string, now = Date.now()): boolean {
  if (rejected.size === 0) return false;
  const mark = markOf(url, key);
  const until = rejected.get(mark);
  if (until === undefined) return false;
  if (until > now) return true;
  rejected.delete(mark);
  return false;
}

export function noteKeyRejected(url: string, key: string, now = Date.now()): void {
  const mark = markOf(url, key);
  const fresh = !keyRejected(url, key, now);
  rejected.set(mark, now + KEY_REJECTION_HOLD_MS);
  if (fresh) changed();
}

export function noteKeyAccepted(url: string, key: string): void {
  if (rejected.size > 0 && rejected.delete(markOf(url, key))) changed();
}

export function forgetKey(key: string): void {
  if (rejected.size === 0) return;
  const suffix = ` ${fingerprint(key)}`;
  const before = rejected.size;
  for (const mark of rejected.keys()) if (mark.endsWith(suffix)) rejected.delete(mark);
  if (rejected.size !== before) changed();
}

export function onKeyRejectionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** xAI answers a wrong key with HTTP 400, not 401. */
export function rejectsKey(status: number, body: string): boolean {
  if (/\b(?:quota|billing|credits?|rate.?limit|insufficient.?(?:balance|funds))\b/i.test(body)) return false;
  if (status === 401) return true;
  if (status !== 400 && status !== 403) return false;
  return /\binvalid_api_key\b|\b(?:invalid|incorrect|revoked|expired|disabled|deactivated)[ _-]?(?:api[ _-]?)?key\b|\bapi[ _-]?key (?:is |was |has been )?(?:invalid|incorrect|revoked|expired|disabled|not valid)\b/i.test(body);
}
