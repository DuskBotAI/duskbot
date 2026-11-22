import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPlanUsageCache,
  fetchPlanUsage,
  fileCredentialReader,
  loadPlanUsage,
  parseAntigravityModels,
  parseAntigravityPlan,
  parseAntigravitySummary,
  parseClaudeUsage,
  parseCodexUsage,
  parseCursorDashboardUsage,
  parseCursorUsage,
  parseGrokUsage,
  parseOpenCodeUsage,
  planAccountsFromInstances,
  type PlanAccount,
  type PlanFetch,
  type PlanResponse,
} from "./plan-usage.ts";
import { antigravityProfileDirectory } from "./drivers/antigravity-acp.ts";
import { asciiJson, codexKeychainItem, codexUsesKeyring, readCursorStateDb, readOpenCodeGoDbKey } from "./plan-usage-renewal.ts";
import { DatabaseSync } from "node:sqlite";

const SECRET = "plan-usage-fixture-secret";
const NOW = 1_800_000_000_000;
const tempDirs: string[] = [];

beforeEach(() => {
  clearPlanUsageCache();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeJwt(payload: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${head}.${body}.sig`;
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): PlanResponse {
  const lower = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function account(driver: PlanAccount["driver"], extras: Partial<PlanAccount> = {}): PlanAccount {
  const names: Record<PlanAccount["driver"], string> = {
    claude: "Claude",
    codex: "Codex",
    grok: "Grok",
    antigravity: "Antigravity",
    cursor: "Cursor",
    opencode: "OpenCode Go",
  };
  return {
    id: driver,
    name: names[driver],
    driver,
    environment: {},
    ...extras,
  };
}

describe("plan usage parsers", () => {
  describe("a Claude budget in money", () => {
    const enterprise = {
      five_hour: null,
      seven_day: null,
      spend: { enabled: true, used: { amount_minor: 4_631, currency: "USD", exponent: 2 }, limit: { amount_minor: 50_000, currency: "USD", exponent: 2 }, percent: 9 },
      extra_usage: { is_enabled: true, used_credits: 4_631, monthly_limit: 50_000, utilization: 9.262, currency: "USD", decimal_places: 2 },
    };
    const line = (label: string, used: number, spend?: object) => ({ label, usedPercent: expect.closeTo(used, 2), remainingPercent: expect.closeTo(100 - used, 2), resetsAt: null, ...(spend ? { spend } : {}) });

    it("shows an Enterprise seat's monthly spend with its amounts, once", () => {
      const parsed = parseClaudeUsage(enterprise);
      expect(parsed.extra).toEqual([line("Monthly spend", 9.262, { usedMinor: 4_631, limitMinor: 50_000, currency: "USD", exponent: 2 })]);
      expect(parsed.fiveHour.available).toBe(false);
      expect(parsed.weekly.available).toBe(false);
    });

    it("reads the budget from extra usage when the spend block is missing, off or its money does not add up", () => {
      const fallback = line("Monthly spend", 9.262, { usedMinor: 4_631, limitMinor: 50_000, currency: "USD", exponent: 2 });
      expect(parseClaudeUsage({ extra_usage: enterprise.extra_usage }).extra).toEqual([fallback]);
      expect(parseClaudeUsage({ ...enterprise, spend: { ...enterprise.spend, enabled: false } }).extra).toEqual([fallback]);
      const unmatched = { ...enterprise.spend, used: { amount_minor: 9_000, currency: "USD", exponent: 2 } };
      expect(parseClaudeUsage({ ...enterprise, spend: { ...unmatched, limit: { amount_minor: 50_000, currency: "EUR", exponent: 2 } } }).extra).toEqual([fallback]);
      expect(parseClaudeUsage({ ...enterprise, spend: { ...unmatched, limit: { amount_minor: 50_000, currency: "USD", exponent: 3 } } }).extra).toEqual([fallback]);
    });

    it("prefers the spend block over extra usage, and needs nothing else", () => {
      const spend = { ...enterprise.spend, used: { amount_minor: 25_000, currency: "USD", exponent: 2 } };
      const line50 = line("Monthly spend", 50, { usedMinor: 25_000, limitMinor: 50_000, currency: "USD", exponent: 2 });
      expect(parseClaudeUsage({ ...enterprise, spend }).extra).toEqual([line50]);
      expect(parseClaudeUsage({ spend }).extra).toEqual([line50]);
    });

    it("takes the digits from the currency when Claude does not say", () => {
      const { decimal_places: _digits, ...usd } = enterprise.extra_usage;
      expect(parseClaudeUsage({ extra_usage: usd }).extra[0]?.spend?.exponent).toBe(2);
      expect(parseClaudeUsage({ extra_usage: { ...usd, currency: "JPY" } }).extra[0]?.spend?.exponent).toBe(0);
    });

    it("keeps only the percent without usable amounts", () => {
      expect(parseClaudeUsage({ extra_usage: { is_enabled: true, utilization: 30, monthly_limit: null, used_credits: null } }).extra).toEqual([line("Monthly spend", 30)]);
      expect(parseClaudeUsage({ extra_usage: { is_enabled: true, utilization: 30, monthly_limit: 500, used_credits: 150, currency: "not money" } }).extra).toEqual([line("Monthly spend", 30)]);
      expect(parseClaudeUsage({ extra_usage: { is_enabled: true, utilization: 30, monthly_limit: 0, used_credits: 0, currency: "USD" } }).extra).toEqual([line("Monthly spend", 30)]);
    });

    it("calls it extra usage on a plan with rolling windows", () => {
      const parsed = parseClaudeUsage({ five_hour: { utilization: 10, resets_at: null }, seven_day: { utilization: 20, resets_at: null }, extra_usage: { is_enabled: true, used_credits: 500, monthly_limit: 1_000, utilization: 50, currency: "USD" } });
      expect(parsed.extra).toEqual([line("Extra Usage", 50, { usedMinor: 500, limitMinor: 1_000, currency: "USD", exponent: 2 })]);
    });

    it("shows nothing for a budget that is off", () => {
      expect(parseClaudeUsage({ extra_usage: { ...enterprise.extra_usage, is_enabled: false } }).extra).toEqual([]);
      expect(parseClaudeUsage({ spend: { ...enterprise.spend, enabled: false } }).extra).toEqual([]);
    });
  });

  it("turns Claude utilization into remaining percent and keeps opus as a model window", () => {
    const parsed = parseClaudeUsage({
      five_hour: { utilization: 25, resets_at: "2026-09-26T12:00:00.000Z" },
      seven_day: { utilization: 40, resets_at: "2026-10-03T00:00:00.000Z" },
      five_hour_opus: { utilization: 10, resets_at: "2026-09-26T12:00:00.000Z" },
      seven_day_opus: { utilization: 15, resets_at: "2026-10-03T00:00:00.000Z" },
      seven_day_sonnet: { utilization: 8, resets_at: "2026-10-03T00:00:00.000Z" },
      access_token: SECRET,
      claudeAiOauth: { accessToken: SECRET },
    });
    expect(parsed.fiveHour).toMatchObject({ available: true, usedPercent: 25, remainingPercent: 75, resetsAt: "2026-09-26T12:00:00.000Z" });
    expect(parsed.weekly).toMatchObject({ available: true, usedPercent: 40, remainingPercent: 60 });
    expect(parsed.extra).toEqual([]);
    expect(parsed.models).toEqual([
      {
        name: "Opus",
        windows: [
          expect.objectContaining({ label: "5-hour", usedPercent: 10, remainingPercent: 90 }),
          expect.objectContaining({ label: "Weekly", usedPercent: 15, remainingPercent: 85, resetsAt: "2026-10-03T00:00:00.000Z" }),
        ],
      },
      {
        name: "Sonnet",
        windows: [
          expect.objectContaining({ label: "Weekly", usedPercent: 8, remainingPercent: 92 }),
        ],
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });

  it("keeps seven_day_oauth_apps on an extra line instead of a model row", () => {
    const parsed = parseClaudeUsage({
      seven_day_oauth_apps: { utilization: 12, resets_at: "2026-10-03T00:00:00.000Z" },
    });
    expect(parsed.extra).toEqual([
      expect.objectContaining({ label: "Oauth Apps", usedPercent: 12, remainingPercent: 88 }),
    ]);
    expect(parsed.models).toEqual([]);
  });

  it("classifies Codex windows by duration and does not stuff a 30-day window into weekly", () => {
    const parsed = parseCodexUsage({
      plan_type: "plus",
      access_token: SECRET,
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1_800_000_000 },
      },
      additional_rate_limits: [
        { used_percent: 5, limit_window_seconds: 30 * 86400, reset_at: 1_800_000_000_000 },
      ],
    });
    expect(parsed.plan).toBe("plus");
    expect(parsed.fiveHour).toMatchObject({
      available: true,
      usedPercent: 10,
      remainingPercent: 90,
      resetsAt: new Date(1_800_000_000_000).toISOString(),
    });
    expect(parsed.weekly).toMatchObject({ available: true, usedPercent: 40, remainingPercent: 60 });
    expect(parsed.extra).toEqual([
      expect.objectContaining({
        label: "30-day",
        usedPercent: 5,
        remainingPercent: 95,
        resetsAt: new Date(1_800_000_000_000).toISOString(),
      }),
    ]);
    expect(parsed.models).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });

  it("keeps Codex model windows separate from the account plan", () => {
    const parsed = parseCodexUsage({
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1_800_000_000 },
      },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3-Codex-Spark",
          rate_limit: {
            primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
            secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 1_800_000_000 },
          },
        },
      ],
    });
    expect(parsed.fiveHour.usedPercent).toBe(10);
    expect(parsed.weekly.usedPercent).toBe(40);
    expect(parsed.models).toEqual([
      {
        name: "GPT-5.3-Codex-Spark",
        windows: [
          expect.objectContaining({ label: "5-hour", usedPercent: 5, remainingPercent: 95 }),
          expect.objectContaining({ label: "Weekly", usedPercent: 12, remainingPercent: 88 }),
        ],
      },
    ]);
  });

  it("reports Grok weekly credits without inventing a 5-hour window", () => {
    const parsed = parseGrokUsage(
      {
        access_token: SECRET,
        config: {
          creditUsagePercent: 8,
          currentPeriod: { type: "WEEK", start: "2026-09-26T00:00:00.000Z", end: "2026-10-03T00:00:00.000Z" },
          productUsage: [
            { product: "GrokBuild", usagePercent: 8 },
            { product: "GrokChat", usagePercent: 2 },
          ],
        },
      },
      {
        config: {
          onDemandCap: { val: 100 },
          onDemandUsed: { val: 40 },
          currentPeriod: { type: "MONTH", end: "2026-10-26T00:00:00.000Z" },
        },
      },
      { settings: { subscription_tier_display: "SuperGrok", access_token: SECRET } },
    );
    expect(parsed.plan).toBe("SuperGrok");
    expect(parsed.fiveHour).toEqual({ available: false, remainingPercent: null, usedPercent: null, resetsAt: null });
    expect(parsed.weekly).toMatchObject({
      available: true,
      usedPercent: 8,
      remainingPercent: 92,
      resetsAt: "2026-10-03T00:00:00.000Z",
    });
    expect(parsed.extra).toEqual([
      expect.objectContaining({ label: "Monthly", usedPercent: 40, remainingPercent: 60 }),
    ]);
    expect(parsed.models).toEqual([
      { name: "Grok Build", windows: [expect.objectContaining({ label: "Weekly", usedPercent: 8, remainingPercent: 92 })] },
      { name: "Grok Chat", windows: [expect.objectContaining({ label: "Weekly", usedPercent: 2, remainingPercent: 98 })] },
    ]);
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });
});

describe("plan usage fetcher", () => {
  it("does not call fetch when the Claude token is expired", async () => {
    const fetchImpl = vi.fn<PlanFetch>();
    const configDir = join(tmpdir(), "dusk-plan-usage-claude");
    const reads: string[] = [];
    const report = await fetchPlanUsage([account("claude", { id: "work", name: "Work Claude", configDir })], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        env: { HOME: tmpdir(), USERPROFILE: tmpdir() },
        readText: (path) => {
          reads.push(path);
          return JSON.stringify({ claudeAiOauth: { accessToken: SECRET, expiresAt: NOW - 60_000 } });
        },
      }),
    });
    expect(reads.map((path) => path.replaceAll("\\", "/"))).toEqual([
      `${configDir.replaceAll("\\", "/")}/.credentials.json`,
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.providers).toEqual([
      expect.objectContaining({ id: "work", name: "Work Claude", driver: "claude", ok: false, error: "Sign in again in Claude" }),
    ]);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it("reads a Claude keychain token when the credentials file has none", async () => {
    const token = "claude-keychain-fixture-token";
    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({
      five_hour: { utilization: 25, resets_at: "2026-09-26T12:00:00.000Z" },
      seven_day: { utilization: 40, resets_at: "2026-10-03T00:00:00.000Z" },
    }));
    const services: string[] = [];
    const report = await fetchPlanUsage([account("claude")], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        env: { HOME: tmpdir(), USERPROFILE: tmpdir() },
        readText: () => null,
        readClaudeKeychain: async (service) => {
          services.push(service);
          return service === "Claude Code-credentials"
            ? JSON.stringify({ claudeAiOauth: { accessToken: token } })
            : null;
        },
      }),
    });
    expect(services).toEqual(["Claude Code-credentials"]);
    expect(fetchImpl.mock.calls[0]?.[1].headers.Authorization).toBe(`Bearer ${token}`);
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it("asks the keychain only for the custom config dir service", async () => {
    const token = "claude-keychain-other-token";
    const configDir = normalize(join(tmpdir(), "dusk-plan-usage-claude-other"));
    const suffixed = `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({
      five_hour: { utilization: 25, resets_at: "2026-09-26T12:00:00.000Z" },
      seven_day: { utilization: 40, resets_at: "2026-10-03T00:00:00.000Z" },
    }));
    const services: string[] = [];
    const report = await fetchPlanUsage([account("claude", { configDir })], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        env: { HOME: tmpdir(), USERPROFILE: tmpdir() },
        readText: () => null,
        readClaudeKeychain: (service) => {
          services.push(service);
          return service === suffixed
            ? JSON.stringify({ claudeAiOauth: { accessToken: token } })
            : null;
        },
      }),
    });
    expect(services[0]).toBe(suffixed);
    expect(services).toEqual([suffixed]);
    expect(fetchImpl.mock.calls[0]?.[1].headers.Authorization).toBe(`Bearer ${token}`);
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it("does not use the default Claude keychain login for a custom config dir", async () => {
    const defaultToken = "claude-keychain-default-token";
    const configDir = normalize(join(tmpdir(), "dusk-plan-usage-claude-custom"));
    const suffixed = `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({}));
    const services: string[] = [];
    const report = await fetchPlanUsage([account("claude", { id: "work", name: "Work Claude", configDir })], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        env: { HOME: tmpdir(), USERPROFILE: tmpdir() },
        readText: () => null,
        readClaudeKeychain: (service) => {
          services.push(service);
          return service === "Claude Code-credentials"
            ? JSON.stringify({ claudeAiOauth: { accessToken: defaultToken } })
            : null;
        },
      }),
    });
    expect(services).toEqual([suffixed]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.providers[0]).toMatchObject({ ok: false, error: "Sign in again in Claude" });
    expect(JSON.stringify(report)).not.toContain(defaultToken);
  });

  it("turns a 401 into ok:false without throwing and still returns the other provider", async () => {
    const fetchImpl = vi.fn<PlanFetch>(async (url) => {
      if (url.includes("anthropic.com")) return jsonResponse(SECRET, 401);
      return jsonResponse({
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
          secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1_800_000_000 },
        },
      });
    });
    const report = await fetchPlanUsage(
      [account("claude"), account("codex")],
      {
        fetch: fetchImpl,
        now: () => NOW,
        credentials: {
          read: (entry) => ({ token: SECRET, accountId: entry.driver === "codex" ? "acct-1" : null, expired: false }),
        },
      },
    );
    expect(report.providers.map((provider) => [provider.driver, provider.ok, provider.error])).toEqual([
      ["claude", false, "Sign in again in Claude"],
      ["codex", true, null],
    ]);
    expect(report.providers[1]?.fiveHour.remainingPercent).toBe(90);
    expect(report.providers[1]?.weekly.remainingPercent).toBe(60);
    const codexCall = fetchImpl.mock.calls.find((call) => call[0].includes("chatgpt.com"));
    expect(codexCall?.[1].headers["ChatGPT-Account-Id"]).toBe("acct-1");
    expect(codexCall?.[1].headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it("reads usage once for two Claude engines on the same sign-in, since a second read at once is answered 429", async () => {
    let reads = 0;
    const fetchImpl = vi.fn<PlanFetch>(async () => ++reads > 1 ? jsonResponse({ error: "rate_limited" }, 429) : jsonResponse({
      seven_day: { utilization: 57, resets_at: "2026-10-03T00:00:00.000Z" },
    }));
    const report = await fetchPlanUsage([account("claude"), account("claude", { id: "claudeApi", name: "Claude API" })], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: { read: () => ({ token: SECRET, accountId: null, expired: false }) },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(report.providers.map((provider) => [provider.id, provider.name, provider.ok, provider.weekly.usedPercent])).toEqual([
      ["claude", "Claude", true, 57],
      ["claudeApi", "Claude API", true, 57],
    ]);
  });

  it("reads a Grok login map, skips expired entries, and ignores a settings failure", async () => {
    const fresh = "grok-fresh-fixture-token";
    const stale = "grok-stale-fixture-token";
    const fetchImpl = vi.fn<PlanFetch>(async (url) => {
      if (url.includes("format=credits")) {
        return jsonResponse({
          config: { creditUsagePercent: 8, currentPeriod: { type: "WEEK", end: "2026-10-03T00:00:00.000Z" } },
        });
      }
      if (url.endsWith("/v1/settings")) return jsonResponse("nope", 500);
      return jsonResponse({ config: { creditUsagePercent: 40, currentPeriod: { type: "MONTH", end: "2026-10-26T00:00:00.000Z" } } });
    });
    const report = await fetchPlanUsage([account("grok", { name: "Grok" })], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        env: { HOME: tmpdir(), USERPROFILE: tmpdir() },
        readText: () => JSON.stringify({
          old: { key: stale, expires_at: NOW - 60_000 },
          current: { key: fresh, expires_at: NOW + 60_000 },
        }),
      }),
    });
    expect(fetchImpl.mock.calls[0]?.[1].headers.Authorization).toBe(`Bearer ${fresh}`);
    expect(fetchImpl.mock.calls[0]?.[1].headers["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
    expect(report.providers[0]).toMatchObject({
      ok: true,
      error: null,
      plan: null,
      fiveHour: { available: false },
      weekly: { available: true, remainingPercent: 92, usedPercent: 8 },
    });
    expect(report.providers[0]?.extra[0]).toMatchObject({ label: "Monthly", remainingPercent: 60 });
    expect(JSON.stringify(report)).not.toContain(fresh);
    expect(JSON.stringify(report)).not.toContain(stale);
  });

  it("caches a report for 45 seconds unless refresh is set", async () => {
    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({
      five_hour: { utilization: 25, resets_at: "2026-09-26T12:00:00.000Z" },
      seven_day: { utilization: 40, resets_at: "2026-10-03T00:00:00.000Z" },
    }));
    const accounts = [account("claude")];
    const credentials = { read: () => ({ token: SECRET, accountId: null, expired: false }) };
    await loadPlanUsage({ accounts, now: NOW, fetch: fetchImpl, credentials });
    await loadPlanUsage({ accounts, now: NOW + 10_000, fetch: fetchImpl, credentials });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await loadPlanUsage({ accounts, refresh: true, now: NOW + 11_000, fetch: fetchImpl, credentials });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await loadPlanUsage({ accounts, now: NOW + 11_000 + 45_000, fetch: fetchImpl, credentials });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not share the cache when GROK_HOME changes", async () => {
    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({
      five_hour: { utilization: 25, resets_at: "2026-09-26T12:00:00.000Z" },
      seven_day: { utilization: 40, resets_at: "2026-10-03T00:00:00.000Z" },
    }));
    const credentials = { read: () => ({ token: SECRET, accountId: null, expired: false }) };
    await loadPlanUsage({
      accounts: [account("claude", { id: "same", environment: { GROK_HOME: "/tmp/one" } })],
      now: NOW,
      fetch: fetchImpl,
      credentials,
    });
    await loadPlanUsage({
      accounts: [account("claude", { id: "same", environment: { GROK_HOME: "/tmp/two" } })],
      now: NOW + 1_000,
      fetch: fetchImpl,
      credentials,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("lists configured subscription plan accounts and skips unsupported API engines", () => {
    expect(planAccountsFromInstances({
      claude: { driver: "claudeAgent", displayName: "  Personal Claude  ", config: { configDir: "/tmp/claude" } },
      codex: { driver: "codex" },
      grok: { driver: "grokAgent", environment: { GROK_HOME: "/tmp/grok" } },
      antigravity: { driver: "antigravityAgent" },
      cursor: { driver: "cursorAgent", displayName: "Cursor" },
      opencodeGo: { driver: "opencodeGo" },
      mistral: { driver: "mistral", displayName: "Mistral" },
      api: { driver: "grok", displayName: "Grok API" },
    })).toEqual([
      { id: "claude", name: "Personal Claude", driver: "claude", environment: {}, configDir: "/tmp/claude" },
      { id: "codex", name: "Codex", driver: "codex", environment: {} },
      { id: "grok", name: "Grok", driver: "grok", environment: { GROK_HOME: "/tmp/grok" } },
      { id: "antigravity", name: "Antigravity", driver: "antigravity", environment: {} },
      { id: "cursor", name: "Cursor", driver: "cursor", environment: {} },
      { id: "opencodeGo", name: "OpenCode Go", driver: "opencode", environment: {} },
    ]);
  });

  it("reads no usage for a ChatGPT-plan provider, whose sign-in is not the shared Codex login", async () => {
    // Reading ~/.codex/auth.json for it reported (and held) the default Codex account's limit on a different account.
    const accounts = planAccountsFromInstances({
      codex: { driver: "codex" },
      chatgpt: { driver: "codex", displayName: "ChatGPT plan", config: { authMode: "chatgpt-plan" } },
    });
    // Still listed, so a refusal-based hold names it properly.
    expect(accounts).toEqual([
      { id: "codex", name: "Codex", driver: "codex", environment: {} },
      { id: "chatgpt", name: "ChatGPT plan", driver: "codex", environment: {}, noUsage: true },
    ]);
    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({ rate_limit: { primary_window: { used_percent: 100 } } }));
    const report = await fetchPlanUsage(accounts, {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: { read: () => ({ token: SECRET, accountId: null, expired: false }) },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(report.providers.map((row) => row.id)).toEqual(["codex"]);
  });

  it("reads no usage for Claude (API key), which shares the signed-in Claude folder", () => {
    expect(planAccountsFromInstances({
      claude: { driver: "claudeAgent" },
      claudeApi: { driver: "claudeAgent", displayName: "Claude (API key)", access: "api", config: { requireApiKey: true } },
    })).toEqual([
      { id: "claude", name: "Claude", driver: "claude", environment: {} },
      { id: "claudeApi", name: "Claude (API key)", driver: "claude", environment: {}, noUsage: true },
    ]);
  });

  it("parses Claude's limits array, numeric strings, and User-Agent header", async () => {
    const parsed = parseClaudeUsage({
      limits: [
        { kind: "session", group: "session", percent: "18.5", resets_at: "2026-10-26T12:00:00Z" },
        { kind: "weekly_all", group: "weekly", percent: 42, resets_at: "2026-11-01T00:00:00Z" },
        { kind: "weekly_sonnet", group: "weekly", percent: 11, resets_at: "2026-11-01T00:00:00Z", scope: { model: { display_name: "Sonnet" } } },
      ],
    }, "Max 20x");
    expect(parsed.plan).toBe("Max 20x");
    expect(parsed.fiveHour).toMatchObject({ available: true, usedPercent: 18.5, remainingPercent: 81.5 });
    expect(parsed.weekly).toMatchObject({ available: true, usedPercent: 42, remainingPercent: 58 });
    expect(parsed.models).toEqual([
      { name: "Sonnet", windows: [expect.objectContaining({ label: "Weekly", usedPercent: 11, remainingPercent: 89 })] },
    ]);

    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({
      five_hour: { utilization: 12, resets_at: "2026-10-26T12:00:00Z" },
    }));
    const report = await fetchPlanUsage([account("claude")], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        env: { HOME: tmpdir(), USERPROFILE: tmpdir() },
        readText: () => JSON.stringify({
          claudeAiOauth: { accessToken: SECRET, subscriptionType: "claude_max", rateLimitTier: "default_claude_max_20x" },
        }),
      }),
    });
    expect(fetchImpl.mock.calls[0]?.[1].headers["User-Agent"]).toMatch(/^claude-cli\//);
    expect(report.providers[0]?.plan).toBe("Max 20x");
  });

  it("renews an expired Claude file credential under lock, writes ASCII JSON back, and retries usage", async () => {
    const dir = makeTempDir("dusk-claude-renew-");
    const credsPath = join(dir, ".credentials.json");
    const oldToken = "claude-expired-token";
    const freshToken = "claude-renewed-token";
    const oldRefresh = "claude-old-refresh";
    const freshRefresh = "claude-new-refresh";
    writeFileSync(credsPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: oldToken,
        refreshToken: oldRefresh,
        expiresAt: NOW - 60_000,
        subscriptionType: "claude_pro",
        note: "café",
      },
      unrelated: { keep: true },
    }));

    const fetchImpl = vi.fn<PlanFetch>(async (url, init) => {
      if (url.includes("/v1/oauth/token")) {
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body ?? "{}")).toMatchObject({ grant_type: "refresh_token", refresh_token: oldRefresh });
        return jsonResponse({ access_token: freshToken, refresh_token: freshRefresh, expires_in: 28_800 });
      }
      expect(init.headers.Authorization).toBe(`Bearer ${freshToken}`);
      return jsonResponse({
        five_hour: { utilization: 33, resets_at: new Date(NOW + 3_600_000).toISOString() },
        seven_day: { utilization: 55, resets_at: new Date(NOW + 86_400_000).toISOString() },
      });
    });

    const report = await fetchPlanUsage([account("claude", { configDir: dir })], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        writable: true,
        env: { HOME: dir, USERPROFILE: dir },
        readText: (path) => {
          try { return readFileSync(path, "utf8"); } catch { return null; }
        },
      }),
    });

    expect(report.providers[0]).toMatchObject({ ok: true, plan: "Pro", fiveHour: { usedPercent: 33 }, weekly: { usedPercent: 55 } });
    const rawSaved = readFileSync(credsPath, "utf8");
    expect(rawSaved).toContain("\\u00e9");
    expect(JSON.parse(rawSaved)).toMatchObject({
      unrelated: { keep: true },
      claudeAiOauth: { accessToken: freshToken, refreshToken: freshRefresh, subscriptionType: "claude_pro", note: "café" },
    });
    expect(JSON.stringify(report)).not.toContain(freshToken);
    expect(JSON.stringify(report)).not.toContain(freshRefresh);
    expect(asciiJson({ café: "é" })).toBe('{"caf\\u00e9":"\\u00e9"}');
  });

  it("honors 429 Retry-After cooldown, serves last-good windows while cooling, and coalesces concurrent loadPlanUsage reads", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn<PlanFetch>(async () => {
      calls += 1;
      if (calls === 1) {
        await gate;
        return jsonResponse({
          five_hour: { utilization: 25, resets_at: new Date(NOW + 3_600_000).toISOString() },
          seven_day: { utilization: 50, resets_at: new Date(NOW + 86_400_000).toISOString() },
        });
      }
      return jsonResponse({ error: "rate_limited" }, 429, { "Retry-After": "120" });
    });

    const credentials = { read: () => ({ token: SECRET, accountId: null, expired: false }) };
    const accounts = [account("claude")];

    const first = loadPlanUsage({ accounts, now: NOW, fetch: fetchImpl, credentials });
    const joined = loadPlanUsage({ accounts, now: NOW, fetch: fetchImpl, credentials });
    release();
    const [r1, r2] = await Promise.all([first, joined]);
    expect(calls).toBe(1);
    expect(r1.providers[0]?.weekly.usedPercent).toBe(50);
    expect(r2.providers[0]?.weekly.usedPercent).toBe(50);

    // Refresh hits 429 -> serves last-good windows and arms 120s cooldown.
    const r3 = await loadPlanUsage({ accounts, refresh: true, now: NOW + 60_000, fetch: fetchImpl, credentials });
    expect(calls).toBe(2);
    expect(r3.providers[0]).toMatchObject({ ok: true, weekly: { usedPercent: 50 }, fiveHour: { usedPercent: 25 } });

    // During cooldown -> skips upstream fetch completely and still returns valid last-good row.
    const r4 = await loadPlanUsage({ accounts, refresh: true, now: NOW + 120_000, fetch: fetchImpl, credentials });
    expect(calls).toBe(2);
    expect(r4.providers[0]).toMatchObject({ ok: true, weekly: { usedPercent: 50 } });

    // Past cooldown -> probes upstream again; expired 5-hour window is pruned from last-good.
    const r5 = await loadPlanUsage({ accounts, refresh: true, now: NOW + 4_000_000, fetch: fetchImpl, credentials });
    expect(calls).toBe(3);
    expect(r5.providers[0]).toMatchObject({ ok: true, fiveHour: { available: false }, weekly: { available: true, usedPercent: 50 } });
  });

  it("reads Codex keyring fallback, JWT account id, reset_after_seconds, and renews expired auth.json", async () => {
    const dir = makeTempDir("dusk-codex-");
    const jwt = makeJwt({
      exp: Math.floor((NOW + 3600_000) / 1000),
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-jwt" },
    });
    expect(codexUsesKeyring('cli_auth_credentials_store = "keyring" # comment\n')).toBe(true);
    expect(codexUsesKeyring('cli_auth_credentials_store = "file"\n')).toBe(false);
    const expectedItem = codexKeychainItem(dir);
    expect(expectedItem.service).toBe("Codex Auth");
    expect(expectedItem.account).toMatch(/^cli\|[0-9a-f]{16}$/);

    const fetchImpl = vi.fn<PlanFetch>(async () => jsonResponse({
      plan_type: "free",
      rate_limit: {
        primary_window: { used_percent: "22", limit_window_seconds: "2592000", reset_after_seconds: "3600" },
      },
    }));
    const report = await fetchPlanUsage([account("codex", { environment: { CODEX_HOME: dir } })], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        env: { HOME: dir, USERPROFILE: dir },
        readText: (path) => (path.endsWith("config.toml") ? 'cli_auth_credentials_store = "auto"\n' : null),
        readCodexKeychain: (service, acct) =>
          service === expectedItem.service && acct === expectedItem.account
            ? JSON.stringify({ tokens: { access_token: jwt } })
            : null,
      }),
    });
    expect(fetchImpl.mock.calls[0]?.[1].headers["ChatGPT-Account-Id"]).toBe("acct-from-jwt");
    expect(report.providers[0]).toMatchObject({
      ok: true,
      plan: "free",
      extra: [expect.objectContaining({ label: "30-day", usedPercent: 22, resetsAt: new Date(NOW + 3600_000).toISOString() })],
    });
  });

  it("treats Grok protobuf zero-omitted creditUsagePercent as 0% used when currentPeriod is present", () => {
    const parsed = parseGrokUsage({
      config: {
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-01T00:00:00Z", end: "2026-10-08T00:00:00Z" },
      },
    });
    expect(parsed.weekly).toMatchObject({ available: true, usedPercent: 0, remainingPercent: 100, resetsAt: "2026-10-08T00:00:00.000Z" });
  });

  it("fetches Antigravity limits across both hosts with in-memory Google OAuth renewal and model fallback", async () => {
    const dataDir = makeTempDir("dusk-ag-data-");
    const profileDir = antigravityProfileDirectory("antigravity", dataDir);
    const tokenPath = join(profileDir, "antigravity-acp", "antigravity-oauth-token");
    const refreshSecret = "ag-refresh-secret";
    const freshAccess = "ag-fresh-access-secret";

    const fetchImpl = vi.fn<PlanFetch>(async (url, init) => {
      if (url === "https://oauth2.googleapis.com/token") {
        expect(init.body).toContain(`refresh_token=${refreshSecret}`);
        return jsonResponse({ access_token: freshAccess, expires_in: 3600 });
      }
      expect(init.headers["User-Agent"]).toMatch(/^antigravity\//);
      expect(init.headers.Authorization).toBe(`Bearer ${freshAccess}`);
      if (url === "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary") {
        return jsonResponse({
          groups: [
            {
              displayName: "Gemini",
              buckets: [
                { bucketId: "gemini-5h", remainingFraction: 1, resetTime: "2026-10-26T15:00:00Z" },
                { bucketId: "gemini-weekly", remainingFraction: 0.7, resetTime: "2026-11-01T00:00:00Z" },
              ],
            },
            {
              displayName: "Gemini 4 Argon",
              buckets: [{ window: "weekly", remainingFraction: 0.5, resetTime: "2026-11-01T00:00:00Z" }],
            },
          ],
        });
      }
      if (url === "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary") {
        return jsonResponse({
          groups: [
            {
              displayName: "Gemini",
              buckets: [
                { bucketId: "gemini-5h", remainingFraction: 0.8, resetTime: "2026-10-26T14:00:00Z" },
                { bucketId: "3p-weekly", remainingFraction: 0.6, resetTime: "2026-11-01T00:00:00Z" },
              ],
            },
          ],
        });
      }
      if (url.endsWith("/v1internal:loadCodeAssist")) {
        return jsonResponse({ paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } });
      }
      return jsonResponse({}, 404);
    });

    const report = await fetchPlanUsage([account("antigravity")], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        dataDir,
        readText: (path) => (path === tokenPath
          ? JSON.stringify({ token: { access_token: "expired-ag", refresh_token: refreshSecret, expiry: new Date(NOW - 60_000).toISOString() } })
          : null),
      }),
    });

    expect(report.providers[0]).toMatchObject({
      id: "antigravity",
      driver: "antigravity",
      ok: true,
      plan: "Pro",
      fiveHour: { available: true, usedPercent: 20, remainingPercent: 80, resetsAt: "2026-10-26T14:00:00.000Z" },
      weekly: { available: true, usedPercent: 30, remainingPercent: 70, resetsAt: "2026-11-01T00:00:00.000Z" },
    });
    expect(report.providers[0]?.models).toEqual([
      { name: "Claude & GPT", windows: [expect.objectContaining({ label: "Weekly", usedPercent: 40 })] },
      { name: "Gemini 4 Argon", windows: [expect.objectContaining({ label: "Weekly", usedPercent: 50 })] },
    ]);
    expect(JSON.stringify(report)).not.toContain(refreshSecret);
    expect(JSON.stringify(report)).not.toContain(freshAccess);

    // Fallback model parser treats missing remainingFraction as 100% used and classifies by reset distance.
    const fromModels = parseAntigravityModels({
      "gemini-3-pro": { displayName: "Gemini 3 Pro", quotaInfo: { resetTime: new Date(NOW + 2 * 3600_000).toISOString() } },
      "claude-sonnet": { displayName: "Claude Sonnet", quotaInfo: { remainingFraction: 0.25, resetTime: new Date(NOW + 4 * 86_400_000).toISOString() } },
      internal: { displayName: "Gemini Internal", isInternal: true, quotaInfo: { remainingFraction: 0 } },
    }, NOW, new Set());
    expect(fromModels?.fiveHour).toMatchObject({ available: true, usedPercent: 100 });
    expect(fromModels?.models).toEqual([
      { name: "Claude & GPT", windows: [expect.objectContaining({ label: "Weekly", usedPercent: 75 })] },
    ]);
    expect(parseAntigravityPlan({ currentTier: { name: "Google AI Ultra" } })).toBe("Ultra");
    expect(parseAntigravitySummary([])).toBeNull();
  });

  it("fetches Cursor Connect-RPC monthly and weekly plans, plus Team dashboard fallback and isolated CURSOR_CONFIG_DIR", async () => {
    const token = makeJwt({ sub: "auth0|user_123", exp: Math.floor((NOW + 10 * 86_400_000) / 1000) });
    const monthly = parseCursorUsage(
      {
        billingCycleEnd: "2026-11-26T00:00:00Z",
        planUsage: { totalPercentUsed: 42, autoPercentUsed: 30, apiPercentUsed: 12 },
        spendLimitUsage: { individualLimit: 2000, individualUsed: 500 },
      },
      { planInfo: { planName: "Pro" } },
    );
    expect(monthly.plan).toBe("Pro");
    expect(monthly.weekly.available).toBe(false);
    expect(monthly.extra).toEqual([
      expect.objectContaining({ label: "Monthly", usedPercent: 42, remainingPercent: 58, resetsAt: "2026-11-26T00:00:00.000Z" }),
      expect.objectContaining({ label: "On-demand", usedPercent: 25, spend: { usedMinor: 500, limitMinor: 2000, currency: "USD", exponent: 2 } }),
    ]);
    expect(monthly.models.map((m) => m.name)).toEqual(["Cursor models", "Other models"]);

    const weekly = parseCursorUsage(
      { planUsage: { limit: 1000, remaining: 400 } },
      { planInfo: { planName: "Pro+", includedUsagePeriod: "INCLUDED_USAGE_PERIOD_WEEKLY", includedUsageResetsAt: new Date(NOW - 86_400_000).toISOString() } },
      { rememberedNow: NOW },
    );
    expect(weekly.weekly).toMatchObject({
      available: true,
      usedPercent: 60,
      resetsAt: new Date(NOW + 6 * 86_400_000).toISOString(),
    });

    // Team/Enterprise dashboard fallback when Connect-RPC omits planUsage
    const fetchImpl = vi.fn<PlanFetch>(async (url, init) => {
      if (url.endsWith("GetPlanInfo")) return jsonResponse({ planInfo: { planName: "Team" } });
      if (url.endsWith("GetCurrentPeriodUsage")) return jsonResponse({ billingCycleEnd: "2026-11-30T00:00:00Z" });
      if (url === "https://cursor.com/api/usage-summary") {
        expect(init.headers.Cookie).toBe(`WorkosCursorSessionToken=user_123%3A%3A${token}`);
        return jsonResponse({ billingCycleEnd: "2026-11-30T00:00:00Z", individualUsage: { plan: { totalPercentUsed: 65 } } });
      }
      if (url.startsWith("https://cursor.com/api/usage?user=user_123")) {
        return jsonResponse({ startOfMonth: "2026-11-01T00:00:00Z", "gpt-4": { numRequests: 100, maxRequestUsage: 500 } });
      }
      return jsonResponse({}, 404);
    });

    const report = await fetchPlanUsage([account("cursor")], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        env: { HOME: tmpdir(), USERPROFILE: tmpdir(), CURSOR_AUTH_TOKEN: token },
        readText: () => null,
      }),
    });
    expect(report.providers[0]).toMatchObject({
      ok: true,
      plan: "Team",
      extra: [
        expect.objectContaining({ label: "Monthly", usedPercent: 65 }),
        expect.objectContaining({ label: "Requests", usedPercent: 20 }),
      ],
    });
    expect(JSON.stringify(report)).not.toContain(token);
    expect(parseCursorDashboardUsage(null, null).extra).toEqual([]);
  });

  it("omits OpenCode Go when no Go key is configured and reads rolling/weekly/monthly when one is present", async () => {
    const idleFetch = vi.fn<PlanFetch>();
    const empty = await fetchPlanUsage([account("opencode")], {
      fetch: idleFetch,
      now: () => NOW,
      credentials: fileCredentialReader({ now: () => NOW, env: { HOME: tmpdir(), USERPROFILE: tmpdir() }, readText: () => null }),
    });
    expect(empty.providers).toEqual([]);
    expect(idleFetch).not.toHaveBeenCalled();

    const goKey = "opencode-go-secret-key";
    const fetchImpl = vi.fn<PlanFetch>(async (url, init) => {
      expect(url).toBe("https://opencode.ai/zen/go/v1/usage");
      expect(init.headers.Authorization).toBe(`Bearer ${goKey}`);
      return jsonResponse({
        usage: {
          rolling: { percent: 0, resetsAt: new Date(NOW + 5 * 3600_000).toISOString() },
          weekly: { percent: 34, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
          monthly: { percent: 12, resetsAt: new Date(NOW + 20 * 86_400_000).toISOString() },
        },
      });
    });
    const active = await fetchPlanUsage([account("opencode")], {
      fetch: fetchImpl,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        env: { HOME: tmpdir(), USERPROFILE: tmpdir() },
        readText: () => null,
        readOpenCodeDbKey: () => goKey,
      }),
    });
    expect(active.providers[0]).toMatchObject({
      ok: true,
      plan: "Go",
      fiveHour: { available: true, usedPercent: 0, resetsAt: null },
      weekly: { available: true, usedPercent: 34 },
      extra: [expect.objectContaining({ label: "Monthly", usedPercent: 12 })],
    });
    expect(JSON.stringify(active)).not.toContain(goKey);
    expect(parseOpenCodeUsage({ usage: {} }, NOW).plan).toBe("Go");
  });

  it("renews expired Codex, Grok, and expiring Cursor file credentials, honors Cursor shouldLogout, and enforces CURSOR_CONFIG_DIR isolation", async () => {
    // 1. Codex renewal
    const codexDir = makeTempDir("dusk-codex-renew-");
    const expiredCodexJwt = makeJwt({ exp: Math.floor((NOW - 60_000) / 1000) });
    const freshCodexJwt = makeJwt({
      exp: Math.floor((NOW + 86_400_000) / 1000),
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-renewed" },
    });
    const codexFile = join(codexDir, "auth.json");
    writeFileSync(codexFile, JSON.stringify({
      tokens: { access_token: expiredCodexJwt, refresh_token: "codex-old-ref", account_id: "acct-renewed" },
      keep: 1,
    }));
    const codexFetch = vi.fn<PlanFetch>(async (url) => {
      if (url === "https://auth.openai.com/oauth/token") {
        return jsonResponse({ access_token: freshCodexJwt, refresh_token: "codex-new-ref" });
      }
      return jsonResponse({
        plan_type: "plus",
        rate_limit: { primary_window: { used_percent: 15, limit_window_seconds: 18_000 } },
      });
    });
    const codexReport = await fetchPlanUsage([account("codex", { environment: { CODEX_HOME: codexDir } })], {
      fetch: codexFetch,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        writable: true,
        env: { HOME: codexDir, USERPROFILE: codexDir },
        readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
      }),
    });
    expect(codexReport.providers[0]).toMatchObject({ ok: true, fiveHour: { usedPercent: 15 } });
    expect(JSON.parse(readFileSync(codexFile, "utf8"))).toMatchObject({
      keep: 1,
      tokens: { access_token: freshCodexJwt, refresh_token: "codex-new-ref" },
    });

    // 2. Grok renewal via OIDC discovery
    const grokDir = makeTempDir("dusk-grok-renew-");
    const grokFile = join(grokDir, "auth.json");
    writeFileSync(grokFile, JSON.stringify({
      "https://auth.x.ai::grok-cli": {
        key: "grok-expired-tok",
        refresh_token: "grok-old-ref",
        expires_at: new Date(NOW - 60_000).toISOString(),
      },
    }));
    const grokFetch = vi.fn<PlanFetch>(async (url) => {
      if (url === "https://auth.x.ai/.well-known/openid-configuration") {
        return jsonResponse({ token_endpoint: "https://auth.x.ai/oauth2/token" });
      }
      if (url === "https://auth.x.ai/oauth2/token") {
        return jsonResponse({ access_token: "grok-fresh-tok", refresh_token: "grok-new-ref", expires_in: 21_600 });
      }
      if (url.includes("format=credits")) {
        return jsonResponse({ config: { creditUsagePercent: 19, currentPeriod: { type: "WEEK", end: new Date(NOW + 86_400_000).toISOString() } } });
      }
      return jsonResponse({}, 404);
    });
    const grokReport = await fetchPlanUsage([account("grok", { environment: { GROK_HOME: grokDir } })], {
      fetch: grokFetch,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        writable: true,
        env: { HOME: grokDir, USERPROFILE: grokDir },
        readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
      }),
    });
    expect(grokReport.providers[0]).toMatchObject({ ok: true, weekly: { usedPercent: 19 } });
    expect(JSON.parse(readFileSync(grokFile, "utf8"))["https://auth.x.ai::grok-cli"]).toMatchObject({
      key: "grok-fresh-tok",
      refresh_token: "grok-new-ref",
    });

    // 3. Cursor renewal rejects shouldLogout: true even on HTTP 200, and custom CURSOR_CONFIG_DIR never falls back
    const cursorDir = makeTempDir("dusk-cursor-renew-");
    const dueCursorJwt = makeJwt({ sub: "auth0|u1", exp: Math.floor((NOW + 3600_000) / 1000) });
    writeFileSync(join(cursorDir, "auth.json"), JSON.stringify({ accessToken: dueCursorJwt, refreshToken: dueCursorJwt }));
    const cursorFetch = vi.fn<PlanFetch>(async (url) => {
      if (url === "https://api2.cursor.sh/oauth/token") return jsonResponse({ shouldLogout: true }, 200);
      return jsonResponse({}, 200);
    });
    const cursorReport = await fetchPlanUsage([account("cursor", { environment: { CURSOR_CONFIG_DIR: cursorDir } })], {
      fetch: cursorFetch,
      now: () => NOW,
      credentials: fileCredentialReader({
        now: () => NOW,
        writable: true,
        env: { HOME: cursorDir, USERPROFILE: cursorDir },
        readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
        readCursorKeychain: async () => ({ accessToken: "host-keychain-must-not-be-used", refreshToken: null }),
      }),
    });
    expect(cursorReport.providers[0]).toMatchObject({ ok: false, error: "Sign in again in Cursor" });
    expect(cursorFetch).toHaveBeenCalledTimes(1);

    // 4. SQLite readers for Cursor state.vscdb and OpenCode 2 credential table
    const sqlDir = makeTempDir("dusk-sqlite-");
    const stateDbPath = join(sqlDir, "state.vscdb");
    const cursorDb = new DatabaseSync(stateDbPath);
    cursorDb.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    cursorDb.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("cursorAuth/accessToken", "ide-tok");
    cursorDb.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("cursorAuth/stripeMembershipType", "unified_pro_plus");
    cursorDb.close();
    expect(readCursorStateDb(stateDbPath)).toEqual({
      accessToken: "ide-tok",
      refreshToken: null,
      membership: "unified_pro_plus",
    });

    const ocDbPath = join(sqlDir, "opencode.db");
    const ocDb = new DatabaseSync(ocDbPath);
    ocDb.exec("CREATE TABLE credential (integration_id TEXT, active INTEGER, time_updated INTEGER, value TEXT)");
    ocDb.prepare("INSERT INTO credential VALUES (?, ?, ?, ?)").run("opencode-go", 1, 100, JSON.stringify({ key: "oc-go-db-key" }));
    ocDb.close();
    expect(readOpenCodeGoDbKey(sqlDir)).toBe("oc-go-db-key");
  });
});
