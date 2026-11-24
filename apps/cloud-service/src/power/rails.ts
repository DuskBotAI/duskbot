// The hard limits every stop and start passes, whatever policy asked for it. Nothing here weighs costs: it only says no.
// A stop is refused while anything is under way, too soon after a start, while the home's start budget is spent, while
// starts are failing, or when the next start might be refused; a start is refused past the provider's hard cap or its
// "not before" time, held back while its starts keep failing, and (when it can wait) spread out of a busy minute.
// Caps are kept by refusing stops, never by refusing a person: a home that spent its budget simply stays up.
// The monthly cost ceiling (ceiling.ts) is kept here too: nothing is charged to a home that its slack cannot pay for.
import type { SpendView } from "./ceiling.ts";
import { DAY, HOUR, MINUTE, POOL_WINDOWS, WINDOW_MS, type PoolCounts, type ProviderCostProfile } from "./cost.ts";
import { freshStats, type ActivityStats } from "./predictor.ts";

export type StartKind = "create" | "wake" | "routine" | "resize" | "recover";
/** a start somebody is waiting for; the others can wait for the rails */
export const INTENT_KINDS: ReadonlySet<StartKind> = new Set(["wake", "create", "recover", "resize"]);

/** what the lifecycle remembers about one home's power, kept on its record; every list is bounded */
export interface PowerMemory {
  stats: ActivityStats;
  /** its own starts and stops in the last day */
  starts: number[];
  stops: number[];
  /** starts that did not bring the home up, in the last day */
  failures: number[];
  breaker: { trips: number; openUntil: number; probeAt: number | null } | null;
  /** the minutes the person used the home in the last hour (one entry a minute; absent on older records) */
  uses?: number[];
}
export function freshMemory(now: number): PowerMemory { return { stats: freshStats(now), starts: [], stops: [], failures: [], breaker: null }; }

export interface RailSettings {
  /** a start is never undone sooner than this */
  minUptimeMs: number;
  /** never stop within this long of a person's last action, or of the start */
  minIdleMs: number;
  /** never stop within this long of work finishing */
  workBufferMs: number;
  /** someone using the home in earnest (engagedUses separate minutes of use in the last hour): never stop within this long of their last action */
  engagedIdleMs: number;
  engagedUses: number;
  /** no hint (an open app, a dashboard on screen) and no cost guess keeps a home up longer than this after the last input; only work does */
  maxNoInputMs: number;
  /** an asked-for wake is delivered first: no stop this long after one */
  wakeGraceMs: number;
  /** an open, focused app keeps a home up this long at most without use */
  focusCapMs: number;
  /** no stop when a run is due within this (it would only need a start again) */
  routineGuardMs: number;
  /** per home: starts per rolling hour and day; once spent, the home is not stopped until one ages out */
  maxStartsPerHour: number;
  maxStartsPerDay: number;
  /** a stop followed by a start within this is a flap: each one in the last day doubles the minimum idle */
  flapMs: number;
  maxMinIdleMs: number;
  /** failed starts within the window that open the breaker, and its backoff (doubling per trip) */
  breakerFailures: number;
  breakerWindowMs: number;
  breakerBaseMs: number;
  breakerMaxMs: number;
  /** the share of the minute window's included starts the fleet's pre-wakes are planned into, per minute */
  poolSoftShare: number;
  /** no stop while any window is past this share of the provider's hard cap */
  hardCapShare: number;
  /** worst-priced starts each home's monthly ceiling keeps for what we do not choose: the breaker's failures (3) and a
   *  probe, and one lost-machine rebuild; once that many such starts happened this month the home is not stopped again */
  costReserveStarts: number;
}
export const DEFAULT_RAILS: RailSettings = {
  minUptimeMs: 6 * MINUTE, minIdleMs: 3 * MINUTE, workBufferMs: 5 * MINUTE, engagedIdleMs: 30 * MINUTE, engagedUses: 3, maxNoInputMs: 2 * HOUR, wakeGraceMs: 3 * MINUTE, focusCapMs: 30 * MINUTE, routineGuardMs: 5 * MINUTE,
  maxStartsPerHour: 4, maxStartsPerDay: 16, flapMs: 10 * MINUTE, maxMinIdleMs: 2 * HOUR,
  breakerFailures: 3, breakerWindowMs: 30 * MINUTE, breakerBaseMs: 5 * MINUTE, breakerMaxMs: 2 * HOUR, poolSoftShare: 0.5, hardCapShare: 0.9,
  costReserveStarts: 5,
};

