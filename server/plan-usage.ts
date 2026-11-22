// Access tokens stay in the request header only, never in the JSON result.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PlanDriver } from "../shared/limit-reset.ts";
import { DATA_DIR } from "./config.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import {
  ANTIGRAVITY_APP_DATA_DIR,
  ANTIGRAVITY_CLI_TOKEN_FILE,
  ANTIGRAVITY_LEGACY_TOKEN_FILE,
  antigravityProfileDirectory,
} from "./drivers/antigravity-acp.ts";
import { resolveClaudeConfigDir } from "./drivers/claude.ts";
import { codexHome } from "./drivers/codex-identity.ts";
import { harnessHome, sealedFixture, userHome } from "./env-path.ts";
import {
  antigravityUserAgent,
  CLAUDE_USER_AGENT,
  clearPlanUsageRenewalState,
  codexJwtAccountId,
  codexKeychainItem,
  codexUsesKeyring,
  cursorRenewalDue,
  decodeKeychainSecret,
  jwtExpiryMs,
  jwtSubject,
  readCursorStateDb,
  readDarwinKeychain,
  readOpenCodeGoDbKey,
  renewAntigravityToken,
  renewClaudeToken,
  renewCodexToken,
  renewCursorToken,
  renewGrokToken,
  type AntigravityRenewalTarget,
  type ClaudeRenewalTarget,
  type CodexRenewalTarget,
  type CredentialStoreTarget,
  type CursorIdeAuth,
  type CursorRenewalTarget,
  type GrokRenewalTarget,
  type PlanFetchInit,
  type PlanHttpResponse,
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

const PROVIDER_TIMEOUT_MS = 8_000;
const CURSOR_TIMEOUT_MS = 15_000;
const PLAN_USAGE_CACHE_MS = 45_000;
const CREDENTIAL_READ_MAX_BYTES = 1_000_000;
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_MODEL_FAMILIES = ["opus", "sonnet", "haiku"];
const MONTHLY_SPEND = "Monthly spend";
const EXTRA_USAGE = "Extra Usage";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const GROK_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const GROK_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
const ANTIGRAVITY_HOSTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
] as const;
const CURSOR_API_BASE = "https://api2.cursor.sh/aiserver.v1.DashboardService/";
const CURSOR_DASHBOARD_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const CURSOR_DASHBOARD_USAGE_URL = "https://cursor.com/api/usage";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

const FIVE_HOUR_MIN_SECONDS = 3 * 3600;
const FIVE_HOUR_MAX_SECONDS = 8 * 3600;
const WEEK_MIN_SECONDS = 5 * 86400;
const WEEK_MAX_SECONDS = 9 * 86400;
const MONTH_MIN_SECONDS = 27 * 86400;
const MONTH_MAX_SECONDS = 32 * 86400;
const WEEK_MS = 7 * 86_400_000;
const RATE_LIMIT_MIN_MS = 60_000;
const RATE_LIMIT_DEFAULT_MS = 300_000;
const RATE_LIMIT_MAX_MS = 3_600_000;

const DRIVER_OF: Record<string, PlanDriver> = {
  claudeAgent: "claude",
  codex: "codex",
  grokAgent: "grok",
  antigravityAgent: "antigravity",
  cursorAgent: "cursor",
  opencodeGo: "opencode",
};

const PRODUCT_NAME: Record<PlanDriver, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  antigravity: "Antigravity",
  cursor: "Cursor",
  opencode: "OpenCode Go",
};

const rateLimitCooldowns = new Map<string, { until: number; streak: number }>();
const lastGoodRows = new Map<string, PlanProviderRow>();
const antigravityPlanCache = new Map<string, string>();
const antigravityWeeklyResets = new Set<number>();
const cursorPlanInfoCache = new Map<string, Record<string, unknown>>();
const inFlightReports = new Map<string, Promise<PlanUsageReport>>();

export function planAccountsFromInstances(instances: InstanceConfigMap): PlanAccount[] {
  const accounts: PlanAccount[] = [];
  for (const [id, entry] of Object.entries(instances)) {
    const driver = DRIVER_OF[entry.driver];
    if (!driver) continue;
    const config = asRecord(entry.config);
    const configDir = typeof config?.configDir === "string" ? config.configDir : undefined;
    accounts.push({
      id,
      name: entry.displayName?.trim() || PRODUCT_NAME[driver],
      driver,
      environment: { ...entry.environment },
      ...(configDir ? { configDir } : {}),
      // a ChatGPT-plan provider or an API-key instance shares the signed-in account's folder: its limits are not this instance's
      ...(config?.authMode === "chatgpt-plan" || entry.access === "api" || config?.requireApiKey === true ? { noUsage: true as const } : {}),
    });
  }
  return accounts;
}

export function parseClaudeUsage(body: unknown, fallbackPlan: string | null = null): PlanWindows {
  const root = claudeRoot(body);
  let fiveHour = closedWindow();
  let weekly = closedWindow();
  const extra: PlanExtra[] = [];
  const models: PlanModelUsage[] = [];
  let parsedFromLimits = false;

  if (root && Array.isArray(root.limits)) {
    for (const item of root.limits) {
      const entry = asRecord(item);
      if (!entry) continue;
      const kind = typeof entry.kind === "string" ? entry.kind.trim() : "";
      const percent = numericValue(entry.percent);
      if (!kind || percent == null) continue;
      const resetsAt = isoOrNull(entry.resets_at ?? entry.resetsAt);
      const window = openWindow(percent, resetsAt);
      const group = typeof entry.group === "string" ? entry.group.trim().toLowerCase() : "";
      parsedFromLimits = true;
      if (kind === "session") {
        if (!fiveHour.available) fiveHour = window;
      } else if (kind === "weekly_all") {
        if (!weekly.available) weekly = window;
      } else {
        const scope = asRecord(entry.scope);
        const model = asRecord(scope?.model);
        const displayName = planLabel(model?.display_name ?? model?.displayName);
        if (displayName) {
          const label = group === "session" ? "5-hour" : group === "daily" ? "Daily" : "Weekly";
          addModelWindow(models, displayName, extraLine(label, window));
        } else {
          extra.push(extraLine(titleWords(kind), window));
        }
      }
    }
  }

  if (root && !parsedFromLimits) {
    for (const [key, value] of Object.entries(root)) {
      if (key === "five_hour" || key === "seven_day" || key === "spend" || key === "extra_usage" || key === "limits") continue;
      if (!/^[a-z][a-z0-9_]{0,40}$/i.test(key)) continue;
      const window = readClaudeWindow(value);
      if (!window) continue;
      const model = claudeModelWindow(key);
      if (model) addModelWindow(models, model.name, extraLine(model.window, window));
      else extra.push(extraLine(claudeExtraLabel(key), window));
    }
  }

  if (!fiveHour.available && root) fiveHour = readClaudeWindow(root.five_hour) ?? closedWindow();
  if (!weekly.available && root) weekly = readClaudeWindow(root.seven_day) ?? closedWindow();
  sortModelWindows(models);
  const budget = root && readClaudeBudget(root, fiveHour.available || weekly.available);
  if (budget) extra.unshift(budget);
  return {
    plan: planLabel(root?.subscription_type ?? root?.plan ?? root?.plan_type) ?? fallbackPlan,
    fiveHour,
    weekly,
    extra,
    models,
  };
}

export function parseCodexUsage(body: unknown, now = Date.now()): PlanWindows {
  const root = asRecord(body);
  const assigned = assignDurationWindows(durationWindows(root?.rate_limit, now));
  const models: PlanModelUsage[] = [];
  const extra = [...assigned.extra];
  if (root) collectCodexNamedLimits(root, models, extra, now);
  sortModelWindows(models);
  return { ...assigned, extra, models, plan: planLabel(root?.plan_type ?? root?.plan) };
}

export function parseGrokUsage(credits: unknown, billing?: unknown, settings?: unknown): PlanWindows {
  let fiveHour = closedWindow();
  let weekly = closedWindow();
  const extra: PlanExtra[] = [];
  const models: PlanModelUsage[] = [];
  let sawMonthly = false;
  const place = (sample: GrokSample | null) => {
    if (!sample) return;
    const window = openWindow(sample.used, sample.resetsAt);
    if (sample.slot === "fiveHour") {
      if (!fiveHour.available) fiveHour = window;
    } else if (sample.slot === "weekly") {
      if (!weekly.available) weekly = window;
    } else if (sample.slot === "monthly") {
      if (!sawMonthly) {
        sawMonthly = true;
        extra.push(extraLine("Monthly", window));
      }
    } else {
      extra.push(extraLine(sample.seconds == null ? "Credits" : durationLabel(sample.seconds), window));
    }
  };
  // Protobuf omits zero fields, so a credits reply with currentPeriod and no creditUsagePercent means 0% used.
  const creditSample = readGrokSample(credits, true);
  place(creditSample);
  const productSample = creditSample ?? { used: 0, slot: "other" as const, resetsAt: null, seconds: null };
  for (const model of readGrokProducts(credits, productSample)) addModelWindow(models, model.name, model.window);
  if (billing !== undefined) place(readGrokSample(billing, false));
  sortModelWindows(models);
  return { plan: grokPlan(settings), fiveHour, weekly, extra, models };
}

interface AntigravityBucket {
  id: "gemini-5h" | "gemini-weekly" | "3p-5h" | "3p-weekly" | "argon-weekly";
  used: number;
  remaining: number;
  resetsAt: string | null;
}

export function parseAntigravitySummary(bodies: readonly unknown[]): PlanWindows | null {
  const found = new Map<AntigravityBucket["id"], AntigravityBucket>();
  const recordBucket = (id: AntigravityBucket["id"], left: number, resetsAt: string | null) => {
    const existing = found.get(id);
    if (existing && !(existing.remaining >= 1 && left < 1)) return;
    found.set(id, { id, used: Math.round((1 - left) * 100), remaining: left, resetsAt });
  };
  for (const rawBody of bodies) {
    const body = asRecord(rawBody);
    const groups = Array.isArray(body?.groups) ? body.groups : [];
    for (const rawGroup of groups) {
      const group = asRecord(rawGroup);
      if (!group) continue;
      const isArgon = group.displayName === "Gemini 4 Argon";
      const buckets = Array.isArray(group.buckets) ? group.buckets : [];
      for (const rawBucket of buckets) {
        const bucket = asRecord(rawBucket);
        if (!bucket || bucket.disabled === true) continue;
        const rawLeft = numericValue(bucket.remainingFraction);
        if (rawLeft == null) continue;
        const left = Math.min(Math.max(rawLeft, 0), 1);
        const resetsAt = isoOrNull(bucket.resetTime);
        if (isArgon) {
          if (bucket.window === "weekly") recordBucket("argon-weekly", left, resetsAt);
        } else if (
          bucket.bucketId === "gemini-5h" ||
          bucket.bucketId === "gemini-weekly" ||
          bucket.bucketId === "3p-5h" ||
          bucket.bucketId === "3p-weekly"
        ) {
          recordBucket(bucket.bucketId, left, resetsAt);
        }
      }
    }
  }
  if (!found.size) return null;
  return antigravityWindowsFromBuckets(found, null);
}

