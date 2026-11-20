/** Spend wire shapes: the Battery view, a routine's cost forecast and the weekly caps, all in US dollars over the last
 * seven days. A share is of what every bot spent in that window, or of tokens while nothing there has a price. */

export interface BatteryRow {
  kind: "bot" | "routine";
  id: string;
  name: string;
  /** The bot a routine belongs to. */
  botId?: string;
  usd: number;
  tokens: number;
  /** 0 to 1. */
  share: number;
  capUsd?: number;
}

export interface BatteryReport {
  from: string;
  to: string;
  /** "usd" when anything in the window has a price, else "tokens". */
  basis: "usd" | "tokens";
  totalUsd: number;
  totalTokens: number;
  rows: BatteryRow[];
}

export type ForecastWarning = "frequent" | "costly" | "spike";

export interface RoutineForecast {
  /** Null when its schedule has no fixed rhythm (after a usage limit resets). */
  runsPerWeek: number | null;
  /** The average of its last few runs that have a price; null before any has one. */
  perRunUsd: number | null;
  weekUsd: number | null;
  /** Of what everything spent in the last seven days, 0 to 1; null while that is nothing. */
  shareOfWeek: number | null;
  warnings: ForecastWarning[];
  /** Each recent run's own cost, by run id. */
  runCosts: Record<string, number>;
  capUsd?: number;
  /** What it spent in the last seven days. */
  spentUsd: number;
  /** Runs that used anything, its own address's included, over the last 7 and 30 days, with what they spent and the
   *  tokens they used (input and output). */
  usage?: { week: UsagePeriod; month: UsagePeriod };
}

export interface UsagePeriod {
  runs: number;
  usd: number;
  tokens: number;
}

export interface SpendCapInput {
  kind: "bot" | "routine";
  id: string;
  /** Null removes the cap. */
  usd: number | null;
}

/** More often than this a day, a schedule is worth a second look. */
export const FREQUENT_RUNS_PER_DAY = 12;
/** A routine past this share of the last day's use, at several times its usual day, has spiked. */
export const SPIKE_SHARE = 0.25;
export const SPIKE_FACTOR = 3;
export const SPIKE_MIN_RUNS = 3;
/** A routine forecast to take more than this share of the week. */
export const COSTLY_SHARE = 0.1;
export const MAX_CAP_USD = 100_000;

/** One of the week's top spenders: a bot's own work, or one routine's. */
export interface AllowanceSpender {
  kind: "bot" | "routine";
  id: string;
  name: string;
  usd: number;
  /** The bot a routine belongs to. */
  botId?: string;
}

/** The account's weekly allowance in dollars, from Monday 12:00 AM to the next, on this computer's clock. */
export interface AllowanceReport {
  /** Null while no allowance is set: nothing waits and nothing is said. */
  weeklyUsd: number | null;
  /** Added for this week only. */
  extraUsd: number;
  limitUsd: number | null;
  /** What counts against it this week, never more than the limit. */
  spentUsd: number;
  /** What the step that crossed the limit went over by: on us, never counted. */
  overrunUsd: number;
  /** spentUsd of limitUsd, 0 to 1. */
  share: number;
  /** "near" from 80%, "over" at 100%. */
  level: "off" | "ok" | "near" | "over";
  weekStart: number;
  resetAt: number;
  top: AllowanceSpender[];
  /** Routines that skip until the reset while it is over, with their next time. */
  skipped: Array<{ routineId: string; name: string; at: number }>;
  /** Saver mode: chats run on a cheaper model until the reset. Only ever the person's choice. */
  saver: boolean;
  saverUsd: number;
  /** The person dismissed this level's notice for the week. */
  dismissed: boolean;
  autoTopUp: AutoTopUp & { monthUsd: number };
}

/** Off by default; when on, at most `monthlyCeilingUsd` a calendar month, `stepUsd` at a time. */
export interface AutoTopUp { on: boolean; stepUsd: number; monthlyCeilingUsd: number }

export const NEAR_SHARE = 0.8;

/** One bot's use per day on the usage graph, or every bot past the busiest few as one ("other", botId null). */
export interface DailyUsageSeries {
  key: string;
  botId: string | null;
  name: string;
  /** One amount per day, oldest first, in the report's basis. */
  values: number[];
  total: number;
  /** How many bots "other" stands for. */
  bots?: number;
}

/** Use per day, oldest first, on the viewer's own calendar days. */
export interface DailyUsageReport {
  /** YYYY-MM-DD, oldest first, ending today. */
  days: string[];
  /** "usd" when anything in the range has a price, else "tokens". */
  basis: "usd" | "tokens";
  total: number;
  /** Each day's total across every series. */
  totals: number[];
  series: DailyUsageSeries[];
}
