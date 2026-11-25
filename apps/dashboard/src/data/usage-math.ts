import type { ActivityReport, ActivityTotals } from "../../../../shared/dashboard-protocol.ts";
import { dayKey } from "../lib/format.ts";

export type UsageGroup = "workspace" | "bot" | "model" | "type";
export type TokenKind = "input" | "output" | "cacheRead" | "cacheWrite";
export const TOKEN_KINDS: ReadonlyArray<{ key: TokenKind; label: string }> = [
  { key: "input", label: "input" }, { key: "output", label: "output" }, { key: "cacheRead", label: "cache read" }, { key: "cacheWrite", label: "cache write" },
];
/** tokens by type; `unsplit` is what a workspace on an app from before the split reported as one number */
export type TokenSplit = Record<TokenKind | "unsplit", number>;
export interface UsageSource {
  workspaceId: string;
  workspaceName: string;
  activity: ActivityReport | null;
  bots: Array<{ id: string; name: string; model: string | null }>;
}
export interface UsageEvent {
  date: string;
  workspaceId: string;
  workspaceName: string;
  bot: string;
  model: string;
  turns: number;
  tokens: number;
  costUsd: number | null;
}
export interface UsageSeries { key: string; label: string; values: number[] }
export interface UsageMonth {
  days: string[];
  events: UsageEvent[];
  totals: { turns: number; tokens: number; costUsd: number | null };
  /** exact per day, never estimated: workspaces report the split for each day */
  split: { days: TokenSplit[]; totals: TokenSplit };
  estimated: boolean;
}

export const emptySplit = (): TokenSplit => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unsplit: 0 });

export function tokenSplit(totals: ActivityTotals): TokenSplit {
  const split = emptySplit();
  if (totals.input === undefined && totals.output === undefined) return { ...split, unsplit: Math.round(totals.tokens) };
  for (const { key } of TOKEN_KINDS) split[key] = Math.round(totals[key] ?? 0);
  split.unsplit = Math.max(0, Math.round(totals.tokens) - split.input - split.output - split.cacheRead - split.cacheWrite);
  return split;
}

function addSplit(into: TokenSplit, add: TokenSplit) {
  for (const key of Object.keys(into) as Array<keyof TokenSplit>) into[key] += add[key];
}

export function monthDays(now: number): string[] {
  const date = new Date(now);
  return Array.from({ length: date.getDate() }, (_, i) => dayKey(new Date(date.getFullYear(), date.getMonth(), i + 1)));
}

export function nextMonthStart(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
}

function jitter(date: string, botId: string): number {
  let seed = 2166136261;
  for (const char of `${date}:${botId}`) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  seed ^= seed >>> 16;
  seed = Math.imul(seed, 2246822507) >>> 0;
  seed ^= seed >>> 13;
  return 0.65 + (seed >>> 0) / 4294967295 * 0.7;
}

