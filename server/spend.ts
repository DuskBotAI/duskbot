// What each bot and routine spent in the last seven days, read from the usage ledger and kept current as turns are
// booked, and the weekly caps people set on them (<data>/spend-caps.json, 0600). Only rows with a price count toward a
// cap, so a bot on an engine that reports no price is never paused by one.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  COSTLY_SHARE,
  FREQUENT_RUNS_PER_DAY,
  MAX_CAP_USD,
  SPIKE_FACTOR,
  SPIKE_MIN_RUNS,
  SPIKE_SHARE,
  type BatteryReport,
  type BatteryRow,
  type DailyUsageReport,
  type RoutineForecast,
  type SpendCapInput,
  type UsagePeriod,
} from "../shared/spend.ts";
import { writeFileAtomic } from "./atomic.ts";
import { nextOccurrence, type RoutineSchedule } from "./routine-schedules.ts";
import { readUsage, type UsageRow } from "./usage-ledger.ts";
import { clampDays, clampOffset, dailyStart, dailyUsage } from "./usage-daily.ts";

const DAY_MS = 24 * 60 * 60_000;
export const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const MONTH_FRESH_MS = 60_000;
const FORECAST_RUNS = 5;
const USUAL_RUNS = 3;
const RUN_COSTS_SHOWN = 20;
/** A schedule that fires every minute all week, the most a forecast counts. */
const MAX_OCCURRENCES = 7 * 24 * 60;

export interface Entry {
  at: number;
  botId: string;
  botName: string;
  routineId?: string;
  routineName?: string;
  runId?: string;
  usd: number;
  tokens: number;
}

interface CapsFile {
  bots: Record<string, number>;
  routines: Record<string, number>;
  /** When each cap's one notice went out, keyed "bot:<id>" or "routine:<id>"; cleared once spend falls back under. */
  told: Record<string, number>;
}

export interface CapHit {
  kind: "bot" | "routine";
  id: string;
  botId: string;
  name: string;
  capUsd: number;
  spentUsd: number;
}

/** A routine took a large share of the last day's use, well above its usual day: told once a week at most. */
export interface SpikeHit {
  routineId: string;
  botId: string;
  name: string;
  runs: number;
  /** Of everything used in the last day, 0 to 1. */
  share: number;
}

export interface SpendDeps {
  dataDir: string;
  now?: () => number;
  /** Once per crossing: a booked turn took a bot or routine to its cap. */
  onHit?: (hit: CapHit) => void;
  onSpike?: (hit: SpikeHit) => void;
}

function periodOf(entries: readonly Entry[]): UsagePeriod {
  const runs = new Set<string>();
  let usd = 0, tokens = 0;
  for (const entry of entries) {
    if (entry.runId) runs.add(entry.runId);
    usd += entry.usd;
    tokens += entry.tokens;
  }
  return { runs: runs.size, usd, tokens };
}

export interface ForecastRoutine {
  id: string;
  botId: string;
  schedule: RoutineSchedule;
  checks?: readonly string[];
}

const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

function entryOf(row: UsageRow): Entry {
  const trigger = row.trigger;
  const routine = trigger.kind === "routine" ? trigger : null;
  return {
    at: Date.parse(row.at),
    botId: row.botId,
    botName: row.botName || row.botId,
    ...(routine?.routineId ? { routineId: routine.routineId, routineName: routine.label ?? routine.routineId } : {}),
    ...(routine?.runId ? { runId: routine.runId } : {}),
    usd: finite(row.costUsd),
    tokens: finite(row.input) + finite(row.output),
  };
}

const record = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, amount]) => key && finite(amount) > 0 && finite(amount) <= MAX_CAP_USD)) as Record<string, number>;
};

export function validCap(input: unknown): SpendCapInput | null {
  if (!input || typeof input !== "object") return null;
  const { kind, id, usd } = input as Record<string, unknown>;
  if ((kind !== "bot" && kind !== "routine") || typeof id !== "string" || !/^[\w-]{1,200}$/.test(id)) return null;
  if (usd === null) return { kind, id, usd: null };
  return typeof usd === "number" && Number.isFinite(usd) && usd > 0 && usd <= MAX_CAP_USD ? { kind, id, usd: Math.round(usd * 100) / 100 } : null;
}