export function parseAntigravityModels(
  modelsNode: unknown,
  now = Date.now(),
  rememberedWeekly: ReadonlySet<number> = antigravityWeeklyResets,
): PlanWindows | null {
  const modelsRecord = asRecord(modelsNode);
  if (!modelsRecord) return null;
  const found = new Map<AntigravityBucket["id"], AntigravityBucket>();
  for (const [key, rawModel] of Object.entries(modelsRecord)) {
    const model = asRecord(rawModel);
    if (!model || model.isInternal === true) continue;
    const name = typeof model.displayName === "string" && model.displayName.trim()
      ? model.displayName.trim()
      : typeof model.label === "string" && model.label.trim() ? model.label.trim() : "";
    const quota = asRecord(model.quotaInfo);
    if (!name || !quota) continue;
    if (name.toLowerCase().includes("argon") || key.toLowerCase().includes("argon")) continue;
    // Protobuf omits zero remainingFraction, so a quotaInfo block without remainingFraction is 100% used.
    const left = Math.min(Math.max(numericValue(quota.remainingFraction) ?? 0, 0), 1);
    const resetMs = timeMs(quota.resetTime);
    const resetsAt = resetMs != null ? new Date(resetMs).toISOString() : null;
    const weekly = resetMs != null && (resetMs - now > 5 * 3600_000 + 600_000 || rememberedWeekly.has(resetMs));
    const gemini = name.toLowerCase().includes("gemini");
    const id: AntigravityBucket["id"] = gemini
      ? (weekly ? "gemini-weekly" : "gemini-5h")
      : (weekly ? "3p-weekly" : "3p-5h");
    const used = Math.round((1 - left) * 100);
    const existing = found.get(id);
    if (existing && existing.used >= used) continue;
    found.set(id, { id, used, remaining: left, resetsAt });
  }
  if (!found.size) return null;
  return antigravityWindowsFromBuckets(found, null);
}

export function parseAntigravityPlan(body: unknown): string | null {
  const root = asRecord(body);
  if (!root) return null;
  const known: Record<string, string> = {
    "g1-pro-tier": "Pro",
    "g1-ultra-tier": "Ultra",
    "g1-ultra-lite-tier": "Ultra Lite",
    "free-tier": "Free",
  };
  const paid = asRecord(root.paidTier);
  const current = asRecord(root.currentTier);
  for (const tier of [paid, current]) {
    const id = typeof tier?.id === "string" ? tier.id.trim() : "";
    if (id && known[id]) return known[id];
  }
  const rawName = typeof paid?.name === "string" && paid.name.trim()
    ? paid.name.trim()
    : typeof current?.name === "string" && current.name.trim() ? current.name.trim() : "";
  if (!rawName) return null;
  return planLabel(rawName.startsWith("Google AI ") ? rawName.slice("Google AI ".length) : rawName);
}

function antigravityWindowsFromBuckets(
  buckets: ReadonlyMap<AntigravityBucket["id"], AntigravityBucket>,
  plan: string | null,
): PlanWindows {
  const asWindow = (bucket: AntigravityBucket | undefined) => bucket ? openWindow(bucket.used, bucket.resetsAt) : closedWindow();
  const hasGemini = buckets.has("gemini-5h") || buckets.has("gemini-weekly");
  const has3p = buckets.has("3p-5h") || buckets.has("3p-weekly");
  let fiveHour = closedWindow();
  let weekly = closedWindow();
  const models: PlanModelUsage[] = [];

  if (hasGemini) {
    fiveHour = asWindow(buckets.get("gemini-5h"));
    weekly = asWindow(buckets.get("gemini-weekly"));
    const thirdParty5h = buckets.get("3p-5h");
    const thirdPartyWeekly = buckets.get("3p-weekly");
    if (thirdParty5h) addModelWindow(models, "Claude & GPT", extraLine("5-hour", openWindow(thirdParty5h.used, thirdParty5h.resetsAt)));
    if (thirdPartyWeekly) addModelWindow(models, "Claude & GPT", extraLine("Weekly", openWindow(thirdPartyWeekly.used, thirdPartyWeekly.resetsAt)));
  } else if (has3p) {
    fiveHour = asWindow(buckets.get("3p-5h"));
    weekly = asWindow(buckets.get("3p-weekly"));
  } else if (buckets.has("argon-weekly")) {
    weekly = asWindow(buckets.get("argon-weekly"));
  }

  const argon = buckets.get("argon-weekly");
  if (argon && (hasGemini || has3p)) {
    addModelWindow(models, "Gemini 4 Argon", extraLine("Weekly", openWindow(argon.used, argon.resetsAt)));
  }
  sortModelWindows(models);
  return { plan, fiveHour, weekly, extra: [], models };
}

export function parseCursorUsage(
  usageBody: unknown,
  planInfoBody?: unknown,
  options: { planHint?: string | null; rememberedNow?: number | null } = {},
): PlanWindows {
  const usage = asRecord(usageBody);
  const planInfo = asRecord(asRecord(planInfoBody)?.planInfo) ?? asRecord(planInfoBody);
  const plan = planLabel(planInfo?.planName) ?? options.planHint ?? null;
  let weekly = closedWindow();
  const extra: PlanExtra[] = [];
  const models: PlanModelUsage[] = [];
  if (!usage) return { plan, fiveHour: closedWindow(), weekly, extra, models };

  const cycleEnd = isoOrNull(usage.billingCycleEnd);
  const isWeekly = planInfo?.includedUsagePeriod === "INCLUDED_USAGE_PERIOD_WEEKLY";
  let includedReset = cycleEnd;
  if (isWeekly) {
    let resetMs = timeMs(planInfo?.includedUsageResetsAt);
    if (options.rememberedNow != null && resetMs != null && resetMs <= options.rememberedNow) {
      const elapsedWeeks = Math.floor((options.rememberedNow - resetMs) / WEEK_MS) + 1;
      resetMs += elapsedWeeks * WEEK_MS;
    }
    includedReset = resetMs != null ? new Date(resetMs).toISOString() : null;
  }

  const planUsage = asRecord(usage.planUsage);
  if (planUsage) {
    const limit = numericValue(planUsage.limit);
    const remaining = numericValue(planUsage.remaining);
    const spent = numericValue(planUsage.totalSpend) ?? (limit != null && remaining != null ? limit - remaining : null);
    const percent = numericValue(planUsage.totalPercentUsed) ?? (spent != null && limit != null && limit > 0 ? (spent / limit) * 100 : null);
    if (percent != null) {
      const includedWindow = openWindow(percent, includedReset);
      if (isWeekly) weekly = includedWindow;
      else extra.push(extraLine("Monthly", includedWindow));
    }
    const auto = numericValue(planUsage.autoPercentUsed);
    const api = numericValue(planUsage.apiPercentUsed);
    if (auto != null && api != null && auto + api > 0) {
      const label = isWeekly ? "Weekly" : "Monthly";
      addModelWindow(models, "Cursor models", extraLine(label, openWindow(auto, includedReset)));
      addModelWindow(models, "Other models", extraLine(label, openWindow(api, includedReset)));
    }
  }

  const onDemand = asRecord(usage.spendLimitUsage);
  if (onDemand) {
    const individualLimit = numericValue(onDemand.individualLimit);
    const pooledLimit = numericValue(onDemand.pooledLimit);
    const individualUsed = numericValue(onDemand.individualUsed);
    const pooledUsed = numericValue(onDemand.pooledUsed);
    const totalSpend = numericValue(onDemand.totalSpend);
    const scope = individualLimit != null && individualLimit > 0
      ? { limit: individualLimit, used: individualUsed ?? totalSpend ?? 0 }
      : pooledLimit != null && pooledLimit > 0
        ? { limit: pooledLimit, used: pooledUsed ?? totalSpend ?? 0 }
        : null;
    if (scope) {
      const line = budgetLine("On-demand", {
        usedMinor: Math.max(0, Math.round(scope.used)),
        limitMinor: Math.round(scope.limit),
        currency: "USD",
        exponent: 2,
      });
      if (line) extra.push({ ...line, resetsAt: cycleEnd });
    }
  }

  return { plan, fiveHour: closedWindow(), weekly, extra, models };
}