/** the account's shared start pool, as the ledger counts it */
export interface PoolView { used: PoolCounts; blockedUntil: number | null }

/** busy codes that are only hints for the policy; every other code (and any unknown one) means work is under way */
const SOFT_BUSY = new Set(["recent-activity", "focus"]);
export const realBusy = (busy: readonly string[]) => busy.filter(b => !SOFT_BUSY.has(b));

export function prune(memory: PowerMemory, now: number): PowerMemory {
  const keep = (list: number[]) => list.filter(t => t > now - DAY && t <= now + 5 * MINUTE).slice(-200);
  memory.starts = keep(memory.starts); memory.stops = keep(memory.stops); memory.failures = keep(memory.failures);
  return memory;
}

/** stops in the last day that a start followed within flapMs */
export function flaps(memory: PowerMemory, now: number, rails: RailSettings): number {
  return memory.stops.filter(s => s > now - DAY && memory.starts.some(t => t > s && t - s <= rails.flapMs)).length;
}

export const countSince = (list: readonly number[], from: number) => list.reduce((n, t) => n + (t > from ? 1 : 0), 0);

/** the person used the home at `at` (the home's last activity, read about once a minute): kept as its minute, for the last hour */
export function noteUse(memory: PowerMemory, at: number, now: number) {
  const uses = (memory.uses ?? []).filter(t => t > now - HOUR && t <= now + MINUTE), minute = Math.floor(at / MINUTE) * MINUTE;
  if (at > now - HOUR && at <= now + MINUTE && !uses.includes(minute)) uses.push(minute);
  memory.uses = uses.sort((a, b) => a - b).slice(-60);
}
/** using it in earnest: several separate minutes of use in the last hour */
export const engaged = (memory: PowerMemory, now: number, rails: RailSettings) => countSince(memory.uses ?? [], now - HOUR) >= rails.engagedUses;
/** the shortest idle before a stop: longer while someone has been using the home, doubled per flap, never past maxMinIdleMs
 *  unless the base itself is longer */
export function minIdleFor(memory: PowerMemory, now: number, rails: RailSettings): { ms: number; base: number } {
  const base = engaged(memory, now, rails) ? Math.max(rails.minIdleMs, rails.engagedIdleMs) : rails.minIdleMs;
  return { ms: Math.min(Math.max(rails.maxMinIdleMs, base), base * 2 ** flaps(memory, now, rails)), base };
}

export interface StopContext {
  now: number;
  /** when this start's machine came up (or was asked to) */
  awakeSince: number;
  busy: readonly string[];
  focusSince: number | null;
  lastActivityAt: number | null;
  wakeRequestedAt: number | null;
  /** the last time any work ran on the home (a turn, a run, a call, a computer, maintenance), from its power read */
  lastWorkAt?: number | null;
  /** when the next run has to begin, at the earliest */
  nextRunAt: number | null;
  memory: PowerMemory;
  pool: PoolView;
  profile: ProviderCostProfile;
  /** the home's monthly book; null only where no ledger is kept (a test) */
  spend?: SpendView | null;
}
export type Refusal = { reason: string; recheckAt: number };

// ---- the monthly cost ceiling. With W the worst start price, k the starts this month we did not choose and
// reserve = W * max(0, N - k): a stop needs slack >= reserve + W (the start that ends the sleep is paid for), a start we
// choose needs slack - W >= reserve, a start somebody waits for needs slack >= W, and any other charge X (backup storage,
// a second machine) needs slack - X >= reserve + W. Slack only shrinks by such charges, so it never goes below zero.

export const reserveCents = (v: SpendView) => v.worstStartCents * Math.max(0, v.reserveStarts - v.unplanned);
/** when slack grows to `need`, or an hour from now when it barely grows (an awake home of the cheapest size) */
const affordableAt = (v: SpendView, need: number, now: number) =>
  v.gainCentsPerHour > 1e-9 ? Math.min(now + 6 * HOUR, now + Math.ceil((need - v.slackCents) / v.gainCentsPerHour * HOUR)) : now + HOUR;

