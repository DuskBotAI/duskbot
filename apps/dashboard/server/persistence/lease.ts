import { hostname } from "node:os";

/** the account service's single-writer lease in `locks` */
export const LEASE_ID = "account-service";
export const LEASE_MS = 30_000;

export interface LeaseDoc { _id: string; owner: string; host?: string; pid?: number; expiresAt?: Date }
/** the part of a MongoDB collection the lease uses (a fake in tests) */
export interface LeaseCollection {
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: { upsert?: boolean }): Promise<{ matchedCount: number; modifiedCount: number }>;
  findOne(filter: Record<string, unknown>): Promise<LeaseDoc | null>;
}

/** A lease whose holder ran on `host` as a process that is gone. Another host's holder is never judged from here. */
export function holderGone(holder: { host?: unknown; pid?: unknown }, host: string, alive = processAlive): boolean {
  return holder.host === host && typeof holder.pid === "number" && Number.isInteger(holder.pid) && holder.pid > 0 && holder.pid !== process.pid && !alive(holder.pid);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

const duplicateKey = (error: unknown) => (error as { code?: unknown } | null)?.code === 11000;

export interface LeaseOptions {
  owner: string;
  /** give up after this long (scripts); the service itself waits as long as it takes */
  waitMs?: number;
  log?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  alive?: (pid: number) => boolean;
  host?: string;
  pid?: number;
}

/**
 * Takes the writer lease. A holder that is gone from this host (killed, crashed) is taken over at once; a live one (a
 * service still stopping) is waited for with a short backoff until it gives the lease back or it runs out, so a start
 * never exits because the service before it was slow to stop.
 */
export async function acquireLease(locks: LeaseCollection, o: LeaseOptions): Promise<void> {
  const now = o.now ?? Date.now, sleep = o.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))), log = o.log ?? (() => {});
  const host = o.host ?? hostname(), pid = o.pid ?? process.pid, deadline = now() + (o.waitMs ?? Infinity);
  const mine = () => ({ $set: { owner: o.owner, host, pid, expiresAt: new Date(now() + LEASE_MS) } });
  let tries = 0, saidAt = -Infinity;
  for (;;) {
    try {
      await locks.updateOne({ _id: LEASE_ID, $or: [{ owner: o.owner }, { expiresAt: { $lt: new Date(now()) } }] }, mine(), { upsert: true });
      return;
    } catch (error) {
      if (!duplicateKey(error)) throw error;
    }
    const holder = await locks.findOne({ _id: LEASE_ID });
    if (holder && holderGone(holder, host, o.alive)) {
      const taken = await locks.updateOne({ _id: LEASE_ID, owner: holder.owner }, mine());
      if (taken.modifiedCount === 1) { log(`took the writer lease from process ${holder.pid}, which is no longer running`); return; }
      continue;
    }
    if (now() > deadline) throw new Error("Another account service holds this database's writer lease.");
    if (now() - saidAt >= 10_000) { saidAt = now(); log("another account service holds the writer lease; waiting"); }
    await sleep(Math.min(250 * 2 ** tries++, 2_000));
  }
}