export function parseCursorDashboardUsage(summaryBody: unknown, requestsBody: unknown): PlanWindows {
  const summary = asRecord(summaryBody);
  const requests = asRecord(requestsBody);
  const end = isoOrNull(summary?.billingCycleEnd);
  const extra: PlanExtra[] = [];
  const models: PlanModelUsage[] = [];

  const individual = asRecord(summary?.individualUsage);
  const plan = asRecord(individual?.plan);
  let hasMonthly = false;
  if (plan) {
    const total = numericValue(plan.totalPercentUsed);
    if (total != null) {
      hasMonthly = true;
      extra.push(extraLine("Monthly", openWindow(total, end)));
    }
    const auto = numericValue(plan.autoPercentUsed);
    const api = numericValue(plan.apiPercentUsed);
    if (auto != null && api != null && auto + api > 0) {
      addModelWindow(models, "Cursor models", extraLine("Monthly", openWindow(auto, end)));
      addModelWindow(models, "Other models", extraLine("Monthly", openWindow(api, end)));
    }
  }

  const gpt4 = asRecord(requests?.["gpt-4"]);
  const allowance = numericValue(gpt4?.maxRequestUsage);
  if (allowance != null && allowance > 0) {
    const used = Math.max(numericValue(gpt4?.numRequests) ?? 0, numericValue(gpt4?.numRequestsTotal) ?? 0);
    const monthStart = timeMs(requests?.startOfMonth);
    let requestReset = end;
    if (monthStart != null) {
      const date = new Date(monthStart);
      date.setUTCMonth(date.getUTCMonth() + 1);
      requestReset = date.toISOString();
    }
    extra.push(extraLine(hasMonthly ? "Requests" : "Monthly", openWindow((used / allowance) * 100, requestReset)));
  }

  const team = asRecord(summary?.teamUsage);
  for (const candidate of [asRecord(individual?.onDemand), asRecord(team?.onDemand)]) {
    if (!candidate || candidate.enabled === false) continue;
    const limit = numericValue(candidate.limit);
    if (limit == null || limit <= 0) continue;
    const usedRaw = numericValue(candidate.used);
    const remaining = numericValue(candidate.remaining);
    const used = usedRaw != null && usedRaw > 0 ? usedRaw : Math.max(0, limit - (remaining ?? limit));
    const line = budgetLine("On-demand", {
      usedMinor: Math.max(0, Math.round(used)),
      limitMinor: Math.round(limit),
      currency: "USD",
      exponent: 2,
    });
    if (line) extra.push({ ...line, resetsAt: end });
    break;
  }

  return { plan: null, fiveHour: closedWindow(), weekly: closedWindow(), extra, models };
}

export function parseOpenCodeUsage(body: unknown, now = Date.now()): PlanWindows {
  const usage = asRecord(asRecord(body)?.usage);
  let fiveHour = closedWindow();
  let weekly = closedWindow();
  const extra: PlanExtra[] = [];
  if (!usage) return { plan: "Go", fiveHour, weekly, extra, models: [] };

  const rolling = asRecord(usage.rolling);
  const rollingPercent = numericValue(rolling?.percent);
  if (rollingPercent != null) {
    const resetMs = timeMs(rolling?.resetsAt);
    // An idle OpenCode Go session reports a placeholder reset 5 hours ahead.
    const isIdlePlaceholder = rollingPercent === 0 && resetMs != null && Math.abs(resetMs - (now + 5 * 3600_000)) < 60_000;
    fiveHour = openWindow(rollingPercent, isIdlePlaceholder || resetMs == null ? null : new Date(resetMs).toISOString());
  }

  const weeklyNode = asRecord(usage.weekly);
  const weeklyPercent = numericValue(weeklyNode?.percent);
  if (weeklyPercent != null) weekly = openWindow(weeklyPercent, isoOrNull(weeklyNode?.resetsAt));

  const monthlyNode = asRecord(usage.monthly);
  const monthlyPercent = numericValue(monthlyNode?.percent);
  if (monthlyPercent != null) extra.push(extraLine("Monthly", openWindow(monthlyPercent, isoOrNull(monthlyNode?.resetsAt))));

  return { plan: "Go", fiveHour, weekly, extra, models: [] };
}

export function fileCredentialReader(source: CredentialSource): CredentialReader {
  const env = source.env ?? process.env;
  const now = source.now ?? Date.now;
  const dataDir = source.dataDir ?? DATA_DIR;
  return {
    async read(account) {
      const merged: NodeJS.ProcessEnv = { ...env, ...account.environment };
      const at = now();
      if (account.driver === "claude") return readClaudeCredential(account, merged, source, at);
      if (account.driver === "codex") return readCodexCredential(merged, source, at);
      if (account.driver === "grok") return readGrokCredential(merged, source, at);
      if (account.driver === "antigravity") return readAntigravityCredential(account, merged, source, at, dataDir);
      if (account.driver === "cursor") return readCursorCredential(merged, source, at);
      return readOpenCodeCredential(merged, source);
    },
  };
}

export function defaultCredentialReader(env: NodeJS.ProcessEnv = process.env, dataDir = DATA_DIR): CredentialReader {
  const allowHostStores = !sealedFixture();
  const isDarwin = process.platform === "darwin";
  return fileCredentialReader({
    env,
    dataDir,
    writable: true,
    readText(path) {
      try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > CREDENTIAL_READ_MAX_BYTES) return null;
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    ...(isDarwin && allowHostStores ? {
      readClaudeKeychain: (service) => readDarwinKeychain(service),
      readClaudeKeychainWithAccount: async (service, account) => {
        if (account) {
          const named = await readDarwinKeychain(service, account);
          if (named) return { raw: named, account };
        }
        return { raw: await readDarwinKeychain(service) };
      },
      readCodexKeychain: (service, account) => readDarwinKeychain(service, account),
      readCursorKeychain: async () => {
        const accessToken = secretString(decodeKeychainSecret(await readDarwinKeychain("cursor-access-token")));
        const refreshToken = secretString(decodeKeychainSecret(await readDarwinKeychain("cursor-refresh-token")));
        return { accessToken, refreshToken };
      },
    } : {}),
    ...(allowHostStores ? {
      readCursorIdeDb: readCursorStateDb,
      readOpenCodeDbKey: readOpenCodeGoDbKey,
    } : {}),
  });
}

export async function fetchPlanUsage(accounts: PlanAccount[], deps: PlanUsageDeps): Promise<PlanUsageReport> {
  const now = deps.now?.() ?? Date.now();
  const sameLogin = new Map<string, Promise<PlanProviderRow | null>>();
  const rows = await Promise.all(accounts.filter((account) => !account.noUsage).map((account) => fetchProvider(account, deps, sameLogin)));
  return { fetchedAt: new Date(now).toISOString(), providers: rows.filter((row): row is PlanProviderRow => row !== null) };
}

let cachedReport: { at: number; key: string; report: PlanUsageReport } | null = null;

export function clearPlanUsageCache(): void {
  cachedReport = null;
  rateLimitCooldowns.clear();
  lastGoodRows.clear();
  antigravityPlanCache.clear();
  antigravityWeeklyResets.clear();
  cursorPlanInfoCache.clear();
  inFlightReports.clear();
  clearPlanUsageRenewalState();
}

export async function loadPlanUsage(input: {
  accounts: PlanAccount[];
  refresh?: boolean;
  now?: number;
  fetch?: PlanFetch;
  credentials?: CredentialReader;
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  timeoutMs?: number;
}): Promise<PlanUsageReport> {
  const now = input.now ?? Date.now();
  const key = planUsageCacheKey(input.accounts);
  if (!input.refresh && cachedReport && cachedReport.key === key && now - cachedReport.at < PLAN_USAGE_CACHE_MS) {
    return cachedReport.report;
  }
  const flightKey = `${key}\0${input.refresh ? "1" : "0"}`;
  const running = inFlightReports.get(flightKey);
  if (running) return running;
  const request = fetchPlanUsage(input.accounts, {
    fetch: input.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    credentials: input.credentials ?? defaultCredentialReader(input.env, input.dataDir),
    now: () => now,
    timeoutMs: input.timeoutMs,
  }).then((report) => {
    cachedReport = { at: now, key, report };
    return report;
  }).finally(() => {
    inFlightReports.delete(flightKey);
  });
  inFlightReports.set(flightKey, request);
  return request;
}

function closedWindow(): PlanWindow {
  return { available: false, remainingPercent: null, usedPercent: null, resetsAt: null };
}

function openWindow(usedPercent: number, resetsAt: string | null): PlanWindow {
  const used = clampPercent(usedPercent);
  return {
    available: true,
    usedPercent: used,
    remainingPercent: clampPercent(100 - used),
    resetsAt,
  };
}

function extraLine(label: string, window: PlanWindow): PlanExtra {
  return {
    label,
    remainingPercent: window.remainingPercent ?? 0,
    usedPercent: window.usedPercent ?? 0,
    resetsAt: window.resetsAt,
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 40) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function timeMs(value: unknown): number | null {
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

function isoOrNull(value: unknown): string | null {
  const ms = timeMs(value);
  if (ms == null) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function planLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || /[\r\n]/.test(trimmed)) return null;
  if (/bearer\s|access_token|refresh_token|sk-ant-|eyJ[a-zA-Z0-9_-]{8,}/i.test(trimmed)) return null;
  return trimmed;
}

function secretString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 16_000 || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function missingCredential(): PlanCredential {
  return { token: null, accountId: null, expired: false };
}

function expiredCredential(): PlanCredential {
  return { token: null, accountId: null, expired: true };
}

function signInAgain(driver: PlanDriver): string {
  return `Sign in again in ${PRODUCT_NAME[driver]}`;
}

function couldNotReach(driver: PlanDriver): string {
  return `Could not reach ${PRODUCT_NAME[driver]}`;
}

function unexpectedUsage(driver: PlanDriver): string {
  return `${PRODUCT_NAME[driver]} returned an unexpected usage response`;
}

function rateLimitedError(driver: PlanDriver): string {
  return `${PRODUCT_NAME[driver]} is temporarily limiting usage checks. Trying again soon.`;
}

function claudePlanName(subscriptionType: unknown, rateLimitTier: unknown): string | null {
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

function claudeRoot(body: unknown): Record<string, unknown> | null {
  const root = asRecord(body);
  if (!root) return null;
  if ("five_hour" in root || "seven_day" in root || "limits" in root) return root;
  const nested = asRecord(root.usage) ?? asRecord(root.windows);
  if (nested && ("five_hour" in nested || "seven_day" in nested || "limits" in nested)) return nested;
  return root;
}

function readClaudeWindow(value: unknown): PlanWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  const utilization = numericValue(record.utilization);
  if (utilization == null) return null;
  return openWindow(utilization, isoOrNull(record.resets_at ?? record.resetsAt));
}

const naturalNumber = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;

/** A currency code as the provider sent it, when Intl can name it: Intl.NumberFormat throws on anything else. */
function currencyCode(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z]{3}$/.test(value.trim())) return null;
  return value.trim().toUpperCase();
}

function budgetLine(label: string, spend: PlanSpend): PlanExtra | null {
  if (spend.limitMinor <= 0) return null;
  return { ...extraLine(label, openWindow((spend.usedMinor / spend.limitMinor) * 100, null)), spend };
}

