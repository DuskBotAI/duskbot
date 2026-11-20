// A conversation's sends reach the server in the order they were written when the network drops under them: a send
// written while an earlier one in its thread went out offline waits for that one to settle (sent, refused or handed to
// the outbox), for at most SEND_ORDER_WAIT_MS, so one stuck send never holds the next for good. Online, sends go at once.

/** how long a send waits on an earlier offline one in its thread before it goes anyway */
export const SEND_ORDER_WAIT_MS = 30_000;

const deviceOffline = () => globalThis.navigator?.onLine === false;
const tails = new Map<string, { tail: Promise<void>; offline: boolean }>();

export function inThreadOrder<T>(threadId: string | undefined, post: () => Promise<T>, wait = SEND_ORDER_WAIT_MS, offline = deviceOffline()): Promise<T> {
  if (!threadId) return post();
  const ahead = tails.get(threadId);
  const waitFor = ahead && (ahead.offline || offline) ? ahead.tail : null;
  const waits = waitFor !== null;
  const mine = waitFor ? Promise.race([waitFor, new Promise<void>((done) => setTimeout(done, wait))]).then(post) : post();
  const entry = { tail: mine.then(() => {}, () => {}), offline: offline || waits };
  tails.set(threadId, entry);
  void entry.tail.then(() => { if (tails.get(threadId) === entry) tails.delete(threadId); });
  return mine;
}
