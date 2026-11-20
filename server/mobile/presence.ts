// Where each paired phone is: away (in the background, closed, or silent past its lease), or open and on which
// conversation. A phone open on a conversation is reading it, so nothing about that conversation pushes to it.
/** an open app says so at least this often; one that stops (killed, suspended, out of signal) counts as away */
export const PRESENCE_LEASE_MS = 60_000;
/** an open app checks in every 25 s; one silent this long may have been suspended before its "away" got out (iOS stops
 * a backgrounded WebView within seconds), so what it was shown may never have been seen */
export const PRESENCE_OVERDUE_MS = 30_000;

interface Phone {
  away: boolean;
  leaseUntil: number;
  viewing: string | null;
  reportedAt: number;
}

export function createPhonePresence(deps: { now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  const phones = new Map<string, Phone>();

  /** open and checked in within its lease */
  const open = (deviceId: string) => {
    const phone = phones.get(deviceId);
    return phone && !phone.away && now() < phone.leaseUntil ? phone : null;
  };

  return {
    /** what the phone says about itself: away when the app went to the background, else open on `viewing` (null: no chat) */
    report(deviceId: string, away: boolean, viewing: string | null = null) {
      phones.set(deviceId, { away, leaseUntil: away ? 0 : now() + PRESENCE_LEASE_MS, viewing: away ? null : viewing, reportedAt: now() });
    },
    /** how long until an open phone that stays silent counts as overdue (zero or less: it already is) */
    overdueIn: (deviceId: string): number => (phones.get(deviceId)?.reportedAt ?? -Infinity) + PRESENCE_OVERDUE_MS - now(),
    /** the phone said anything after `at` */
    reportedSince: (deviceId: string, at: number): boolean => (phones.get(deviceId)?.reportedAt ?? -Infinity) > at,
    /** a phone that never said anything (an older app, or this server just started) is away */
    away: (deviceId: string): boolean => !open(deviceId),
    /** the app is open on this conversation now */
    viewing: (deviceId: string, threadId: string): boolean => open(deviceId)?.viewing === threadId,
    forget(deviceId: string) {
      phones.delete(deviceId);
    },
  };
}
