import type { PlanDriver } from "../shared/limit-reset.ts";
import type {
  CredentialStoreTarget,
  CursorIdeAuth,
  PlanFetchInit,
  PlanHttpResponse,
} from "./plan-usage-renewal.ts";

export type { PlanDriver };

export interface PlanWindow {
  available: boolean;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

/** Money in the provider's minor units: 4631 with exponent 2 is 46.31. */
export interface PlanSpend {
  usedMinor: number;
  limitMinor: number;
  currency: string;
  exponent: number;
}

export interface PlanExtra {
  label: string;
  remainingPercent: number;
  usedPercent: number;
  resetsAt: string | null;
  /** The amounts behind the percent, on a budget in money. */
  spend?: PlanSpend;
}

export interface PlanModelUsage {
  name: string;
  windows: PlanExtra[];
}

export interface PlanWindows {
  plan: string | null;
  fiveHour: PlanWindow;
  weekly: PlanWindow;
  extra: PlanExtra[];
  models: PlanModelUsage[];
}

export interface PlanProviderRow {
  id: string;
  name: string;
  driver: string;
  plan: string | null;
  ok: boolean;
  error: string | null;
  fiveHour: PlanWindow;
  weekly: PlanWindow;
  extra: PlanExtra[];
  models: PlanModelUsage[];
}

export interface PlanUsageReport {
  fetchedAt: string;
  providers: PlanProviderRow[];
}

export interface PlanAccount {
  id: string;
  name: string;
  driver: PlanDriver;
  environment: Record<string, string | undefined>;
  configDir?: string;
  /** Signed in through dusk bot (ChatGPT plan), not a CLI login on disk, so it has no usage reading. */
  noUsage?: true;
}

export interface PlanCredential {
  token: string | null;
  accountId: string | null;
  expired: boolean;
  refreshToken?: string | null;
  planHint?: string | null;
  store?: CredentialStoreTarget;
}

export interface CredentialReader {
  read(account: PlanAccount): PlanCredential | Promise<PlanCredential>;
}

export type PlanResponse = PlanHttpResponse;

export type PlanFetch = (url: string, init: PlanFetchInit) => Promise<PlanResponse>;

export interface PlanUsageDeps {
  fetch: PlanFetch;
  credentials: CredentialReader;
  now?: () => number;
  timeoutMs?: number;
}

export interface CredentialSource {
  readText: (path: string) => string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  dataDir?: string;
  writable?: boolean;
  readClaudeKeychain?: (service: string) => string | null | Promise<string | null>;
  readClaudeKeychainWithAccount?: (service: string, account?: string) => Promise<{ raw: string | null; account?: string }>;
  readCodexKeychain?: (service: string, account: string) => string | null | Promise<string | null>;
  readCursorKeychain?: () => Promise<{ accessToken: string | null; refreshToken: string | null }>;
  readCursorIdeDb?: (path: string) => CursorIdeAuth | null;
  readOpenCodeDbKey?: (opencodeDataDir: string) => string | null;
}

export function closedWindow(): PlanWindow {
  return { available: false, remainingPercent: null, usedPercent: null, resetsAt: null };
}

export function openWindow(usedPercent: number, resetsAt: string | null): PlanWindow {
  const used = clampPercent(usedPercent);
  return {
    available: true,
    usedPercent: used,
    remainingPercent: clampPercent(100 - used),
    resetsAt,
  };
}

export function extraLine(label: string, window: PlanWindow): PlanExtra {
  return {
    label,
    remainingPercent: window.remainingPercent ?? 0,
    usedPercent: window.usedPercent ?? 0,
    resetsAt: window.resetsAt,
  };
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 40) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function timeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.abs(value) >= 1e12 ? value : value * 1000;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return timeMs(Number(trimmed));
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isoOrNull(value: unknown): string | null {
  const ms = timeMs(value);
  if (ms == null) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function planLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || /[\r\n]/.test(trimmed)) return null;
  if (/bearer\s|access_token|refresh_token|sk-ant-|eyJ[a-zA-Z0-9_-]{8,}/i.test(trimmed)) return null;
  return trimmed;
}

export function secretString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 16_000 || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

export function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function missingCredential(): PlanCredential {
  return { token: null, accountId: null, expired: false };
}

export function expiredCredential(): PlanCredential {
  return { token: null, accountId: null, expired: true };
}

export function titleWords(suffix: string): string {
  const words = suffix.split(/[_\s-]+/).filter((part) => part.length > 0);
  if (words.length === 0) return "Window";
  return words.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(" ");
}

export function claudePlanName(subscriptionType: unknown, rateLimitTier: unknown): string | null {
  if (typeof subscriptionType !== "string") return null;
  let type = subscriptionType.trim().toLowerCase();
  if (!type) return null;
  if (type.startsWith("claude_")) type = type.slice("claude_".length);
  let label = titleWords(type);
  if (typeof rateLimitTier === "string") {
    const multiple = /\d+x/i.exec(rateLimitTier);
    if (multiple) label += ` ${multiple[0].toLowerCase()}`;
  }
  return planLabel(label);
}

export const naturalNumber = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;

/** A currency code as the provider sent it, when Intl can name it: Intl.NumberFormat throws on anything else. */
export function currencyCode(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z]{3}$/.test(value.trim())) return null;
  return value.trim().toUpperCase();
}

export function budgetLine(label: string, spend: PlanSpend): PlanExtra | null {
  if (spend.limitMinor <= 0) return null;
  return { ...extraLine(label, openWindow((spend.usedMinor / spend.limitMinor) * 100, null)), spend };
}

export function currencyDigits(currency: string): number | null {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? null;
  } catch {
    return null;
  }
}