function readSpendBudget(value: unknown): PlanExtra | null {
  const spend = asRecord(value);
  if (spend?.enabled !== true) return null;
  const used = asRecord(spend.used), limit = asRecord(spend.limit);
  const currency = currencyCode(used?.currency);
  const exponent = naturalNumber(used?.exponent), usedMinor = naturalNumber(used?.amount_minor), limitMinor = naturalNumber(limit?.amount_minor);
  if (!currency || currency !== currencyCode(limit?.currency) || exponent === null || exponent !== limit?.exponent || usedMinor === null || limitMinor === null) return null;
  return budgetLine(MONTHLY_SPEND, { usedMinor, limitMinor, currency, exponent });
}

/** Claude Code 2.1.312 documents `used_credits` and `monthly_limit` as minor units of `currency` ("cents for USD") and has
 * no field saying how many digits those are, so the currency says. `is_enabled` false: this budget cannot cover a send. */
function readExtraUsage(value: unknown, label: string): PlanExtra | null {
  const extra = asRecord(value);
  if (extra?.is_enabled !== true) return null;
  const currency = currencyCode(extra.currency);
  const usedMinor = naturalNumber(extra.used_credits), limitMinor = naturalNumber(extra.monthly_limit);
  if (currency && usedMinor !== null && limitMinor !== null) {
    const exponent = naturalNumber(extra.decimal_places) ?? currencyDigits(currency);
    const line = exponent === null ? null : budgetLine(label, { usedMinor, limitMinor, currency, exponent });
    if (line) return line;
  }
  const used = numericValue(extra.utilization);
  return used === null ? null : extraLine(label, openWindow(used, null));
}

function currencyDigits(currency: string): number | null {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? null;
  } catch {
    return null;
  }
}

/** A plan with no rolling windows lives on its monthly budget (Claude Enterprise); on others that budget is the extra usage
 * bought on top of them. */
function readClaudeBudget(root: Record<string, unknown>, hasWindows: boolean): PlanExtra | null {
  return readSpendBudget(root.spend) ?? readExtraUsage(root.extra_usage, hasWindows ? EXTRA_USAGE : MONTHLY_SPEND);
}

function claudeExtraLabel(key: string): string {
  const suffix = key.startsWith("seven_day_")
    ? key.slice("seven_day_".length)
    : key.replace(/^five_hour_/, "");
  return titleWords(suffix);
}

function titleWords(suffix: string): string {
  const words = suffix.split(/[_\s-]+/).filter((part) => part.length > 0);
  if (words.length === 0) return "Window";
  return words.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(" ");
}

function claudeModelWindow(key: string): { name: string; window: string } | null {
  const weekly = key.startsWith("seven_day_");
  const fiveHour = key.startsWith("five_hour_");
  if (!weekly && !fiveHour) return null;
  const suffix = key.slice(weekly ? "seven_day_".length : "five_hour_".length);
  const lower = suffix.toLowerCase();
  const family = CLAUDE_MODEL_FAMILIES.find((name) => lower === name || lower.startsWith(`${name}_`));
  if (!family) return null;
  return { name: titleWords(suffix), window: weekly ? "Weekly" : "5-hour" };
}

function addModelWindow(models: PlanModelUsage[], name: string, line: PlanExtra): void {
  const found = models.find((model) => model.name.toLowerCase() === name.toLowerCase());
  if (found) found.windows.push(line);
  else models.push({ name, windows: [line] });
}

function sortModelWindows(models: PlanModelUsage[]): void {
  const rank = (label: string) => (label === "5-hour" ? 0 : label === "Weekly" ? 1 : 2);
  for (const model of models) model.windows.sort((a, b) => rank(a.label) - rank(b.label));
}

interface DurationWindow {
  used: number;
  seconds: number;
  resetsAt: string | null;
}

function readDurationWindow(value: unknown, now: number): DurationWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  const used = numericValue(record.used_percent);
  let seconds = numericValue(record.limit_window_seconds);
  if (seconds == null) {
    const minutes = numericValue(record.window_minutes);
    if (minutes != null) seconds = minutes * 60;
  }
  if (used == null || seconds == null || seconds <= 0) return null;
  let resetsAt = isoOrNull(record.reset_at ?? record.resetAt);
  if (!resetsAt) {
    const after = numericValue(record.reset_after_seconds);
    if (after != null && after >= 0) resetsAt = new Date(now + after * 1000).toISOString();
  }
  return { used, seconds, resetsAt };
}

function durationWindows(node: unknown, now: number): DurationWindow[] {
  const record = asRecord(node);
  if (!record) return [];
  const source = asRecord(record.rate_limit) ?? record;
  const windows: DurationWindow[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const window = readDurationWindow(source[key], now);
    if (window) windows.push(window);
  }
  if (windows.length === 0) {
    const self = readDurationWindow(source, now);
    if (self) windows.push(self);
  }
  return windows;
}

function codexLimitName(record: Record<string, unknown>): string | null {
  return planLabel(record.limit_name) ?? planLabel(record.metered_feature) ?? planLabel(record.name);
}

function pushAssignedLines(assigned: PlanWindows, into: PlanExtra[]): void {
  if (assigned.fiveHour.available) into.push(extraLine("5-hour", assigned.fiveHour));
  if (assigned.weekly.available) into.push(extraLine("Weekly", assigned.weekly));
  into.push(...assigned.extra);
}

function collectCodexNamedLimits(root: Record<string, unknown>, models: PlanModelUsage[], extra: PlanExtra[], now: number): void {
  const buckets: Array<{ name: string | null; node: unknown }> = [];
  if (root.code_review_rate_limit) buckets.push({ name: "Code review", node: root.code_review_rate_limit });
  const additional = root.additional_rate_limits;
  if (Array.isArray(additional)) {
    for (const item of additional) {
      const record = asRecord(item);
      buckets.push({ name: record ? codexLimitName(record) : null, node: item });
    }
  } else {
    const named = asRecord(additional);
    if (named) {
      for (const [key, value] of Object.entries(named)) buckets.push({ name: planLabel(key), node: value });
    }
  }
  for (const bucket of buckets) {
    const assigned = assignDurationWindows(durationWindows(bucket.node, now));
    if (!bucket.name) {
      pushAssignedLines(assigned, extra);
      continue;
    }
    const lines: PlanExtra[] = [];
    pushAssignedLines(assigned, lines);
    for (const line of lines) addModelWindow(models, bucket.name, line);
  }
}

function readGrokProducts(body: unknown, sample: GrokSample): Array<{ name: string; window: PlanExtra }> {
  const root = asRecord(body);
  if (!root) return [];
  const config = asRecord(root.config) ?? root;
  if (!Array.isArray(config.productUsage)) return [];
  const label = sample.slot === "fiveHour" ? "5-hour" : sample.slot === "weekly" ? "Weekly" : sample.slot === "monthly" ? "Monthly" : "Used";
  const rows: Array<{ name: string; window: PlanExtra }> = [];
  for (const item of config.productUsage) {
    const record = asRecord(item);
    if (!record) continue;
    const raw = typeof record.product === "string" ? record.product : typeof record.name === "string" ? record.name : "";
    const name = planLabel(raw.replace(/([a-z])([A-Z])/g, "$1 $2"));
    const used = numericValue(record.usagePercent ?? record.usedPercent ?? record.utilization);
    if (!name || used == null) continue;
    rows.push({ name, window: extraLine(label, openWindow(used, sample.resetsAt)) });
  }
  return rows;
}

function durationLabel(seconds: number): string {
  if (seconds >= 86400) return `${Math.max(1, Math.round(seconds / 86400))}-day`;
  if (seconds >= 3600) return `${Math.max(1, Math.round(seconds / 3600))}-hour`;
  return `${Math.max(1, Math.round(seconds / 60))}-minute`;
}

function assignDurationWindows(windows: DurationWindow[]): PlanWindows {
  let fiveHour = closedWindow();
  let weekly = closedWindow();
  const extra: PlanExtra[] = [];
  for (const window of windows) {
    const open = openWindow(window.used, window.resetsAt);
    const fiveHourSlot = window.seconds >= FIVE_HOUR_MIN_SECONDS && window.seconds <= FIVE_HOUR_MAX_SECONDS;
    const weeklySlot = window.seconds >= WEEK_MIN_SECONDS && window.seconds <= WEEK_MAX_SECONDS;
    if (fiveHourSlot && !fiveHour.available) fiveHour = open;
    else if (weeklySlot && !weekly.available) weekly = open;
    else extra.push(extraLine(durationLabel(window.seconds), open));
  }
  return { plan: null, fiveHour, weekly, extra, models: [] };
}

type GrokSlot = "fiveHour" | "weekly" | "monthly" | "other";

interface GrokSample {
  used: number;
  slot: GrokSlot;
  resetsAt: string | null;
  seconds: number | null;
}

function classifyGrok(typeValue: unknown, seconds: number | null): GrokSlot {
  const type = typeof typeValue === "string" ? typeValue.toUpperCase() : "";
  if (type.includes("WEEK")) return "weekly";
  if (type.includes("MONTH")) return "monthly";
  if (/(^|[^A-Z0-9])(5|FIVE)[^A-Z0-9]*HOUR/.test(type)) return "fiveHour";
  if (seconds == null) return "other";
  if (seconds >= FIVE_HOUR_MIN_SECONDS && seconds <= FIVE_HOUR_MAX_SECONDS) return "fiveHour";
  if (seconds >= WEEK_MIN_SECONDS && seconds <= WEEK_MAX_SECONDS) return "weekly";
  if (seconds >= MONTH_MIN_SECONDS && seconds <= MONTH_MAX_SECONDS) return "monthly";
  return "other";
}

function readGrokSample(body: unknown, zeroWhenPeriodPresent: boolean): GrokSample | null {
  const root = asRecord(body);
  if (!root) return null;
  const config = asRecord(root.config) ?? root;
  const period = asRecord(config.currentPeriod);
  let used = numericValue(config.creditUsagePercent);
  if (used == null) {
    const cap = numericValue(asRecord(config.onDemandCap)?.val ?? config.onDemandCap);
    const spent = numericValue(asRecord(config.onDemandUsed)?.val ?? config.onDemandUsed);
    if (cap != null && spent != null && cap > 0) used = (spent / cap) * 100;
  }
  if (used == null && zeroWhenPeriodPresent && period) used = 0;
  if (used == null) return null;
  const type = period?.type ?? period?.period ?? config.period ?? config.interval;
  const start = period?.start ?? period?.periodStart;
  const end = period?.end ?? period?.periodEnd ?? config.billingPeriodEnd ?? root.billingPeriodEnd;
  const startMs = timeMs(start);
  const endMs = timeMs(end);
  const seconds = startMs != null && endMs != null && endMs > startMs ? (endMs - startMs) / 1000 : null;
  return { used, slot: classifyGrok(type, seconds), resetsAt: isoOrNull(end), seconds };
}