/** How many times a schedule fires in the seven days after `from`; null for one with no fixed rhythm. */
export function runsPerWeek(schedule: RoutineSchedule, from: number): number | null {
  if (schedule.type === "limit_reset") return null;
  let count = 0;
  for (let at = nextOccurrence(schedule, from); at !== null && at <= from + WEEK_MS && count < MAX_OCCURRENCES; at = nextOccurrence(schedule, at)) count += 1;
  return count;
}

export function createSpend(deps: SpendDeps) {
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, "spend-caps.json");
  let entries: Entry[] | null = null;
  let caps: CapsFile = load();

  function load(): CapsFile {
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as Partial<CapsFile>;
      return { bots: record(value.bots), routines: record(value.routines), told: record(value.told) };
    } catch {
      return { bots: {}, routines: {}, told: {} };
    }
  }

  function save(): void {
    try {
      writeFileAtomic(file, JSON.stringify(caps), { mode: 0o600 });
    } catch (error) {
      console.error(`spend: could not save the caps: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function window(): Entry[] {
    const since = now() - WEEK_MS;
    entries ??= readUsage(deps.dataDir, { from: new Date(since), to: new Date(now()) }).map(entryOf);
    if (entries.length && entries[0]!.at < since) entries = entries.filter((entry) => entry.at >= since);
    return entries;
  }

  let month: { at: number; entries: Entry[] } | null = null;
  function monthWindow(): Entry[] {
    const at = now();
    if (!month || at - month.at > MONTH_FRESH_MS) {
      month = { at, entries: readUsage(deps.dataDir, { from: new Date(at - MONTH_MS), to: new Date(at) }).map(entryOf) };
    }
    return month.entries;
  }

  /** Use is dollars while anything in the week has a price, else tokens, as the battery reads it. */
  function spikeOf(routineId: string): { runs: number; share: number } | null {
    const rows = window();
    const dayStart = now() - DAY_MS;
    const priced = rows.some((entry) => entry.usd > 0);
    const amount = (list: readonly Entry[]) => list.reduce((sum, entry) => sum + (priced ? entry.usd : entry.tokens), 0);
    const mine = rows.filter((entry) => entry.routineId === routineId);
    const today = mine.filter((entry) => entry.at >= dayStart);
    const runs = new Set(today.map((entry) => entry.runId).filter(Boolean)).size;
    if (runs < SPIKE_MIN_RUNS) return null;
    const day = amount(today);
    const all = amount(rows.filter((entry) => entry.at >= dayStart));
    const share = all > 0 ? day / all : 0;
    if (share < SPIKE_SHARE) return null;
    const usualDay = amount(mine.filter((entry) => entry.at < dayStart)) / 6;
    if (usualDay > 0 ? day < SPIKE_FACTOR * usualDay : runs < FREQUENT_RUNS_PER_DAY) return null;
    return { runs, share };
  }

  function checkSpike(entry: Entry): void {
    if (!entry.routineId) return;
    const key = `spike:${entry.routineId}`;
    const told = caps.told[key];
    if (told !== undefined && now() - told < WEEK_MS) return;
    const spike = spikeOf(entry.routineId);
    if (!spike) return;
    caps.told[key] = now();
    save();
    deps.onSpike?.({ routineId: entry.routineId, botId: entry.botId, name: entry.routineName ?? entry.routineId, ...spike });
  }

  const of = (kind: "bot" | "routine", id: string) => window().filter((entry) => (kind === "bot" ? entry.botId : entry.routineId) === id);
  const spent = (kind: "bot" | "routine", id: string) => of(kind, id).reduce((sum, entry) => sum + entry.usd, 0);
  const capOf = (kind: "bot" | "routine", id: string): number | undefined => (kind === "bot" ? caps.bots : caps.routines)[id];

  function hitOf(kind: "bot" | "routine", id: string, botId: string, name: string): CapHit | null {
    const capUsd = capOf(kind, id);
    if (capUsd === undefined) return null;
    const spentUsd = spent(kind, id);
    return spentUsd >= capUsd ? { kind, id, botId, name, capUsd, spentUsd } : null;
  }

  function check(kind: "bot" | "routine", id: string, botId: string, name: string): void {
    const key = `${kind}:${id}`;
    const hit = hitOf(kind, id, botId, name);
    if (!hit) {
      if (caps.told[key] !== undefined) { delete caps.told[key]; save(); }
      return;
    }
    if (caps.told[key] !== undefined) return;
    caps.told[key] = now();
    save();
    deps.onHit?.(hit);
  }

  return {
    /** Keeps a booked turn; its entry, for the allowance. */
    booked(row: UsageRow): Entry | null {
      const entry = entryOf(row);
      if (!Number.isFinite(entry.at)) return null;
      window().push(entry);
      check("bot", entry.botId, entry.botId, entry.botName);
      if (entry.routineId) check("routine", entry.routineId, entry.botId, entry.routineName ?? entry.routineId);
      checkSpike(entry);
      month?.entries.push(entry);
      return entry;
    },

    /** The cap that holds this bot's unattended work back right now, its routine's own first. */
    over(botId: string, routineId?: string): CapHit | null {
      return (routineId ? hitOf("routine", routineId, botId, of("routine", routineId)[0]?.routineName ?? routineId) : null) ??
        hitOf("bot", botId, botId, of("bot", botId).at(-1)?.botName ?? botId);
    },

    /** What was booked since `at` (within the last seven days), oldest first. */
    since(at: number): ReadonlyArray<Readonly<Entry>> {
      return window().filter((entry) => entry.at >= at);
    },

    /** A routine's usual run: the median of its last five priced runs, once it has three; null before. */
    usualRunUsd(routineId: string): number | null {
      const runs = new Map<string, { usd: number; at: number }>();
      for (const entry of of("routine", routineId)) {
        if (!entry.runId) continue;
        const run = runs.get(entry.runId) ?? { usd: 0, at: entry.at };
        run.usd += entry.usd;
        run.at = Math.max(run.at, entry.at);
        runs.set(entry.runId, run);
      }
      const priced = [...runs.values()].filter((run) => run.usd > 0).sort((a, b) => b.at - a.at).slice(0, FORECAST_RUNS).map((run) => run.usd).sort((a, b) => a - b);
      return priced.length >= USUAL_RUNS ? priced[Math.floor((priced.length - 1) / 2)]! : null;
    },

    caps(): { bots: Readonly<Record<string, number>>; routines: Readonly<Record<string, number>> } {
      return { bots: { ...caps.bots }, routines: { ...caps.routines } };
    },

    setCap(input: SpendCapInput): void {
      const list = input.kind === "bot" ? caps.bots : caps.routines;
      if (input.usd === null) delete list[input.id];
      else list[input.id] = input.usd;
      delete caps.told[`${input.kind}:${input.id}`];
      save();
    },

    /** Ranked like a phone's battery screen: who used what share of the week. */
    battery(names: { bot(id: string): string | undefined; routine(id: string): { name: string; botId: string } | undefined }): BatteryReport {
      const rows = window();
      const totalUsd = rows.reduce((sum, entry) => sum + entry.usd, 0);
      const totalTokens = rows.reduce((sum, entry) => sum + entry.tokens, 0);
      const basis = totalUsd > 0 ? "usd" : "tokens";
      const total = basis === "usd" ? totalUsd : totalTokens;
      const groups = new Map<string, BatteryRow>();
      const add = (kind: "bot" | "routine", id: string, name: string, entry: Entry, botId?: string) => {
        const key = `${kind}:${id}`;
        let row = groups.get(key);
        if (!row) {
          const capUsd = capOf(kind, id);
          groups.set(key, row = { kind, id, name, ...(botId ? { botId } : {}), usd: 0, tokens: 0, share: 0, ...(capUsd !== undefined ? { capUsd } : {}) });
        }
        row.usd += entry.usd;
        row.tokens += entry.tokens;
      };
      for (const entry of rows) {
        add("bot", entry.botId, names.bot(entry.botId) ?? entry.botName, entry);
        if (entry.routineId) {
          const routine = names.routine(entry.routineId);
          add("routine", entry.routineId, routine?.name ?? entry.routineName ?? entry.routineId, entry, routine?.botId ?? entry.botId);
        }
      }
      const ranked = [...groups.values()]
        .map((row) => ({ ...row, share: total > 0 ? (basis === "usd" ? row.usd : row.tokens) / total : 0 }))
        .filter((row) => row.share > 0)
        .sort((a, b) => b.share - a.share);
      return { from: new Date(now() - WEEK_MS).toISOString(), to: new Date(now()).toISOString(), basis, totalUsd, totalTokens, rows: ranked };
    },

    /** Each bot's use per day for the usage graph, on the viewer's calendar days. */
    daily(input: { days: unknown; offsetMinutes: unknown; bot(id: string): string | undefined }): DailyUsageReport {
      const days = clampDays(input.days), offsetMinutes = clampOffset(input.offsetMinutes), at = now();
      const rows = readUsage(deps.dataDir, { from: new Date(dailyStart(at, days, offsetMinutes)), to: new Date(at) });
      return dailyUsage(rows, { now: at, days, offsetMinutes, botName: input.bot });
    },

    /** `also`: the ids its runs are booked under besides its own, such as its address's. */
    forecast(routine: ForecastRoutine, also: readonly string[] = []): RoutineForecast {
      const rows = window();
      const ids = new Set([routine.id, ...also]);
      const mine = rows.filter((entry) => entry.routineId !== undefined && ids.has(entry.routineId));
      const byRun = new Map<string, { usd: number; at: number }>();
      for (const entry of mine) {
        if (!entry.runId) continue;
        const run = byRun.get(entry.runId) ?? { usd: 0, at: entry.at };
        run.usd += entry.usd;
        run.at = Math.max(run.at, entry.at);
        byRun.set(entry.runId, run);
      }
      const recent = [...byRun.entries()].sort((a, b) => b[1].at - a[1].at);
      const priced = recent.filter(([, run]) => run.usd > 0).slice(0, FORECAST_RUNS);
      const perRunUsd = priced.length ? priced.reduce((sum, [, run]) => sum + run.usd, 0) / priced.length : null;
      const perWeek = routine.checks?.length ? byRun.size : runsPerWeek(routine.schedule, now());
      const weekUsd = perRunUsd !== null && perWeek !== null ? perRunUsd * perWeek : null;
      const spentUsd = mine.reduce((sum, entry) => sum + entry.usd, 0);
      const projectedWeekUsd = rows.reduce((sum, entry) => sum + entry.usd, 0) - spentUsd + (weekUsd ?? 0);
      const shareOfWeek = weekUsd !== null && projectedWeekUsd > 0 ? weekUsd / projectedWeekUsd : null;
      const capUsd = capOf("routine", routine.id);
      return {
        runsPerWeek: perWeek,
        perRunUsd,
        weekUsd,
        shareOfWeek,
        warnings: [
          ...(perWeek !== null && perWeek > FREQUENT_RUNS_PER_DAY * 7 ? ["frequent" as const] : []),
          ...(shareOfWeek !== null && shareOfWeek > COSTLY_SHARE ? ["costly" as const] : []),
          ...(spikeOf(routine.id) ? ["spike" as const] : []),
        ],
        runCosts: Object.fromEntries(recent.slice(0, RUN_COSTS_SHOWN).map(([id, run]) => [id, run.usd])),
        ...(capUsd !== undefined ? { capUsd } : {}),
        spentUsd,
        usage: { week: periodOf(mine), month: periodOf(monthWindow().filter((entry) => entry.routineId !== undefined && ids.has(entry.routineId))) },
      };
    },

    /** Every routine that used anything in the last 30 days, with its 7- and 30-day runs and use, most first. */
    routineUsage(): Array<{ routineId: string; botId: string; name: string; week: UsagePeriod; month: UsagePeriod }> {
      const weekStart = now() - WEEK_MS;
      const groups = new Map<string, Entry[]>();
      for (const entry of monthWindow()) {
        if (!entry.routineId) continue;
        const list = groups.get(entry.routineId) ?? [];
        list.push(entry);
        groups.set(entry.routineId, list);
      }
      return [...groups.entries()].map(([routineId, entries]) => ({
        routineId,
        botId: entries.at(-1)!.botId,
        name: entries.at(-1)!.routineName ?? routineId,
        week: periodOf(entries.filter((entry) => entry.at >= weekStart)),
        month: periodOf(entries),
      })).sort((a, b) => b.month.usd - a.month.usd || b.month.tokens - a.month.tokens);
    },
  };
}

export type Spend = ReturnType<typeof createSpend>;
