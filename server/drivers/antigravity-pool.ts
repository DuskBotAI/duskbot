export type AccountHealthStatus = "healthy" | "cooling" | "exhausted" | "unauthenticated";

export type PoolStrategy = "round-robin" | "least-used" | "priority";

export interface PooledAccountConfig {
  id: string;
  email?: string;
  profileDirectory: string;
  tokenPath: string;
  priority?: number;
}

export interface PooledAccountState extends PooledAccountConfig {
  status: AccountHealthStatus;
  coolingUntil?: number;
  lastUsedAt: number;
  requestCount: number;
  failureCount: number;
  lastError?: string;
}

export class AllAccountsExhaustedError extends Error {
  readonly earliestAvailableAt: number;
  constructor(earliestAvailableAt: number) {
    const waitSec = Math.max(1, Math.ceil((earliestAvailableAt - Date.now()) / 1000));
    super(`All accounts in the Gemini pool are currently rate-limited. Next account available in ${waitSec}s.`);
    this.name = "AllAccountsExhaustedError";
    this.earliestAvailableAt = earliestAvailableAt;
  }
}

export const DEFAULT_COOLDOWN_MS = 5 * 60_000;
export const DAILY_EXHAUSTION_MS = 24 * 60 * 60_000;

export class AntigravityAccountPool {
  readonly instanceId: string;
  private accounts = new Map<string, PooledAccountState>();
  private strategy: PoolStrategy;
  private roundRobinIndex = 0;

  constructor(instanceId: string, initialAccounts: PooledAccountConfig[] = [], strategy: PoolStrategy = "round-robin") {
    this.instanceId = instanceId;
    this.strategy = strategy;
    for (const acc of initialAccounts) {
      this.addAccount(acc);
    }
  }

  addAccount(cfg: PooledAccountConfig): void {
    this.accounts.set(cfg.id, {
      ...cfg,
      status: "healthy",
      lastUsedAt: 0,
      requestCount: 0,
      failureCount: 0,
    });
  }

  removeAccount(id: string): boolean {
    return this.accounts.delete(id);
  }

  private refreshCoolingAccounts(now = Date.now()): void {
    for (const acc of this.accounts.values()) {
      if ((acc.status === "cooling" || acc.status === "exhausted") && acc.coolingUntil && acc.coolingUntil <= now) {
        acc.status = "healthy";
        acc.coolingUntil = undefined;
        acc.lastError = undefined;
      }
    }
  }

  getActiveAccount(now = Date.now()): PooledAccountState {
    this.refreshCoolingAccounts(now);
    const healthy = Array.from(this.accounts.values()).filter((a) => a.status === "healthy");

    if (healthy.length === 0) {
      const cooling = Array.from(this.accounts.values()).filter((a) => a.coolingUntil !== undefined);
      if (cooling.length === 0) {
        throw new Error(`Gemini pool "${this.instanceId}" has no configured accounts.`);
      }
      cooling.sort((a, b) => (a.coolingUntil ?? Infinity) - (b.coolingUntil ?? Infinity));
      throw new AllAccountsExhaustedError(cooling[0].coolingUntil!);
    }

    if (this.strategy === "least-used") {
      healthy.sort((a, b) => a.requestCount - b.requestCount || a.lastUsedAt - b.lastUsedAt);
      return healthy[0];
    }

    if (this.strategy === "priority") {
      healthy.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.lastUsedAt - b.lastUsedAt);
      return healthy[0];
    }

    // Default: round-robin
    const selected = healthy[this.roundRobinIndex % healthy.length];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % healthy.length;
    return selected;
  }

  recordSuccess(accountId: string, now = Date.now()): void {
    const acc = this.accounts.get(accountId);
    if (!acc) return;
    acc.status = "healthy";
    acc.requestCount++;
    acc.lastUsedAt = now;
    acc.coolingUntil = undefined;
    acc.lastError = undefined;
  }

  recordRateLimit(
    accountId: string,
    errorText: string,
    options: { cooldownMs?: number; isDailyQuota?: boolean; now?: number } = {}
  ): { rotatedTo: PooledAccountState | null } {
    const acc = this.accounts.get(accountId);
    const now = options.now ?? Date.now();
    const cooldown = options.isDailyQuota
      ? DAILY_EXHAUSTION_MS
      : (options.cooldownMs ?? DEFAULT_COOLDOWN_MS);

    if (acc) {
      acc.status = options.isDailyQuota ? "exhausted" : "cooling";
      acc.coolingUntil = now + cooldown;
      acc.failureCount++;
      acc.lastError = errorText;
    }

    try {
      const next = this.getActiveAccount(now);
      return { rotatedTo: next };
    } catch {
      return { rotatedTo: null };
    }
  }

  getPoolSummary(now = Date.now()) {
    this.refreshCoolingAccounts(now);
    const accounts = Array.from(this.accounts.values());
    const total = accounts.length;
    const healthyCount = accounts.filter((a) => a.status === "healthy").length;
    const coolingCount = accounts.filter((a) => a.status === "cooling" || a.status === "exhausted").length;

    return {
      instanceId: this.instanceId,
      strategy: this.strategy,
      total,
      healthyCount,
      coolingCount,
      accounts: accounts.map((a) => ({
        id: a.id,
        email: a.email,
        status: a.status,
        requestCount: a.requestCount,
        failureCount: a.failureCount,
        cooldownRemainingSec: a.coolingUntil && a.coolingUntil > now ? Math.ceil((a.coolingUntil - now) / 1000) : 0,
        lastError: a.lastError,
      })),
    };
  }
}