function grokPlan(settings: unknown): string | null {
  const root = asRecord(settings);
  if (!root) return null;
  const nested = asRecord(root.settings);
  return planLabel(nested?.subscription_tier_display ?? root.subscription_tier_display);
}

function planUsageCacheKey(accounts: PlanAccount[]): string {
  return accounts.map((account) => {
    const environment = Object.entries(account.environment)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join("\n");
    return [account.id, account.driver, account.name, account.configDir ?? "", environment].join("\u0000");
  }).join("\n");
}

function claudeCredentialFromText(text: string | null, now: number, store?: ClaudeRenewalTarget): PlanCredential {
  const oauth = asRecord(asRecord(parseJson(text))?.claudeAiOauth);
  const token = secretString(oauth?.accessToken);
  if (!token) return missingCredential();
  const refreshToken = secretString(oauth?.refreshToken);
  const planHint = claudePlanName(oauth?.subscriptionType, oauth?.rateLimitTier);
  const expiry = timeMs(oauth?.expiresAt);
  if (expiry != null && expiry <= now) {
    if (refreshToken && store) {
      return { token, accountId: null, expired: true, refreshToken, planHint, store };
    }
    return expiredCredential();
  }
  return { token, accountId: null, expired: false, refreshToken, planHint, store };
}