/** a stop is allowed only when the start after it is already paid for and the reserve is whole; `owner`: the owner asked,
 *  which only needs the start back paid for. Free starts (W = 0) leave nothing to reserve, so unchosen starts never hold a home up */
export function costStopRefusal(v: SpendView | null | undefined, now: number, owner = false): Refusal | null {
  if (!v) return null;
  if (owner) return v.slackCents >= v.worstStartCents ? null : { reason: "cost_ceiling", recheckAt: affordableAt(v, v.worstStartCents, now) };
  if (v.worstStartCents > 0 && v.unplanned >= v.reserveStarts) return { reason: "cost_reserve_used", recheckAt: now + HOUR };
  const need = reserveCents(v) + v.worstStartCents;
  return v.slackCents >= need ? null : { reason: "cost_ceiling", recheckAt: Math.max(now + MINUTE, affordableAt(v, need, now)) };
}
/** a start: one somebody waits for may use the reserve, one we choose may not; `extraCents` a second machine's own compute */
export function costStartRefusal(v: SpendView | null | undefined, kind: StartKind, now: number, extraCents = 0): Refusal | null {
  if (!v) return null;
  const need = extraCents > 0 ? reserveCents(v) + 2 * v.worstStartCents + extraCents
    : INTENT_KINDS.has(kind) ? v.worstStartCents : reserveCents(v) + v.worstStartCents;
  return v.slackCents >= need ? null : { reason: "cost_ceiling", recheckAt: Math.max(now + 5_000, affordableAt(v, need, now)) };
}
/** any other charge (more backup storage): never into the reserve or the next start */
export function costChargeRefusal(v: SpendView | null | undefined, cents: number, now: number): Refusal | null {
  if (!v || cents <= 0) return null;
  const need = reserveCents(v) + v.worstStartCents + cents;
  return v.slackCents >= need ? null : { reason: "cost_ceiling", recheckAt: affordableAt(v, need, now) };
}

/** whether a stop may happen now; null when it may */
export function stopRefusal(c: StopContext, rails: RailSettings = DEFAULT_RAILS): Refusal | null {
  const { now, memory } = c, no = (reason: string, at: number): Refusal => ({ reason, recheckAt: Math.max(now + 15_000, at) });
  const busy = realBusy(c.busy);
  if (busy.length) return no(`busy:${busy[0]}`, now + MINUTE);
  // work just finished: a short buffer for its follow-ups before any stop
  if (c.lastWorkAt != null && now - c.lastWorkAt < rails.workBufferMs) return no("work_buffer", c.lastWorkAt + rails.workBufferMs);
  if (now - c.awakeSince < rails.minUptimeMs) return no("min_uptime", c.awakeSince + rails.minUptimeMs);
  if (c.wakeRequestedAt !== null && now - c.wakeRequestedAt < rails.wakeGraceMs) return no("wake_grace", c.wakeRequestedAt + rails.wakeGraceMs);
  if (c.focusSince !== null && c.busy.includes("focus")) {
    const until = Math.max(c.focusSince, c.lastActivityAt ?? 0) + Math.min(rails.focusCapMs, rails.maxNoInputMs);
    if (now < until) return no("focused", Math.min(until, now + 5 * MINUTE));
  }
  const { ms: minIdle, base } = minIdleFor(memory, now, rails);
  const idleFrom = Math.max(c.lastActivityAt ?? 0, c.awakeSince);
  if (now - idleFrom < minIdle) return no(minIdle > base ? "flap_backoff" : base > rails.minIdleMs ? "in_use" : "min_idle", idleFrom + minIdle);
  if (c.nextRunAt !== null && c.nextRunAt - now <= rails.routineGuardMs) return no("routine_due", c.nextRunAt + MINUTE);
  if (memory.breaker && memory.breaker.openUntil > now) return no("starts_failing", memory.breaker.openUntil);
  const hourStarts = countSince(memory.starts, now - HOUR), dayStarts = countSince(memory.starts, now - DAY);
  if (hourStarts >= rails.maxStartsPerHour) return no("hour_budget_spent", (memory.starts.filter(t => t > now - HOUR)[0] ?? now) + HOUR);
  if (dayStarts >= rails.maxStartsPerDay) return no("day_budget_spent", (memory.starts.filter(t => t > now - DAY)[0] ?? now) + DAY);
  if (c.pool.blockedUntil !== null && c.pool.blockedUntil > now) return no("provider_not_before", c.pool.blockedUntil);
  if (!Number.isFinite(c.profile.startCents(c.pool.used))) return no("pool_exhausted", now + 5 * MINUTE);
  for (const w of POOL_WINDOWS) if (c.pool.used[w] >= rails.hardCapShare * c.profile.hardCap[w]) return no(`near_hard_cap_${w}`, now + Math.min(WINDOW_MS[w], 15 * MINUTE));
  return costStopRefusal(c.spend, now);
}

