import { describe, expect, it } from "vitest";
import { acquireLease, LEASE_ID, type LeaseCollection, type LeaseDoc } from "./lease.ts";

/** `locks` as MongoDB answers the lease's calls: an upsert whose filter misses an existing _id is a duplicate key */
function fakeLocks(clock: { t: number }) {
  const docs = new Map<string, LeaseDoc>();
  const matches = (doc: LeaseDoc, filter: Record<string, unknown>): boolean => Object.entries(filter).every(([key, want]): boolean => {
    if (key === "$or") return (want as Array<Record<string, unknown>>).some(alt => matches(doc, alt));
    if (key === "expiresAt") return (doc.expiresAt?.getTime() ?? 0) < ((want as { $lt: Date }).$lt).getTime();
    return (doc as unknown as Record<string, unknown>)[key] === want;
  });
  const locks: LeaseCollection & { docs: typeof docs; release(owner: string): void; renew(owner: string): void } = {
    docs,
    async updateOne(filter, update, options) {
      const id = filter._id as string, doc = docs.get(id), set = (update as { $set: Partial<LeaseDoc> }).$set;
      if (doc && matches(doc, filter)) { docs.set(id, { ...doc, ...set }); return { matchedCount: 1, modifiedCount: 1 }; }
      if (!options?.upsert) return { matchedCount: 0, modifiedCount: 0 };
      if (doc) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      docs.set(id, { _id: id, ...set } as LeaseDoc);
      return { matchedCount: 0, modifiedCount: 0 };
    },
    async findOne(filter) { const doc = docs.get(filter._id as string); return doc && matches(doc, filter) ? doc : null; },
    release(owner) { if (docs.get(LEASE_ID)?.owner === owner) docs.delete(LEASE_ID); },
    /** the holder's 10 s renewal */
    renew(owner) { const doc = docs.get(LEASE_ID); if (doc?.owner === owner) doc.expiresAt = new Date(clock.t + 30_000); },
  };
  return locks;
}

describe("the writer lease on a restart", () => {
  it("a start next to a service that is still stopping waits for it instead of exiting, and takes the lease once it is given back", async () => {
    const clock = { t: 0 }, locks = fakeLocks(clock), now = () => clock.t;
    await acquireLease(locks, { owner: "old", host: "box", pid: 100, now });
    const lines: string[] = [];
    let slept = 0;
    // the old service stops slowly: it gives the lease back after 90 s, past the 75 s a start used to wait before exiting
    const sleep = async (ms: number) => { clock.t += ms; slept += 1; if (clock.t >= 90_000) locks.release("old"); else locks.renew("old"); };
    await acquireLease(locks, { owner: "new", host: "box", pid: 200, now, sleep, alive: () => true, log: line => lines.push(line) });
    expect(locks.docs.get(LEASE_ID)?.owner).toBe("new");
    expect(clock.t).toBeGreaterThanOrEqual(90_000);
    expect(clock.t).toBeLessThan(93_000);
    expect(slept).toBeGreaterThan(40);
    // said every 10 s, not on every try
    expect(lines.length).toBeLessThanOrEqual(10);
  });

  it("the old way (a 75 s limit) is what exited the start: a caller that sets a limit still gets the error", async () => {
    const clock = { t: 0 }, locks = fakeLocks(clock), now = () => clock.t;
    await acquireLease(locks, { owner: "old", host: "box", pid: 100, now });
    await expect(acquireLease(locks, { owner: "new", host: "box", pid: 200, now, waitMs: 75_000, alive: () => true, sleep: async ms => { clock.t += ms; locks.renew("old"); } })).rejects.toThrow(/writer lease/);
  });

  it("a holder killed on this host (SIGKILL after the supervisor's 5 s) is taken over at once", async () => {
    const clock = { t: 0 }, locks = fakeLocks(clock), now = () => clock.t;
    await acquireLease(locks, { owner: "old", host: "box", pid: 100, now });
    const lines: string[] = [];
    await acquireLease(locks, { owner: "new", host: "box", pid: 200, now, alive: pid => pid !== 100, sleep: async () => { throw new Error("must not wait"); }, log: line => lines.push(line) });
    expect(locks.docs.get(LEASE_ID)?.owner).toBe("new");
    expect(lines).toEqual(["took the writer lease from process 100, which is no longer running"]);
  });

  it("an expired lease from another host is taken without waiting", async () => {
    const clock = { t: 0 }, locks = fakeLocks(clock), now = () => clock.t;
    await acquireLease(locks, { owner: "elsewhere", host: "other", pid: 100, now });
    clock.t = 31_000;
    await acquireLease(locks, { owner: "new", host: "box", pid: 200, now, sleep: async () => { throw new Error("must not wait"); } });
    expect(locks.docs.get(LEASE_ID)?.owner).toBe("new");
  });
});