function claudeKeychainServices(account: PlanAccount, env: NodeJS.ProcessEnv, resolvedDir: string): string[] {
  const written = account.configDir?.trim() || env.CLAUDE_CONFIG_DIR?.trim() || "";
  if (!written) return [CLAUDE_KEYCHAIN_SERVICE];
  let defaultDir: string | null = null;
  try {
    const withoutConfig = { ...env };
    delete withoutConfig.CLAUDE_CONFIG_DIR;
    defaultDir = resolveClaudeConfigDir(undefined, withoutConfig);
  } catch {
    defaultDir = null;
  }
  if (defaultDir != null && resolvedDir === defaultDir) return [CLAUDE_KEYCHAIN_SERVICE];
  const spellings = [resolvedDir];
  if (written !== resolvedDir) spellings.push(written);
  const seen = new Set<string>();
  const services: string[] = [];
  for (const spelling of spellings) {
    const suffix = createHash("sha256").update(spelling).digest("hex").slice(0, 8);
    const service = `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
    if (seen.has(service)) continue;
    seen.add(service);
    services.push(service);
  }
  return services;
}

async function readClaudeCredential(
  account: PlanAccount,
  env: NodeJS.ProcessEnv,
  source: CredentialSource,
  now: number,
): Promise<PlanCredential> {
  let resolvedDir: string;
  try {
    resolvedDir = resolveClaudeConfigDir(account.configDir, env);
  } catch {
    return missingCredential();
  }
  const filePath = join(resolvedDir, ".credentials.json");
  const fileStore: ClaudeRenewalTarget | undefined = source.writable
    ? { kind: "claude-file", folder: resolvedDir, filePath }
    : undefined;
  const file = claudeCredentialFromText(source.readText(filePath), now, fileStore);
  if (file.token && !file.expired) return file;
  if (!source.readClaudeKeychain && !source.readClaudeKeychainWithAccount) return file;

  let sawExpired: PlanCredential | null = file.expired ? file : null;
  const user = env.USER?.trim() || undefined;
  for (const service of claudeKeychainServices(account, env, resolvedDir)) {
    let raw: string | null = null;
    let matchedAccount: string | undefined;
    try {
      if (source.readClaudeKeychainWithAccount) {
        const result = await source.readClaudeKeychainWithAccount(service, user);
        raw = result.raw;
        matchedAccount = result.account;
      } else if (source.readClaudeKeychain) {
        raw = (await source.readClaudeKeychain(service)) ?? null;
      }
    } catch {
      raw = null;
    }
    const keychainStore: ClaudeRenewalTarget | undefined = source.writable && matchedAccount
      ? { kind: "claude-keychain", folder: resolvedDir, service, account: matchedAccount }
      : undefined;
    const parsed = claudeCredentialFromText(decodeKeychainSecret(raw), now, keychainStore);
    if (parsed.token && !parsed.expired) return parsed;
    if (parsed.expired && (!sawExpired || (!sawExpired.refreshToken && parsed.refreshToken))) {
      sawExpired = parsed;
    }
  }
  return sawExpired ?? missingCredential();
}

function codexCredentialFromRecord(
  root: Record<string, unknown> | null,
  now: number,
  store?: CodexRenewalTarget,
): PlanCredential {
  if (!root) return missingCredential();
  const tokens = asRecord(root.tokens);
  const token = secretString(tokens?.access_token) ?? secretString(root.access_token);
  if (!token) return missingCredential();
  const refreshToken = secretString(tokens?.refresh_token) ?? secretString(root.refresh_token);
  const accountId = secretString(tokens?.account_id) ?? secretString(root.account_id) ?? codexJwtAccountId(token);
  const expiry = timeMs(tokens?.expires_at ?? tokens?.expiresAt ?? root.expires_at ?? root.expiresAt) ?? jwtExpiryMs(token);
  if (expiry != null && expiry <= now) {
    if (refreshToken && store) return { token, accountId, expired: true, refreshToken, store };
    return expiredCredential();
  }
  return { token, accountId, expired: false, refreshToken, store };
}

async function readCodexCredential(
  env: NodeJS.ProcessEnv,
  source: CredentialSource,
  now: number,
): Promise<PlanCredential> {
  const home = codexHome(env);
  if (!home) return missingCredential();
  const filePath = join(home, "auth.json");
  const fileStore: CodexRenewalTarget | undefined = source.writable
    ? { kind: "codex-file", home, filePath }
    : undefined;
  const fromFile = codexCredentialFromRecord(asRecord(parseJson(source.readText(filePath))), now, fileStore);
  if (fromFile.token || fromFile.expired) return fromFile;
  if (!source.readCodexKeychain) return missingCredential();
  if (!codexUsesKeyring(source.readText(join(home, "config.toml")))) return missingCredential();
  const item = codexKeychainItem(home);
  let raw: string | null = null;
  try {
    raw = (await source.readCodexKeychain(item.service, item.account)) ?? null;
  } catch {
    raw = null;
  }
  return codexCredentialFromRecord(asRecord(parseJson(decodeKeychainSecret(raw))), now);
}

interface GrokCandidate {
  token: string;
  refreshToken: string | null;
  expiresAt: number | null;
  entryKey: string | null;
}

function grokCandidate(record: Record<string, unknown>, entryKey: string | null): GrokCandidate | null {
  const token = secretString(record.access_token) ?? secretString(record.key);
  if (!token) return null;
  const refreshToken = secretString(record.refresh_token) ?? secretString(record.refresh);
  const expiresAt = timeMs(record.expires_at ?? record.expiresAt ?? record.expires) ?? jwtExpiryMs(token);
  return { token, refreshToken, expiresAt, entryKey };
}

function readGrokCredential(
  env: NodeJS.ProcessEnv,
  source: CredentialSource,
  now: number,
): PlanCredential {
  const rootDir = env.GROK_HOME?.trim() || harnessHome("grok", env);
  const filePath = join(rootDir, "auth.json");
  const root = asRecord(parseJson(source.readText(filePath)));
  if (!root) return missingCredential();
  const makeStore = (entryKey: string | null): GrokRenewalTarget | undefined =>
    source.writable ? { kind: "grok-file", folder: rootDir, filePath, entryKey } : undefined;
  const direct = grokCandidate(root, null);
  if (direct) {
    const store = makeStore(null);
    if (direct.expiresAt != null && direct.expiresAt <= now) {
      if (direct.refreshToken && store) {
        return { token: direct.token, accountId: null, expired: true, refreshToken: direct.refreshToken, store };
      }
      return expiredCredential();
    }
    return { token: direct.token, accountId: null, expired: false, refreshToken: direct.refreshToken, store };
  }
  let best: GrokCandidate | null = null;
  let bestExpired: GrokCandidate | null = null;
  for (const [key, value] of Object.entries(root)) {
    const record = asRecord(value);
    if (!record) continue;
    const candidate = grokCandidate(record, key);
    if (!candidate) continue;
    if (candidate.expiresAt != null && candidate.expiresAt <= now) {
      if (
        !bestExpired ||
        (!bestExpired.refreshToken && candidate.refreshToken) ||
        (Boolean(bestExpired.refreshToken) === Boolean(candidate.refreshToken) &&
          (candidate.expiresAt ?? Number.NEGATIVE_INFINITY) >= (bestExpired.expiresAt ?? Number.NEGATIVE_INFINITY))
      ) {
        bestExpired = candidate;
      }
      continue;
    }
    const bestStamp = best?.expiresAt ?? Number.NEGATIVE_INFINITY;
    const stamp = candidate.expiresAt ?? Number.NEGATIVE_INFINITY;
    if (!best || stamp >= bestStamp) best = candidate;
  }
  if (best) {
    return {
      token: best.token,
      accountId: null,
      expired: false,
      refreshToken: best.refreshToken,
      store: makeStore(best.entryKey),
    };
  }
  if (bestExpired) {
    const store = makeStore(bestExpired.entryKey);
    if (bestExpired.refreshToken && store) {
      return { token: bestExpired.token, accountId: null, expired: true, refreshToken: bestExpired.refreshToken, store };
    }
    return expiredCredential();
  }
  return missingCredential();
}

function parseAntigravityTokenFile(raw: string | null, now: number): PlanCredential {
  if (!raw) return missingCredential();
  let text = raw.trim();
  if (!text) return missingCredential();
  if (text.startsWith("go-keyring-base64:")) {
    try {
      text = Buffer.from(text.slice("go-keyring-base64:".length), "base64").toString("utf8").trim();
    } catch {
      return missingCredential();
    }
  }
  const parsed = asRecord(parseJson(text));
  if (!parsed) return missingCredential();
  const tokenObj = asRecord(parsed.token) ?? parsed;
  const token = secretString(tokenObj.access_token);
  const refreshToken = secretString(tokenObj.refresh_token) ?? secretString(parsed.refresh_token);
  if (!token && !refreshToken) return missingCredential();
  const clientId = secretString(parsed.client_id) ?? undefined;
  const clientSecret = secretString(parsed.client_secret) ?? undefined;
  const store: AntigravityRenewalTarget = {
    kind: "antigravity-memory",
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
  };
  const expiry = timeMs(tokenObj.expiry ?? tokenObj.expires_at ?? tokenObj.expiresAt);
  const expired = !token || (expiry != null && expiry <= now + 60_000);
  if (expired && !refreshToken) return expiredCredential();
  return { token, accountId: null, expired, refreshToken, store };
}

function readAntigravityCredential(
  account: PlanAccount,
  _env: NodeJS.ProcessEnv,
  source: CredentialSource,
  now: number,
  dataDir: string,
): PlanCredential {
  // Antigravity strips inherited host GEMINI_HOME; only an instance's own environment overrides its Dusk profile dir.
  const customHome = account.environment.GEMINI_HOME?.trim();
  const paths = customHome
    ? [
        join(customHome, ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_CLI_TOKEN_FILE),
        join(customHome, ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_LEGACY_TOKEN_FILE),
        join(customHome, "jetski-standalone-oauth-token"),
      ]
    : [
        join(antigravityProfileDirectory(account.id, dataDir), ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_CLI_TOKEN_FILE),
        join(antigravityProfileDirectory(account.id, dataDir), ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_LEGACY_TOKEN_FILE),
      ];
  let sawExpired: PlanCredential | null = null;
  for (const path of paths) {
    const parsed = parseAntigravityTokenFile(source.readText(path), now);
    if ((parsed.token && !parsed.expired) || parsed.refreshToken) return parsed;
    if (parsed.expired && !sawExpired) sawExpired = parsed;
  }
  return sawExpired ?? missingCredential();
}

function formatCursorMembership(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/^unified_/i, "");
  return cleaned ? planLabel(titleWords(cleaned)) : null;
}

function cursorStateDbPath(env: NodeJS.ProcessEnv): string {
  const home = userHome(env);
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  if (process.platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "Cursor", "User", "globalStorage", "state.vscdb");
}

function cursorCredentialFromTokens(
  access: string | null,
  refresh: string | null,
  now: number,
  options: { planHint?: string | null; store?: CursorRenewalTarget } = {},
): PlanCredential {
  const token = access ?? refresh;
  if (!token) return missingCredential();
  const expiry = jwtExpiryMs(token);
  const expired = expiry != null && expiry <= now;
  const effectiveRefresh = refresh ?? access;
  if (expired && !(effectiveRefresh && options.store)) return expiredCredential();
  return {
    token,
    accountId: jwtSubject(token),
    expired,
    refreshToken: effectiveRefresh,
    planHint: options.planHint ?? null,
    store: options.store,
  };
}

function cursorCredentialFromFile(filePath: string, source: CredentialSource, now: number): PlanCredential {
  const doc = asRecord(parseJson(source.readText(filePath)));
  if (!doc) return missingCredential();
  const access = secretString(doc.accessToken) ?? secretString(doc.access_token);
  const refresh = secretString(doc.refreshToken) ?? secretString(doc.refresh_token);
  const store: CursorRenewalTarget | undefined = source.writable ? { kind: "cursor-file", filePath } : undefined;
  return cursorCredentialFromTokens(access, refresh, now, { store });
}

async function readCursorCredential(
  env: NodeJS.ProcessEnv,
  source: CredentialSource,
  now: number,
): Promise<PlanCredential> {
  const envToken = secretString(env.CURSOR_AUTH_TOKEN);
  if (envToken) return cursorCredentialFromTokens(envToken, null, now);

  const customDir = env.CURSOR_CONFIG_DIR?.trim();
  if (customDir) {
    return cursorCredentialFromFile(join(customDir, "auth.json"), source, now);
  }

  const home = userHome(env);
  const xdgConfig = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  const filePaths = [join(home, ".cursor", "auth.json"), join(xdgConfig, "cursor", "auth.json")];
  let sawExpired: PlanCredential | null = null;
  for (const filePath of filePaths) {
    const parsed = cursorCredentialFromFile(filePath, source, now);
    if ((parsed.token && !parsed.expired) || (parsed.expired && parsed.refreshToken && parsed.store)) return parsed;
    if (parsed.expired && !sawExpired) sawExpired = parsed;
  }

  if (source.readCursorKeychain) {
    try {
      const kc = await source.readCursorKeychain();
      const parsed = cursorCredentialFromTokens(kc.accessToken, kc.refreshToken, now);
      if (parsed.token && !parsed.expired) return parsed;
      if (parsed.expired && !sawExpired) sawExpired = parsed;
    } catch {}
  }

  if (source.readCursorIdeDb) {
    try {
      const ide = source.readCursorIdeDb(cursorStateDbPath(env));
      if (ide) {
        const parsed = cursorCredentialFromTokens(ide.accessToken, ide.refreshToken, now, {
          planHint: formatCursorMembership(ide.membership),
        });
        if (parsed.token && !parsed.expired) return parsed;
        if (parsed.expired && !sawExpired) sawExpired = parsed;
      }
    } catch {}
  }

  return sawExpired ?? missingCredential();
}

function openCodeDataDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const roots = [
    env.XDG_DATA_HOME || join(home, ".local", "share"),
    process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? env.LOCALAPPDATA || join(home, "AppData", "Local")
        : "",
  ].filter(Boolean);
  return [...new Set(roots)].map((root) => join(root, "opencode"));
}

function openCodeGoKeyFromJson(text: string | null): string | null {
  const parsed = asRecord(parseJson(text));
  const entry = asRecord(parsed?.["opencode-go"]);
  return secretString(entry?.key);
}

function readOpenCodeCredential(env: NodeJS.ProcessEnv, source: CredentialSource): PlanCredential {
  const dirs = openCodeDataDirs(env);
  if (source.readOpenCodeDbKey) {
    for (const dir of dirs) {
      try {
        const key = secretString(source.readOpenCodeDbKey(dir));
        if (key) return { token: key, accountId: null, expired: false };
      } catch {}
    }
  }
  for (const dir of dirs) {
    const key = openCodeGoKeyFromJson(source.readText(join(dir, "auth.json")));
    if (key) return { token: key, accountId: null, expired: false };
  }
  const fromEnv = openCodeGoKeyFromJson(env.OPENCODE_AUTH_CONTENT ?? null);
  if (fromEnv) return { token: fromEnv, accountId: null, expired: false };
  return missingCredential();
}

function errorRow(account: PlanAccount, error: string): PlanProviderRow {
  return {
    id: account.id,
    name: account.name,
    driver: account.driver,
    plan: null,
    ok: false,
    error,
    fiveHour: closedWindow(),
    weekly: closedWindow(),
    extra: [],
    models: [],
  };
}

function okRow(account: PlanAccount, windows: PlanWindows): PlanProviderRow {
  return {
    id: account.id,
    name: account.name,
    driver: account.driver,
    plan: windows.plan,
    ok: true,
    error: null,
    fiveHour: windows.fiveHour,
    weekly: windows.weekly,
    extra: windows.extra,
    models: windows.models,
  };
}

function rowHasAnyWindow(row: PlanProviderRow): boolean {
  return row.fiveHour.available || row.weekly.available || row.extra.length > 0 || row.models.length > 0;
}

function pruneExpiredWindow(window: PlanWindow, now: number): PlanWindow {
  if (!window.available || !window.resetsAt) return window;
  const resetMs = Date.parse(window.resetsAt);
  return Number.isFinite(resetMs) && resetMs <= now ? closedWindow() : window;
}

function pruneLastGoodRow(row: PlanProviderRow, account: PlanAccount, now: number): PlanProviderRow | null {
  const fiveHour = pruneExpiredWindow(row.fiveHour, now);
  const weekly = pruneExpiredWindow(row.weekly, now);
  const extra = row.extra.filter((entry) => {
    if (!entry.resetsAt) return true;
    const resetMs = Date.parse(entry.resetsAt);
    return !Number.isFinite(resetMs) || resetMs > now;
  });
  const models = row.models
    .map((model) => ({
      name: model.name,
      windows: model.windows.filter((entry) => {
        if (!entry.resetsAt) return true;
        const resetMs = Date.parse(entry.resetsAt);
        return !Number.isFinite(resetMs) || resetMs > now;
      }),
    }))
    .filter((model) => model.windows.length > 0);
  const next: PlanProviderRow = { ...row, id: account.id, name: account.name, fiveHour, weekly, extra, models };
  return rowHasAnyWindow(next) ? next : null;
}

function parseRetryAfterMs(headers: PlanHttpResponse["headers"], now: number): number | null {
  const raw = headers?.get("retry-after")?.trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : null;
}

function recordRateLimit(loginKey: string, retryAfterMs: number | null, now: number): void {
  const prev = rateLimitCooldowns.get(loginKey);
  const streak = (prev?.streak ?? 0) + 1;
  const backoff = Math.min(RATE_LIMIT_DEFAULT_MS * 2 ** (streak - 1), RATE_LIMIT_MAX_MS);
  const waitMs = Math.max(retryAfterMs ?? backoff, RATE_LIMIT_MIN_MS);
  rateLimitCooldowns.set(loginKey, { until: now + waitMs, streak });
}

interface ProviderOutcome {
  row: PlanProviderRow;
  kind: "ok" | "auth" | "rate_limit" | "transient" | "other";
  retryAfterMs?: number | null;
}

async function tryRenewCredential(
  credential: PlanCredential,
  turnedAway: boolean,
  deps: PlanUsageDeps,
): Promise<{ status: "renewed"; token: string } | { status: "rejected" } | { status: "unchanged" }> {
  const store = credential.store;
  const timeoutMs = deps.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  if (!store) return { status: "unchanged" };
  if (store.kind === "antigravity-memory") {
    if (!credential.refreshToken) return { status: "unchanged" };
    return renewAntigravityToken({
      refreshToken: credential.refreshToken,
      target: store,
      force: turnedAway,
      fetch: deps.fetch,
      now: deps.now,
      timeoutMs,
    });
  }
  if (!credential.token || !credential.refreshToken) return { status: "unchanged" };
  if (store.kind === "claude-file" || store.kind === "claude-keychain") {
    return renewClaudeToken({
      target: store,
      token: credential.token,
      turnedAway,
      fetch: deps.fetch,
      now: deps.now,
      timeoutMs,
    });
  }
  if (store.kind === "codex-file") {
    return renewCodexToken({
      target: store,
      token: credential.token,
      turnedAway,
      fetch: deps.fetch,
      now: deps.now,
      timeoutMs,
    });
  }
  if (store.kind === "grok-file") {
    return renewGrokToken({
      target: store,
      token: credential.token,
      turnedAway,
      fetch: deps.fetch,
      now: deps.now,
      timeoutMs,
    });
  }
  if (store.kind === "cursor-file") {
    return renewCursorToken({
      target: store,
      token: credential.token,
      turnedAway,
      fetch: deps.fetch,
      now: deps.now,
      timeoutMs,
    });
  }
  return { status: "unchanged" };
}

/** Accounts on one sign-in (two Claude engines on the same login) share one read: Claude's usage endpoint answers 429 to
 * a second read made at once. */
async function fetchProvider(
  account: PlanAccount,
  deps: PlanUsageDeps,
  sameLogin: Map<string, Promise<PlanProviderRow | null>>,
): Promise<PlanProviderRow | null> {
  const now = deps.now?.() ?? Date.now();
  let credential: PlanCredential;
  try {
    credential = await deps.credentials.read(account);
  } catch {
    return errorRow(account, signInAgain(account.driver));
  }
  // OpenCode's default fleet instance is the free Zen backup when no OpenCode Go subscription key is stored.
  if (account.driver === "opencode" && !credential.token && !credential.expired) return null;

  const loginSeed = credential.refreshToken || credential.token;
  if (!loginSeed) return errorRow(account, signInAgain(account.driver));

  const loginKey = createHash("sha256")
    .update(`${account.driver}\0${credential.accountId ?? ""}\0${loginSeed}`)
    .digest("hex");

  let read = sameLogin.get(loginKey);
  if (!read) {
    read = fetchProviderForLogin(account, credential, loginKey, now, deps);
    sameLogin.set(loginKey, read);
  }
  const result = await read;
  return result ? { ...result, id: account.id, name: account.name } : null;
}

async function fetchProviderForLogin(
  account: PlanAccount,
  credential: PlanCredential,
  loginKey: string,
  now: number,
  deps: PlanUsageDeps,
): Promise<PlanProviderRow> {
  const cooldown = rateLimitCooldowns.get(loginKey);
  if (cooldown && cooldown.until > now) {
    const cached = lastGoodRows.get(loginKey);
    const pruned = cached ? pruneLastGoodRow(cached, account, now) : null;
    return pruned ?? errorRow(account, rateLimitedError(account.driver));
  }

  let token = credential.token;
  const needsProactiveRenewal =
    credential.expired ||
    !token ||
    (account.driver === "cursor" && credential.store?.kind === "cursor-file" && cursorRenewalDue(token, now));

  if (needsProactiveRenewal && credential.refreshToken && credential.store) {
    const renewed = await tryRenewCredential(credential, false, deps);
    if (renewed.status === "renewed") {
      token = renewed.token;
    } else if (renewed.status === "rejected") {
      lastGoodRows.delete(loginKey);
      rateLimitCooldowns.delete(loginKey);
      return errorRow(account, signInAgain(account.driver));
    } else if (credential.expired || !token) {
      // Transient failure while renewing an expired token: fall back to last-good if still current, else sign in.
      const cached = lastGoodRows.get(loginKey);
      const pruned = cached ? pruneLastGoodRow(cached, account, now) : null;
      return pruned ?? errorRow(account, account.driver === "antigravity" ? couldNotReach("antigravity") : signInAgain(account.driver));
    }
  } else if (credential.expired || !token) {
    lastGoodRows.delete(loginKey);
    rateLimitCooldowns.delete(loginKey);
    return errorRow(account, signInAgain(account.driver));
  }

  let outcome = await fetchSignedIn(account, { ...credential, token }, now, deps);
  if (outcome.kind === "auth" && credential.refreshToken && credential.store) {
    const renewed = await tryRenewCredential({ ...credential, token }, true, deps);
    if (renewed.status === "renewed" && renewed.token !== token) {
      outcome = await fetchSignedIn(account, { ...credential, token: renewed.token }, now, deps);
    }
  }

  if (outcome.kind === "ok") {
    rateLimitCooldowns.delete(loginKey);
    lastGoodRows.set(loginKey, outcome.row);
    return outcome.row;
  }
  if (outcome.kind === "auth") {
    rateLimitCooldowns.delete(loginKey);
    lastGoodRows.delete(loginKey);
    return outcome.row;
  }
  if (outcome.kind === "rate_limit") {
    recordRateLimit(loginKey, outcome.retryAfterMs ?? null, now);
    const cached = lastGoodRows.get(loginKey);
    const pruned = cached ? pruneLastGoodRow(cached, account, now) : null;
    return pruned ?? outcome.row;
  }
  if (outcome.kind === "transient") {
    const cached = lastGoodRows.get(loginKey);
    const pruned = cached ? pruneLastGoodRow(cached, account, now) : null;
    return pruned ?? outcome.row;
  }
  return outcome.row;
}

async function fetchSignedIn(
  account: PlanAccount,
  credential: PlanCredential & { token: string },
  now: number,
  deps: PlanUsageDeps,
): Promise<ProviderOutcome> {
  try {
    if (account.driver === "claude") return await fetchClaude(account, credential.token, credential.planHint ?? null, now, deps);
    if (account.driver === "codex") return await fetchCodex(account, credential.token, credential.accountId, now, deps);
    if (account.driver === "grok") return await fetchGrok(account, credential.token, now, deps);
    if (account.driver === "antigravity") return await fetchAntigravity(account, credential.token, now, deps);
    if (account.driver === "cursor") return await fetchCursor(account, credential.token, credential.planHint ?? null, now, deps);
    return await fetchOpenCode(account, credential.token, now, deps);
  } catch {
    return { kind: "transient", row: errorRow(account, couldNotReach(account.driver)) };
  }
}

interface HttpResult {
  status: number;
  ok: boolean;
  body: unknown;
  text: string;
  retryAfterMs: number | null;
}

async function fetchJson(
  fetchImpl: PlanFetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  options: { method?: string; body?: string; now?: number } = {},
): Promise<HttpResult> {
  try {
    const init: PlanFetchInit = {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      ...(options.method ? { method: options.method } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
    };
    const response = await fetchImpl(url, init);
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    let body: unknown = null;
    if (text.trim()) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
    }
    return {
      status: response.status,
      ok: response.ok,
      body,
      text,
      retryAfterMs: parseRetryAfterMs(response.headers, options.now ?? Date.now()),
    };
  } catch {
    return { status: 0, ok: false, body: null, text: "", retryAfterMs: null };
  }
}

function authRejected(status: number): boolean {
  return status === 401 || status === 403;
}

async function fetchClaude(
  account: PlanAccount,
  token: string,
  planHint: string | null,
  now: number,
  deps: PlanUsageDeps,
): Promise<ProviderOutcome> {
  const result = await fetchJson(deps.fetch, CLAUDE_USAGE_URL, {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": CLAUDE_USER_AGENT,
  }, deps.timeoutMs ?? PROVIDER_TIMEOUT_MS, { now });
  if (authRejected(result.status)) return { kind: "auth", row: errorRow(account, signInAgain("claude")) };
  if (result.status === 429) {
    return { kind: "rate_limit", retryAfterMs: result.retryAfterMs, row: errorRow(account, rateLimitedError("claude")) };
  }
  if (!result.ok || result.body === null || typeof result.body !== "object") {
    const transient = result.status === 0 || result.status >= 500;
    return { kind: transient ? "transient" : "other", row: errorRow(account, transient ? couldNotReach("claude") : unexpectedUsage("claude")) };
  }
  return { kind: "ok", row: okRow(account, parseClaudeUsage(result.body, planHint)) };
}

async function fetchCodex(
  account: PlanAccount,
  token: string,
  accountId: string | null,
  now: number,
  deps: PlanUsageDeps,
): Promise<ProviderOutcome> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  const result = await fetchJson(deps.fetch, CODEX_USAGE_URL, headers, deps.timeoutMs ?? PROVIDER_TIMEOUT_MS, { now });
  if (authRejected(result.status)) return { kind: "auth", row: errorRow(account, signInAgain("codex")) };
  if (result.status === 429) {
    return { kind: "rate_limit", retryAfterMs: result.retryAfterMs, row: errorRow(account, rateLimitedError("codex")) };
  }
  if (!result.ok || result.body === null || typeof result.body !== "object") {
    const transient = result.status === 0 || result.status >= 500;
    return { kind: transient ? "transient" : "other", row: errorRow(account, transient ? couldNotReach("codex") : unexpectedUsage("codex")) };
  }
  return { kind: "ok", row: okRow(account, parseCodexUsage(result.body, now)) };
}

async function fetchGrok(
  account: PlanAccount,
  token: string,
  now: number,
  deps: PlanUsageDeps,
): Promise<ProviderOutcome> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "X-XAI-Token-Auth": "xai-grok-cli",
  };
  const timeout = deps.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const [credits, billing, settings] = await Promise.all([
    fetchJson(deps.fetch, GROK_CREDITS_URL, headers, timeout, { now }),
    fetchJson(deps.fetch, GROK_BILLING_URL, headers, timeout, { now }),
    fetchJson(deps.fetch, GROK_SETTINGS_URL, headers, timeout, { now }),
  ]);
  if (authRejected(credits.status) || (authRejected(billing.status) && !credits.ok)) {
    return { kind: "auth", row: errorRow(account, signInAgain("grok")) };
  }
  if (credits.status === 429 && !billing.ok) {
    return { kind: "rate_limit", retryAfterMs: credits.retryAfterMs, row: errorRow(account, rateLimitedError("grok")) };
  }
  const creditsBody = credits.ok ? credits.body : null;
  const billingBody = billing.ok && !authRejected(billing.status) ? billing.body : null;
  if (creditsBody === null && billingBody === null) {
    const transient = credits.status === 0 || credits.status >= 500 || billing.status === 0 || billing.status >= 500;
    return { kind: transient ? "transient" : "other", row: errorRow(account, transient ? couldNotReach("grok") : unexpectedUsage("grok")) };
  }
  const windows = parseGrokUsage(creditsBody, billingBody ?? undefined, settings.ok ? settings.body : undefined);
  return { kind: "ok", row: okRow(account, windows) };
}

function recordAntigravityWeeklyResets(modelsNode: unknown, now: number): void {
  for (const stamp of antigravityWeeklyResets) {
    if (stamp <= now) antigravityWeeklyResets.delete(stamp);
  }
  const record = asRecord(modelsNode);
  if (!record) return;
  for (const [key, rawModel] of Object.entries(record)) {
    const model = asRecord(rawModel);
    if (!model || model.isInternal === true) continue;
    const name = typeof model.displayName === "string" ? model.displayName : typeof model.label === "string" ? model.label : "";
    if (!name || name.toLowerCase().includes("argon") || key.toLowerCase().includes("argon")) continue;
    const resetMs = timeMs(asRecord(model.quotaInfo)?.resetTime);
    if (resetMs != null && resetMs - now > 5 * 3600_000 + 600_000) antigravityWeeklyResets.add(resetMs);
  }
}

async function fetchAntigravityPlan(
  token: string,
  headers: Record<string, string>,
  timeoutMs: number,
  deps: PlanUsageDeps,
): Promise<string | null> {
  const tokenHash = createHash("sha256").update(token).digest("hex").slice(0, 16);
  const cached = antigravityPlanCache.get(tokenHash);
  if (cached) return cached;
  const body = JSON.stringify({
    metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
  });
  for (const host of ANTIGRAVITY_HOSTS) {
    const result = await fetchJson(deps.fetch, `${host}/v1internal:loadCodeAssist`, headers, timeoutMs, {
      method: "POST",
      body,
    });
    if (!result.ok) continue;
    const plan = parseAntigravityPlan(result.body);
    if (plan) {
      antigravityPlanCache.set(tokenHash, plan);
      return plan;
    }
  }
  return null;
}

function antigravityHasUsage(windows: PlanWindows): boolean {
  return (windows.fiveHour.available && (windows.fiveHour.usedPercent ?? 0) > 0) ||
    (windows.weekly.available && (windows.weekly.usedPercent ?? 0) > 0) ||
    windows.models.some((model) => model.windows.some((entry) => entry.usedPercent > 0));
}

async function fetchAntigravity(
  account: PlanAccount,
  token: string,
  now: number,
  deps: PlanUsageDeps,
): Promise<ProviderOutcome> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": antigravityUserAgent(),
  };
  const timeout = deps.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const summaryResponses = await Promise.all(
    ANTIGRAVITY_HOSTS.map((host) =>
      fetchJson(deps.fetch, `${host}/v1internal:retrieveUserQuotaSummary`, headers, timeout, {
        method: "POST",
        body: "{}",
        now,
      })),
  );
  const summaryBodies: unknown[] = [];
  let rejected = false;
  let rateLimited: HttpResult | null = null;
  for (const response of summaryResponses) {
    const groups = asRecord(response.body)?.groups;
    if (response.ok && Array.isArray(groups) && groups.length > 0) summaryBodies.push(response.body);
    else if (response.status === 401) rejected = true;
    else if (response.status === 429) rateLimited = response;
  }
  const fromSummary = parseAntigravitySummary(summaryBodies);
  if (fromSummary) {
    const plan = await fetchAntigravityPlan(token, headers, timeout, deps);
    return { kind: "ok", row: okRow(account, { ...fromSummary, plan }) };
  }
  if (rejected) return { kind: "auth", row: errorRow(account, signInAgain("antigravity")) };

  let fallback: PlanWindows | null = null;
  for (const host of ANTIGRAVITY_HOSTS) {
    const response = await fetchJson(deps.fetch, `${host}/v1internal:fetchAvailableModels`, headers, timeout, {
      method: "POST",
      body: "{}",
      now,
    });
    if (response.ok) {
      const modelsNode = asRecord(response.body)?.models;
      if (!modelsNode) continue;
      recordAntigravityWeeklyResets(modelsNode, now);
      const parsed = parseAntigravityModels(modelsNode, now, antigravityWeeklyResets);
      if (!parsed) continue;
      if (antigravityHasUsage(parsed)) {
        const plan = await fetchAntigravityPlan(token, headers, timeout, deps);
        return { kind: "ok", row: okRow(account, { ...parsed, plan }) };
      }
      if (!fallback) fallback = parsed;
    } else if (authRejected(response.status)) {
      rejected = true;
    } else if (response.status === 429) {
      rateLimited = response;
    }
  }
  if (fallback) {
    const plan = await fetchAntigravityPlan(token, headers, timeout, deps);
    return { kind: "ok", row: okRow(account, { ...fallback, plan }) };
  }
  if (rejected) return { kind: "auth", row: errorRow(account, signInAgain("antigravity")) };
  if (rateLimited) {
    return { kind: "rate_limit", retryAfterMs: rateLimited.retryAfterMs, row: errorRow(account, rateLimitedError("antigravity")) };
  }
  return { kind: "transient", row: errorRow(account, couldNotReach("antigravity")) };
}

function cursorDashboardSession(token: string): { user: string; cookie: string } {
  const sub = jwtSubject(token) ?? "";
  const user = sub.includes("|") ? (sub.split("|").pop() ?? "") : sub;
  return { user, cookie: `WorkosCursorSessionToken=${user}%3A%3A${token}` };
}

async function fetchCursor(
  account: PlanAccount,
  token: string,
  planHint: string | null,
  now: number,
  deps: PlanUsageDeps,
): Promise<ProviderOutcome> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
  };
  const timeout = deps.timeoutMs ?? CURSOR_TIMEOUT_MS;
  const [planResponse, usageResponse] = await Promise.all([
    fetchJson(deps.fetch, `${CURSOR_API_BASE}GetPlanInfo`, headers, timeout, { method: "POST", body: "{}", now }),
    fetchJson(deps.fetch, `${CURSOR_API_BASE}GetCurrentPeriodUsage`, headers, timeout, { method: "POST", body: "{}", now }),
  ]);

  if (authRejected(usageResponse.status)) return { kind: "auth", row: errorRow(account, signInAgain("cursor")) };
  if (usageResponse.status === 429) {
    return { kind: "rate_limit", retryAfterMs: usageResponse.retryAfterMs, row: errorRow(account, rateLimitedError("cursor")) };
  }
  if (!usageResponse.ok || usageResponse.body === null || typeof usageResponse.body !== "object") {
    const transient = usageResponse.status === 0 || usageResponse.status >= 500;
    return { kind: transient ? "transient" : "other", row: errorRow(account, transient ? couldNotReach("cursor") : unexpectedUsage("cursor")) };
  }

  const subjectKey = createHash("sha256").update(jwtSubject(token) ?? token).digest("hex").slice(0, 16);
  const livePlanInfo = planResponse.ok ? asRecord(asRecord(planResponse.body)?.planInfo) : null;
  if (livePlanInfo) cursorPlanInfoCache.set(subjectKey, livePlanInfo);
  const planInfo = livePlanInfo ?? cursorPlanInfoCache.get(subjectKey) ?? null;

  let windows = parseCursorUsage(usageResponse.body, planInfo, {
    planHint,
    rememberedNow: livePlanInfo ? null : now,
  });

  const hasIncluded = windows.weekly.available || windows.extra.some((entry) => entry.label === "Monthly");
  if (!hasIncluded) {
    // Team and enterprise Cursor plans report included usage on the web dashboard endpoints instead of Connect-RPC.
    const { user, cookie } = cursorDashboardSession(token);
    const cookieHeaders = { Cookie: cookie, Accept: "application/json" };
    const [summary, requests] = await Promise.all([
      fetchJson(deps.fetch, CURSOR_DASHBOARD_SUMMARY_URL, cookieHeaders, timeout, { now }),
      user
        ? fetchJson(deps.fetch, `${CURSOR_DASHBOARD_USAGE_URL}?user=${encodeURIComponent(user)}`, cookieHeaders, timeout, { now })
        : Promise.resolve<HttpResult>({ status: 0, ok: false, body: null, text: "", retryAfterMs: null }),
    ]);
    const dashboard = parseCursorDashboardUsage(summary.ok ? summary.body : null, requests.ok ? requests.body : null);
    if (dashboard.extra.length || dashboard.models.length) {
      const rpcOnDemand = windows.extra.filter((entry) => entry.label === "On-demand");
      const mergedExtra = [
        ...dashboard.extra.filter((entry) => entry.label !== "On-demand"),
        ...(rpcOnDemand.length ? rpcOnDemand : dashboard.extra.filter((entry) => entry.label === "On-demand")),
      ];
      windows = {
        ...windows,
        extra: mergedExtra,
        models: dashboard.models.length ? dashboard.models : windows.models,
      };
    }
  }

  const row = okRow(account, windows);
  if (!rowHasAnyWindow(row)) {
    return { kind: "other", row: errorRow(account, "Cursor did not report included usage for this plan") };
  }
  return { kind: "ok", row };
}

async function fetchOpenCode(
  account: PlanAccount,
  token: string,
  now: number,
  deps: PlanUsageDeps,
): Promise<ProviderOutcome> {
  const result = await fetchJson(deps.fetch, OPENCODE_GO_USAGE_URL, {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  }, deps.timeoutMs ?? PROVIDER_TIMEOUT_MS, { now });
  if (result.status === 401) return { kind: "auth", row: errorRow(account, signInAgain("opencode")) };
  if (result.status === 403) {
    return { kind: "auth", row: errorRow(account, "This OpenCode Go key has no active subscription") };
  }
  if (result.status === 429) {
    return { kind: "rate_limit", retryAfterMs: result.retryAfterMs, row: errorRow(account, rateLimitedError("opencode")) };
  }
  if (!result.ok || result.body === null || typeof result.body !== "object") {
    const transient = result.status === 0 || result.status >= 500;
    return { kind: transient ? "transient" : "other", row: errorRow(account, transient ? couldNotReach("opencode") : unexpectedUsage("opencode")) };
  }
  const windows = parseOpenCodeUsage(result.body, now);
  const row = okRow(account, windows);
  if (!rowHasAnyWindow(row)) return { kind: "other", row: errorRow(account, unexpectedUsage("opencode")) };
  return { kind: "ok", row };
}
