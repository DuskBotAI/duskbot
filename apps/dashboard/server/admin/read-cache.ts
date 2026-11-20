// the admin's reads: one computation per question at a time, kept a short while, and never longer than a deadline.
// the panel refreshes on timers and opens several pages at once; without this every open tab re-read every raw event.

/** a read that ran past its deadline, or a database that could not answer: the panel says so instead of hanging */
export class ReadUnavailable extends Error {
  status: number; code: string;
  constructor(code: "admin_slow" | "admin_data_unavailable", message: string) { super(message); this.status = 503; this.code = code; }
}

/** a MongoDB driver failure (network, selection, a query past maxTimeMS): the data can't be read right now */
export function isDatabaseError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.startsWith("Mongo");
}

export interface ReadCacheOptions { now?: () => number; deadlineMs?: number; maxEntries?: number }
export interface ReadCache {
  /** the answer for `key`: a kept one younger than `ttlMs`, the one already being computed, or a new computation. with
   *  `staleMs`, a kept one up to that much older is answered at once while a fresh one is computed behind it */
  get<T>(key: string, ttlMs: number, work: () => Promise<T>, staleMs?: number): Promise<T>;
  /** keeps an answer computed elsewhere, as of `at`; an answer from before the last clear() is not kept */
  put(key: string, value: unknown, at: number, generation: number): void;
  /** when the kept answer for `key` was computed, null without one */
  keptAt(key: string): number | null;
  /** bumped by clear(): an answer started under an older generation is out of date */
  readonly generation: number;
  /** forgets every kept answer (after a change the panel made) */
  clear(): void;
  /** the deadline and database error mapping alone, for reads that are never kept */
  bounded<T>(work: Promise<T>): Promise<T>;
  readonly size: number;
}

export function createReadCache(options: ReadCacheOptions = {}): ReadCache {
  const now = options.now ?? Date.now, deadlineMs = options.deadlineMs ?? 25_000, maxEntries = options.maxEntries ?? 200;
  const kept = new Map<string, { at: number; value: unknown }>();
  const running = new Map<string, Promise<unknown>>();
  let generation = 0;
  function asUnavailable(error: unknown): never {
    if (isDatabaseError(error)) throw new ReadUnavailable("admin_data_unavailable", "The analytics database can't be read right now. The page will try again.");
    throw error;
  }
  /** bounds how long a caller waits, never the work: a read past the deadline keeps running and is kept for the next caller */
  function withDeadline<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ReadUnavailable("admin_slow", "This view is still loading. It will be ready in a moment.")), deadlineMs);
      timer.unref?.();
    });
    return Promise.race([work.catch(asUnavailable), late]).finally(() => clearTimeout(timer));
  }
  function keep(key: string, at: number, value: unknown) {
    kept.delete(key);
    kept.set(key, { at, value });
    while (kept.size > maxEntries) kept.delete(kept.keys().next().value!);
  }
  function compute<T>(key: string, ttlMs: number, work: () => Promise<T>): Promise<T> {
    const started = generation;
    const promise = work().then(value => {
      // an answer computed before a change is not kept past it
      if (started === generation && ttlMs > 0) keep(key, now(), value);
      return value;
    }).finally(() => { if (running.get(key) === promise) running.delete(key); });
    promise.catch(() => {});
    running.set(key, promise);
    return promise;
  }
  return {
    get size() { return kept.size; },
    get generation() { return generation; },
    put(key, value, at, from) { if (from === generation && (kept.get(key)?.at ?? -Infinity) < at) keep(key, at, value); },
    keptAt: key => kept.get(key)?.at ?? null,
    get<T>(key: string, ttlMs: number, work: () => Promise<T>, staleMs = 0): Promise<T> {
      const hit = kept.get(key);
      if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value as T);
      const inFlight = running.get(key) as Promise<T> | undefined;
      if (hit && ttlMs > 0 && now() - hit.at < ttlMs + staleMs) {
        // a failed refresh keeps the older answer; the next read tries again
        if (!inFlight) compute(key, ttlMs, work);
        return Promise.resolve(hit.value as T);
      }
      return withDeadline((inFlight ?? compute(key, ttlMs, work)) as Promise<T>);
    },
    // a read already running started before the change, so the next caller starts a new one
    clear() { kept.clear(); running.clear(); generation++; },
    bounded: withDeadline,
  };
}
