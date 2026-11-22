// Access tokens stay in the request header only, never in the JSON result.
import { createHash } from "node:crypto";

import type { InstanceConfigMap } from "./contracts.ts";
import {
  defaultCredentialReader,
  fileCredentialReader,
} from "./plan-usage-credentials.ts";
import {
  antigravityWeeklyResets,
  parseAntigravityModels,
  parseAntigravityPlan,
  parseAntigravitySummary,
  parseClaudeUsage,
  parseCodexUsage,
  parseCursorDashboardUsage,
  parseCursorUsage,
  parseGrokUsage,
  parseOpenCodeUsage,
} from "./plan-usage-parsers.ts";
import {
  antigravityUserAgent,
  CLAUDE_USER_AGENT,
  clearPlanUsageRenewalState,
  cursorRenewalDue,
  jwtSubject,
  renewAntigravityToken,
  renewClaudeToken,
  renewCodexToken,
  renewCursorToken,
  renewGrokToken,
  type PlanFetchInit,
  type PlanHttpResponse,
} from "./plan-usage-renewal.ts";
import {
  asRecord,
  closedWindow,
  timeMs,
  type CredentialReader,
  type CredentialSource,
  type PlanAccount,
  type PlanCredential,
  type PlanDriver,
  type PlanExtra,
  type PlanFetch,
  type PlanModelUsage,
  type PlanProviderRow,
  type PlanResponse,
  type PlanSpend,
  type PlanUsageDeps,
  type PlanUsageReport,
  type PlanWindow,
  type PlanWindows,
} from "./plan-usage-types.ts";

export {
  defaultCredentialReader,
  fileCredentialReader,
  parseAntigravityModels,
  parseAntigravityPlan,
  parseAntigravitySummary,
  parseClaudeUsage,
  parseCodexUsage,
  parseCursorDashboardUsage,
  parseCursorUsage,
  parseGrokUsage,
  parseOpenCodeUsage,
  type CredentialReader,
  type CredentialSource,
  type PlanAccount,
  type PlanCredential,
  type PlanDriver,
  type PlanExtra,
  type PlanFetch,
  type PlanModelUsage,
  type PlanProviderRow,
  type PlanResponse,
  type PlanSpend,
  type PlanUsageDeps,
  type PlanUsageReport,
  type PlanWindow,
  type PlanWindows,
};

const PROVIDER_TIMEOUT_MS = 8_000;
const CURSOR_TIMEOUT_MS = 15_000;
const PLAN_USAGE_CACHE_MS = 45_000;

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
  if (!store || !credential.refreshToken) return { status: "unchanged" };
  if (store.kind === "antigravity-memory") {
    return renewAntigravityToken({
      refreshToken: credential.refreshToken,
      target: store,
      force: turnedAway,
      fetch: deps.fetch,
      now: deps.now,
      timeoutMs,
    });
  }
  if (!credential.token) return { status: "unchanged" };
  const common = { token: credential.token, turnedAway, fetch: deps.fetch, now: deps.now, timeoutMs };
  if (store.kind === "claude-file" || store.kind === "claude-keychain") return renewClaudeToken({ target: store, ...common });
  if (store.kind === "codex-file") return renewCodexToken({ target: store, ...common });
  if (store.kind === "grok-file") return renewGrokToken({ target: store, ...common });
  if (store.kind === "cursor-file") return renewCursorToken({ target: store, ...common });
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
  const cachedRowOr = (fallback: PlanProviderRow): PlanProviderRow => {
    const cached = lastGoodRows.get(loginKey);
    return (cached ? pruneLastGoodRow(cached, account, now) : null) ?? fallback;
  };
  const cooldown = rateLimitCooldowns.get(loginKey);
  if (cooldown && cooldown.until > now) return cachedRowOr(errorRow(account, rateLimitedError(account.driver)));

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
      return cachedRowOr(errorRow(account, account.driver === "antigravity" ? couldNotReach("antigravity") : signInAgain(account.driver)));
    }
  } else if (credential.expired || !token) {
    lastGoodRows.delete(loginKey);
    rateLimitCooldowns.delete(loginKey);
    return errorRow(account, signInAgain(account.driver));
  }

  let outcome = await fetchSignedIn(account, { ...credential, token }, loginKey, now, deps);
  if (outcome.kind === "auth" && credential.refreshToken && credential.store) {
    const renewed = await tryRenewCredential({ ...credential, token }, true, deps);
    if (renewed.status === "renewed" && renewed.token !== token) {
      outcome = await fetchSignedIn(account, { ...credential, token: renewed.token }, loginKey, now, deps);
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
    return cachedRowOr(outcome.row);
  }
  if (outcome.kind === "transient") return cachedRowOr(outcome.row);
  return outcome.row;
}

async function fetchSignedIn(
  account: PlanAccount,
  credential: PlanCredential & { token: string },
  loginKey: string,
  now: number,
  deps: PlanUsageDeps,
): Promise<ProviderOutcome> {
  try {
    if (account.driver === "claude") return await fetchClaude(account, credential.token, credential.planHint ?? null, now, deps);
    if (account.driver === "codex") return await fetchCodex(account, credential.token, credential.accountId, now, deps);
    if (account.driver === "grok") return await fetchGrok(account, credential.token, now, deps);
    if (account.driver === "antigravity") return await fetchAntigravity(account, credential.token, loginKey, now, deps);
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

function failedJsonOutcome(account: PlanAccount, result: HttpResult, forbiddenMessage?: string): ProviderOutcome | null {
  if (result.status === 403 && forbiddenMessage) return { kind: "auth", row: errorRow(account, forbiddenMessage) };
  if (authRejected(result.status)) return { kind: "auth", row: errorRow(account, signInAgain(account.driver)) };
  if (result.status === 429) {
    return { kind: "rate_limit", retryAfterMs: result.retryAfterMs, row: errorRow(account, rateLimitedError(account.driver)) };
  }
  if (!result.ok || result.body === null || typeof result.body !== "object") {
    const transient = result.status === 0 || result.status >= 500;
    return { kind: transient ? "transient" : "other", row: errorRow(account, transient ? couldNotReach(account.driver) : unexpectedUsage(account.driver)) };
  }
  return null;
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
  return failedJsonOutcome(account, result) ?? { kind: "ok", row: okRow(account, parseClaudeUsage(result.body, planHint)) };
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
  return failedJsonOutcome(account, result) ?? { kind: "ok", row: okRow(account, parseCodexUsage(result.body, now)) };
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
  cacheKey: string,
  headers: Record<string, string>,
  timeoutMs: number,
  deps: PlanUsageDeps,
): Promise<string | null> {
  const cached = antigravityPlanCache.get(cacheKey);
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
      antigravityPlanCache.set(cacheKey, plan);
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
  loginKey: string,
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
    const plan = await fetchAntigravityPlan(loginKey, headers, timeout, deps);
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
        const plan = await fetchAntigravityPlan(loginKey, headers, timeout, deps);
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
    const plan = await fetchAntigravityPlan(loginKey, headers, timeout, deps);
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

  const failed = failedJsonOutcome(account, usageResponse);
  if (failed) return failed;

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
  const failed = failedJsonOutcome(account, result, "This OpenCode Go key has no active subscription");
  if (failed) return failed;
  const windows = parseOpenCodeUsage(result.body, now);
  const row = okRow(account, windows);
  if (!rowHasAnyWindow(row)) return { kind: "other", row: errorRow(account, unexpectedUsage("opencode")) };
  return { kind: "ok", row };
}