function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((value, weight) => value + weight, 0);
  const shares = weights.map((weight) => total * weight / sum);
  const values = shares.map(Math.floor);
  const order = shares.map((value, index) => ({ index, remainder: value - values[index]! }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const remaining = total - values.reduce((value, part) => value + part, 0);
  for (let i = 0; i < remaining; i++) values[order[i]!.index]!++;
  return values;
}

export function usageMonth(sources: UsageSource[], now: number, opts?: { split?: "exact" | "estimate" }): UsageMonth {
  const days = monthDays(now), allowed = new Set(days), events: UsageEvent[] = [];
  const index = new Map(days.map((day, i) => [day, i])), split = { days: days.map(emptySplit), totals: emptySplit() };
  let estimated = false;
  for (const source of sources) {
    const { activity } = source;
    if (!activity) continue;
    const bots = activity.byBot;
    const model = activity.byModel.length === 1 ? activity.byModel[0]!.model : "Mixed";
    if (opts?.split !== "exact" && bots.length > 1) estimated = true;
    const base = bots.some((bot) => bot.tokens > 0) ? bots.map((bot) => bot.tokens) : bots.map(() => 1);
    for (const day of activity.days) {
      if (!allowed.has(day.date)) continue;
      const kinds = tokenSplit(day);
      addSplit(split.days[index.get(day.date)!]!, kinds);
      addSplit(split.totals, kinds);
      const common = { date: day.date, workspaceId: source.workspaceId, workspaceName: source.workspaceName };
      if (!bots.length) {
        events.push({ ...common, bot: "All bots", model, turns: day.turns, tokens: day.tokens, costUsd: day.costUsd === null ? null : Math.round(day.costUsd * 100) / 100 });
        continue;
      }
      const weights = bots.map((bot, i) => base[i]! * (opts?.split === "exact" ? jitter(day.date, bot.botId) : 1));
      const turns = allocate(Math.round(day.turns), weights), tokens = allocate(Math.round(day.tokens), weights);
      const included = bots.map((_, i) => turns[i]! > 0 || tokens[i]! > 0);
      const cost = day.costUsd === null || !included.some(Boolean) ? null : allocate(Math.round(day.costUsd * 100), weights.map((weight, i) => included[i] ? weight : 0));
      bots.forEach((bot, i) => {
        if (!included[i]) return;
        events.push({ ...common, bot: bot.botName, model, turns: turns[i]!, tokens: tokens[i]!, costUsd: cost === null ? null : cost[i]! / 100 });
      });
    }
  }
  events.sort((a, b) => b.date.localeCompare(a.date) || b.tokens - a.tokens);
  const turns = events.reduce((sum, event) => sum + event.turns, 0);
  const tokens = events.reduce((sum, event) => sum + event.tokens, 0);
  const costUsd = events.some((event) => event.costUsd !== null) ? events.reduce((sum, event) => sum + Math.round((event.costUsd ?? 0) * 100), 0) / 100 : null;
  return { days, events, totals: { turns, tokens, costUsd }, split, estimated };
}

export function seriesBy(month: UsageMonth, group: UsageGroup): UsageSeries[] {
  if (group === "type") {
    const kinds = [...TOKEN_KINDS, { key: "unsplit" as const, label: "not split" }];
    return kinds.filter(({ key }) => month.split.totals[key] > 0).map(({ key, label }) => ({ key, label, values: month.split.days.map((day) => day[key]) }));
  }
  const series = new Map<string, UsageSeries>();
  const indices = new Map(month.days.map((day, index) => [day, index]));
  for (const event of month.events) {
    const index = indices.get(event.date);
    if (index === undefined) continue;
    const key = group === "workspace" ? event.workspaceId : event[group];
    let entry = series.get(key);
    if (!entry) {
      entry = { key, label: group === "workspace" ? event.workspaceName : key, values: month.days.map(() => 0) };
      series.set(key, entry);
    }
    entry.values[index]! += event.tokens;
  }
  const total = (entry: UsageSeries) => entry.values.reduce((sum, value) => sum + value, 0);
  const sorted = [...series.values()].sort((a, b) => total(b) - total(a) || a.label.localeCompare(b.label));
  if (sorted.length <= 6) return sorted;
  return [...sorted.slice(0, 5), { key: "other", label: "Everything else", values: month.days.map((_, i) => sorted.slice(5).reduce((sum, entry) => sum + entry.values[i]!, 0)) }];
}

export function eventsCsv(events: UsageEvent[]): string {
  const quote = (value: string) => /[,"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const lines = events.map((event) => [event.date, event.workspaceName, event.bot, event.model, String(event.turns), String(event.tokens), event.costUsd === null ? "" : event.costUsd.toFixed(2)].map(quote).join(","));
  return ["Date,Workspace,Bot,Model,Turns,Tokens,Cost (USD)", ...lines].join("\r\n") + "\r\n";
}