export interface StartContext {
  now: number;
  kind: StartKind;
  /** a start that can wait: the latest it may happen (a run's wake-by time); null for one somebody waits for */
  latest: number | null;
  memory: PowerMemory;
  pool: PoolView;
  profile: ProviderCostProfile;
  spend?: SpendView | null;
  /** a second machine of this home (a retired disk's keep-alive): its own compute until it is stopped again */
  extraCents?: number;
}

/** whether a start may happen now; null when it may */
export function startRefusal(c: StartContext, rails: RailSettings = DEFAULT_RAILS): Refusal | null {
  const { now, memory, pool, profile } = c, no = (reason: string, at: number): Refusal => ({ reason, recheckAt: Math.max(now + 5_000, at) });
  if (pool.blockedUntil !== null && pool.blockedUntil > now) return no("provider_not_before", pool.blockedUntil);
  for (const w of POOL_WINDOWS) if (pool.used[w] + 1 > profile.hardCap[w]) return no(`hard_cap_${w}`, now + Math.min(WINDOW_MS[w], 5 * MINUTE));
  if (!Number.isFinite(profile.startCents(pool.used))) return no("pool_exhausted", now + MINUTE);
  const b = memory.breaker;
  if (b && b.openUntil > now) {
    if (!INTENT_KINDS.has(c.kind)) return no("starts_failing", b.openUntil);
    // a person may still try, once per quarter of the backoff (at least two minutes apart)
    const spacing = Math.max(2 * MINUTE, breakerBackoff(b.trips, rails) / 4);
    if (b.probeAt !== null && now - b.probeAt < spacing) return no("starts_failing", b.probeAt + spacing);
  }
  if (c.latest !== null && now < c.latest) {
    // the planner gives pre-wakes poolSoftShare of each minute; this holds one that would make the minute window paid (a few
    // minutes of waiting cannot help the hour or day windows, so they are left to the price)
    if (pool.used.minute + 1 > profile.included.minute) return no("pool_smoothing", Math.min(c.latest, now + 20_000));
  }
  return costStartRefusal(c.spend, c.kind, now, c.extraCents ?? 0);
}

export const breakerBackoff = (trips: number, rails: RailSettings) => Math.min(rails.breakerMaxMs, rails.breakerBaseMs * 2 ** Math.max(0, trips - 1));

/** a start was asked for */
export function noteStart(memory: PowerMemory, now: number) {
  memory.starts.push(now);
  if (memory.breaker && memory.breaker.openUntil > now) memory.breaker.probeAt = now;
  prune(memory, now);
}
export function noteStop(memory: PowerMemory, now: number) { memory.stops.push(now); prune(memory, now); }
/** the home came up and answered: the breaker closes */
export function noteHealthy(memory: PowerMemory) { memory.breaker = null; }
/** a start did not bring the home up: true when this opened (or reopened) the breaker, which the operator hears about */
export function noteFailure(memory: PowerMemory, now: number, rails: RailSettings = DEFAULT_RAILS): boolean {
  memory.failures.push(now); prune(memory, now);
  if (countSince(memory.failures, now - rails.breakerWindowMs) < rails.breakerFailures) return false;
  if (memory.breaker && memory.breaker.openUntil > now) return false;
  const trips = (memory.breaker?.trips ?? 0) + 1;
  memory.breaker = { trips, openUntil: now + breakerBackoff(trips, rails), probeAt: null };
  return true;
}
