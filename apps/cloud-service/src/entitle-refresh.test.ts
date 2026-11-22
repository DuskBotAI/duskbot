import { describe, expect, it, vi } from "vitest";
import type { StoredCloud } from "../../dashboard/server/clouds/types.ts";
import { homeFixture } from "./test-fixture.ts";

const HOUR = 3_600_000, MINUTE = 60_000;
const entitlements = { sign: (cloud: StoredCloud) => `token-for-${cloud.id}` };
const refused = (status: number, code: string) => Object.assign(new Error("Cloud home request failed."), { status, code });

async function runningHome() {
  const f = await homeFixture({ entitlements, linkGrant: () => "grant" });
  const { c } = await f.paid();
  expect(c.status).toBe("running");
  const pass = async (ms: number) => { f.advance(ms); c.nextAttemptAt = 0; await f.service.reconcile(); };
  return { f, c, pass };
}

describe("the hourly entitlement refresh", () => {
  it("takes the entitlement without the link grant when the push with one is refused", async () => {
    const { f, c, pass } = await runningHome();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    f.home.entitle.mockClear();
    f.home.entitle.mockImplementation(async (_o: string, _s: string, _t: string, grant?: string | null) => { if (grant) throw refused(500, "failed"); return { expiresAt: f.now() + HOUR }; });
    await pass(HOUR + MINUTE);
    expect(f.home.entitle.mock.calls.map(call => call[3] ?? null)).toEqual(["grant", null]);
    expect(c.entitledAt).toBe(f.now());
    expect(warn.mock.calls.flat().join("\n")).toContain("refused its entitlement with a link grant (http_500:failed)");
    warn.mockRestore();
  });

  it("logs the cause once, waits longer between tries, alerts once and clears when the home takes it again", async () => {
    const { f, c, pass } = await runningHome();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entitledAt = c.entitledAt;
    f.home.entitle.mockClear();
    f.home.entitle.mockRejectedValue(refused(403, "entitlement_required"));
    await pass(HOUR + MINUTE);
    expect(f.home.entitle).toHaveBeenCalledTimes(2);
    const b = c.managed as unknown as { entitleProblem: { cause: string; tries: number; retryAt: number } | null };
    expect(b.entitleProblem).toMatchObject({ cause: "http_403:entitlement_required", tries: 1, retryAt: f.now() + 2 * MINUTE });
    await pass(MINUTE);
    expect(f.home.entitle).toHaveBeenCalledTimes(2);
    for (const wait of [MINUTE, 5 * MINUTE, 10 * MINUTE]) await pass(wait);
    expect(f.home.entitle).toHaveBeenCalledTimes(8);
    expect(b.entitleProblem!.tries).toBe(4);
    expect(c.entitledAt).toBe(entitledAt);
    const lines = warn.mock.calls.flat().join("\n");
    expect(lines.match(/entitlement push to \S+ failed/g)).toHaveLength(1);
    expect(lines.match(/ALERT cloud \S+: its entitlement refresh keeps failing/g)).toHaveLength(1);
    f.home.entitle.mockResolvedValue({ expiresAt: f.now() + HOUR });
    await pass(20 * MINUTE);
    expect(b.entitleProblem).toBeNull();
    expect(c.entitledAt).toBe(f.now());
    expect(warn.mock.calls.flat().join("\n")).toContain("works again after 4 failed tries (http_403:entitlement_required)");
    warn.mockRestore();
  });
});
