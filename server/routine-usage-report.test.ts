import { describe, expect, it } from "vitest";

import { routineUsageReport } from "./routine-usage-report.ts";

const period = (runs: number, usd: number, tokens = 100) => ({ runs, usd, tokens });

describe("what is using my usage", () => {
  it("ranks a bot's automations by 30-day use, folds a routine's address into it, and leaves other bots out", () => {
    const report = routineUsageReport({
      rows: [
        { routineId: "r1", botId: "b1", name: "Poller", week: period(90, 3), month: period(300, 9) },
        { routineId: "hook-r1", botId: "b1", name: "Poller", week: period(2, 0.5), month: period(2, 0.5) },
        { routineId: "r2", botId: "b1", name: "Brief", week: period(7, 1), month: period(30, 4) },
        { routineId: "x", botId: "other", name: "Secret", week: period(1, 50), month: period(1, 50) },
      ],
      bots: new Map([["b1", "Scout"]]),
      automations: [{ id: "r1", name: "Poller", kind: "schedule", everyMinutes: 15 }, { id: "r2", name: "Brief", kind: "schedule" }],
      runsRoutine: new Map([["hook-r1", "r1"]]),
    });
    expect(report.basis).toBe("usd");
    expect(report.automations).toEqual([
      { trigger_id: "r1", bot: "Scout", name: "Poller", kind: "schedule", runsEveryMinutes: 15, last7Days: { runs: 92, usd: 3.5 }, last30Days: { runs: 302, usd: 9.5 } },
      { trigger_id: "r2", bot: "Scout", name: "Brief", kind: "schedule", last7Days: { runs: 7, usd: 1 }, last30Days: { runs: 30, usd: 4 } },
    ]);
  });

  it("reads tokens when nothing has a price, and says when no automation used anything", () => {
    const tokens = routineUsageReport({
      rows: [{ routineId: "r1", botId: "b1", name: "Gone", week: period(1, 0, 500), month: period(1, 0, 500) }],
      bots: new Map([["b1", "Scout"]]), automations: [], runsRoutine: new Map(),
    });
    expect(tokens.automations[0]).toMatchObject({ trigger_id: null, kind: "deleted", last30Days: { runs: 1, tokens: 500 } });
    expect(routineUsageReport({ rows: [], bots: new Map(), automations: [], runsRoutine: new Map() }).note).toMatch(/from chats/);
  });
});
