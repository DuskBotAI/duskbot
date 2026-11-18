import { describe, expect, it } from "vitest";

import {
  AllAccountsExhaustedError,
  AntigravityAccountPool,
  DEFAULT_COOLDOWN_MS,
  PooledAccountConfig,
} from "./antigravity-pool.ts";

describe("Antigravity / Gemini Account Pooling", () => {
  const accounts: PooledAccountConfig[] = [
    {
      id: "acc-personal",
      email: "user.personal@gmail.com",
      profileDirectory: "/tmp/antigravity/acc1",
      tokenPath: "/tmp/antigravity/acc1/acp_token.json",
      priority: 10,
    },
    {
      id: "acc-work",
      email: "user.work@company.com",
      profileDirectory: "/tmp/antigravity/acc2",
      tokenPath: "/tmp/antigravity/acc2/acp_token.json",
      priority: 5,
    },
    {
      id: "acc-backup",
      email: "backup.bot@gmail.com",
      profileDirectory: "/tmp/antigravity/acc3",
      tokenPath: "/tmp/antigravity/acc3/acp_token.json",
      priority: 1,
    },
  ];

  it("cycles through healthy accounts using round-robin", () => {
    const pool = new AntigravityAccountPool("gemini-test", accounts, "round-robin");

    const first = pool.getActiveAccount();
    const second = pool.getActiveAccount();
    const third = pool.getActiveAccount();
    const fourth = pool.getActiveAccount();

    expect(first.id).toBe("acc-personal");
    expect(second.id).toBe("acc-work");
    expect(third.id).toBe("acc-backup");
    expect(fourth.id).toBe("acc-personal");
  });

  it("prioritizes least-used accounts under least-used strategy", () => {
    const pool = new AntigravityAccountPool("gemini-test", accounts, "least-used");

    pool.recordSuccess("acc-personal");
    pool.recordSuccess("acc-personal");
    pool.recordSuccess("acc-work");

    const selected = pool.getActiveAccount();
    expect(selected.id).toBe("acc-backup");
    expect(selected.requestCount).toBe(0);
  });

  it("automatically rotates to the next healthy account on rate limit (429)", () => {
    const pool = new AntigravityAccountPool("gemini-test", accounts, "priority");

    const active = pool.getActiveAccount();
    expect(active.id).toBe("acc-personal");

    const rotation = pool.recordRateLimit("acc-personal", "429 Too Many Requests: quota exceeded");
    expect(rotation.rotatedTo?.id).toBe("acc-work");

    const nextActive = pool.getActiveAccount();
    expect(nextActive.id).toBe("acc-work");
    expect(nextActive.status).toBe("healthy");

    const summary = pool.getPoolSummary();
    expect(summary.coolingCount).toBe(1);
    const coolingAcc = summary.accounts.find((a) => a.id === "acc-personal");
    expect(coolingAcc?.status).toBe("cooling");
    expect(coolingAcc?.cooldownRemainingSec).toBeGreaterThan(0);
  });

  it("recovers cooling account once cooldown duration elapses", () => {
    const pool = new AntigravityAccountPool("gemini-test", accounts);
    const now = 1_000_000;

    pool.recordRateLimit("acc-personal", "429 Rate limited", { now, cooldownMs: 10_000 });
    expect(pool.getPoolSummary(now).coolingCount).toBe(1);

    const later = now + 15_000;
    const summary = pool.getPoolSummary(later);
    expect(summary.coolingCount).toBe(0);
    const recovered = summary.accounts.find((a) => a.id === "acc-personal");
    expect(recovered?.status).toBe("healthy");
  });

  it("throws AllAccountsExhaustedError when every account in the pool is rate-limited", () => {
    const pool = new AntigravityAccountPool("gemini-test", accounts);
    const now = Date.now();

    pool.recordRateLimit("acc-personal", "429 Rate limited", { now, cooldownMs: 30_000 });
    pool.recordRateLimit("acc-work", "429 Rate limited", { now, cooldownMs: 60_000 });
    pool.recordRateLimit("acc-backup", "429 Rate limited", { now, cooldownMs: 90_000 });

    expect(() => pool.getActiveAccount(now)).toThrow(AllAccountsExhaustedError);
  });
});
