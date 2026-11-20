import { useEffect, useRef, useState } from "react";
import { activeLocale, t } from "@/lib/i18n";
import { formatCost } from "@/lib/usage-trace";
import { api } from "@/state/store";
import type { AllowanceReport, AutoTopUp, BatteryReport, DailyUsageReport, RoutineForecast, SpendCapInput, UsagePeriod } from "../../shared/spend";
import type { RoutineSchedule } from "../../shared/routines";
import { formatTokens } from "@/lib/usage";
import type { RoutinePause } from "../../shared/routines";
import { deviceHourCycle } from "@/lib/format-time";

export type { AllowanceReport, BatteryReport, BatteryRow, DailyUsageReport, DailyUsageSeries, RoutineForecast } from "../../shared/spend";

export const fetchBattery = (): Promise<BatteryReport> => api("/api/usage/battery");
export const fetchDaily = (days: number): Promise<DailyUsageReport> => api(`/api/usage/daily?days=${days}&tz=${new Date().getTimezoneOffset()}`);
export const fetchForecast = (routineId: string): Promise<RoutineForecast> => api(`/api/routines/${encodeURIComponent(routineId)}/forecast`);
export const saveCap = (input: SpendCapInput): Promise<unknown> => api("/api/usage/caps", { method: "PUT", body: JSON.stringify(input) });

const post = (path: string, body: unknown, method = "POST"): Promise<AllowanceReport> => api(path, { method, body: JSON.stringify(body) });
export const fetchAllowance = (): Promise<AllowanceReport> => api("/api/usage/allowance");
export const saveAllowance = (usd: number | null) => post("/api/usage/allowance", { usd }, "PUT");
export const addForWeek = (usd: number) => post("/api/usage/allowance/top-up", { usd });
export const setSaver = (on: boolean) => post("/api/usage/allowance/saver", { on });
export const saveAutoTopUp = (input: AutoTopUp) => post("/api/usage/allowance/auto", input, "PUT");
export const dismissAllowance = () => post("/api/usage/allowance/dismiss", {});

/** What "Add for this week" offers: a third of the week, in whole cents, at least a cent. */
export const topUpOffer = (weeklyUsd: number): number => Math.max(0.01, Math.round((weeklyUsd / 3) * 100) / 100);

/** "Monday 12:00 AM" for a reset time, in the app's language. */
export function resetWhen(at: number): string {
  return new Date(at).toLocaleString(activeLocale(), { weekday: "long", hour: "numeric", minute: "2-digit", hourCycle: deviceHourCycle() });
}

/** "in 2 days" or "in 5 hours" until a reset. */
export function resetIn(at: number, now = Date.now()): string {
  const hours = Math.max(1, Math.round((at - now) / 3_600_000));
  const format = new Intl.RelativeTimeFormat(activeLocale(), { numeric: "always" });
  return hours >= 48 ? format.format(Math.floor(hours / 24), "day") : format.format(hours, "hour");
}

export function sharePercent(share: number): string {
  return new Intl.NumberFormat(activeLocale(), { style: "percent", maximumFractionDigits: share > 0 && share < 0.01 ? 1 : 0 }).format(share);
}

/** Loads again whenever `version` changes; null until the first answer, and on a failure. */
export function useLoaded<T>(load: () => Promise<T>, version: unknown): T | null {
  return useLoadedState(load, version).value;
}

/** `useLoaded` that also says when the load failed, so a card can offer try again instead of checking forever */
export function useLoadedState<T>(load: () => Promise<T>, version: unknown): { value: T | null; failed: boolean; retry: () => void } {
  const [value, setValue] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const loader = useRef(load);
  useEffect(() => { loader.current = load; });
  useEffect(() => {
    let current = true;
    setFailed(false);
    void loader.current().then((next) => { if (current) setValue(next); }).catch(() => { if (current) { setValue(null); setFailed(true); } });
    return () => { current = false; };
  }, [version, attempt]);
  return { value, failed, retry: () => setAttempt((n) => n + 1) };
}

/** "About 168 runs a week · about $3.20 a week · 12% of your week", saying only what is known. */
export function forecastLine(forecast: RoutineForecast): string {
  const parts: string[] = [];
  if (forecast.runsPerWeek !== null) parts.push(forecast.runsPerWeek === 1 ? t("routines.cost.runs.one") : t("routines.cost.runs", { count: String(forecast.runsPerWeek) }));
  if (forecast.weekUsd !== null) parts.push(t("routines.cost.week", { amount: formatCost(forecast.weekUsd) }));
  else parts.push(t("routines.cost.noPrice"));
  if (forecast.shareOfWeek !== null) parts.push(t("routines.cost.share", { percent: sharePercent(forecast.shareOfWeek) }));
  return parts.join(" · ");
}

export function pauseLine(pause: RoutinePause): string {
  return pause.by === "cap"
    ? t("routines.paused.cap", { amount: formatCost(pause.capUsd) })
    : t("routines.paused.failures", { error: pause.error });
}

/** "12 runs · $0.40", or tokens while nothing it used has a price. */
export function periodLine(period: UsagePeriod): string {
  const runs = period.runs === 1 ? t("routines.usage.run.one") : t("routines.usage.runs", { count: String(period.runs) });
  return `${runs} · ${period.usd > 0 ? formatCost(period.usd) : t("routines.usage.tokens", { count: formatTokens(period.tokens) })}`;
}

const LESS_OFTEN_MINUTES = [15, 30, 60, 120, 240, 480, 1440] as const;

/** The next slower step for an every-N-minutes schedule; null for one that is not, or already runs once a day. */
export function lessOften(schedule: RoutineSchedule): RoutineSchedule | null {
  if (schedule.type !== "interval") return null;
  const next = LESS_OFTEN_MINUTES.find((minutes) => minutes > schedule.everyMinutes);
  return next ? { ...schedule, everyMinutes: next } : null;
}

/** The one warning worth reading, with the numbers it rests on: a spike first, then a share, then a pace. */
export function forecastWarning(forecast: RoutineForecast): string | null {
  if (forecast.warnings.includes("spike")) return t("routines.cost.spike");
  if (forecast.warnings.includes("costly") && forecast.shareOfWeek !== null) return t("routines.cost.costlyShare", { percent: sharePercent(forecast.shareOfWeek) });
  if (forecast.warnings.includes("frequent")) return t("routines.cost.frequent");
  return null;
}
