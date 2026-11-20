import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSpend, runsPerWeek, validCap, type CapHit } from "./spend.ts";
import { appendUsage, flushUsageLedger, type UsageRow } from "./usage-ledger.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NOW = Date.UTC(2026, 10, 10, 12);
const HOUR = 60 * 60_000;

function dir() {
  const made = mkdtempSync(join(tmpdir(), "dusk-spend-"));
  dirs.push(made);
  return made;
}

function row(fields: Partial<UsageRow> & { botId: string }): UsageRow {
  return {
    at: new Date(NOW - HOUR).toISOString(), botName: fields.botId, threadId: "t", instanceId: "i", driverKind: "claude", model: "m",
    input: 1_000, output: 100, costUsd: 0.5, trigger: { kind: "owner" }, ...fields,
  };
}

describe("spend", () => {
  it("ranks bots and routines by their share of the last seven days, older rows left out", async () => {
    const data = dir();
    await appendUsage(data, row({ botId: "inbox", costUsd: 3, trigger: { kind: "routine", routineId: "r1", label: "News", runId: "run-1" } }));
    await appendUsage(data, row({ botId: "scout", costUsd: 1 }));
    await appendUsage(data, row({ botId: "scout", costUsd: 50, at: new Date(NOW - 8 * 24 * HOUR).toISOString() }));
    await flushUsageLedger(data);
    const spend = createSpend({ dataDir: data, now: () => NOW });
    const report = spend.battery({ bot: (id) => (id === "inbox" ? "Inbox" : undefined), routine: () => undefined });
    expect(report.basis).toBe("usd");
    expect(report.totalUsd).toBe(4);
    expect(report.rows.map((one) => [one.kind, one.name, one.share])).toEqual([
      ["bot", "Inbox", 0.75], ["routine", "News", 0.75], ["bot", "scout", 0.25],
    ]);
  });

  it("falls back to tokens when nothing in the window has a price", () => {
    const spend = createSpend({ dataDir: dir(), now: () => NOW });
    spend.booked(row({ botId: "a", costUsd: null, input: 300, output: 0 }));
    spend.booked(row({ botId: "b", costUsd: null, input: 100, output: 0 }));
    const report = spend.battery({ bot: () => undefined, routine: () => undefined });
    expect(report.basis).toBe("tokens");
    expect(report.rows.map((one) => one.share)).toEqual([0.75, 0.25]);
  });

  it("tells once when a booked turn takes a bot to its cap, and again only after it fell back under", () => {
    const data = dir();
    const hits: CapHit[] = [];
    let now = NOW;
    const spend = createSpend({ dataDir: data, now: () => now, onHit: (hit) => hits.push(hit) });
    spend.setCap({ kind: "bot", id: "inbox", usd: 1 });
    spend.booked(row({ botId: "inbox", costUsd: 0.6, at: new Date(now).toISOString() }));
    expect(hits).toEqual([]);
    spend.booked(row({ botId: "inbox", costUsd: 0.6, at: new Date(now).toISOString() }));
    spend.booked(row({ botId: "inbox", costUsd: 0.6, at: new Date(now).toISOString() }));
    expect(hits).toEqual([expect.objectContaining({ kind: "bot", id: "inbox", capUsd: 1 })]);
    expect(spend.over("inbox")).toMatchObject({ kind: "bot", capUsd: 1 });
    expect(JSON.parse(readFileSync(join(data, "spend-caps.json"), "utf8"))).toMatchObject({ bots: { inbox: 1 } });

    now += 8 * 24 * HOUR;
    expect(spend.over("inbox")).toBeNull();
    spend.booked(row({ botId: "inbox", costUsd: 0.1, at: new Date(now).toISOString() }));
    spend.booked(row({ botId: "inbox", costUsd: 1, at: new Date(now).toISOString() }));
    expect(hits).toHaveLength(2);
  });

  it("holds a routine at its own cap before its bot's", () => {
    const spend = createSpend({ dataDir: dir(), now: () => NOW });
    spend.setCap({ kind: "routine", id: "r1", usd: 0.25 });
    spend.setCap({ kind: "bot", id: "inbox", usd: 100 });
    spend.booked(row({ botId: "inbox", costUsd: 0.3, trigger: { kind: "routine", routineId: "r1", label: "News" } }));
    expect(spend.over("inbox", "r1")).toMatchObject({ kind: "routine", id: "r1", name: "News" });
    expect(spend.over("inbox", "r2")).toBeNull();
  });

  it("forecasts a routine from its schedule and its last priced runs", () => {
    const spend = createSpend({ dataDir: dir(), now: () => NOW });
    spend.booked(row({ botId: "x", costUsd: 9 }));
    for (const [runId, usd] of [["a", 0.1], ["b", 0.3]] as const) {
      spend.booked(row({ botId: "inbox", costUsd: usd, trigger: { kind: "routine", routineId: "r1", runId } }));
    }
    const forecast = spend.forecast({ id: "r1", botId: "inbox", schedule: { type: "interval", everyMinutes: 10, anchorAt: NOW } });
    expect(forecast.runsPerWeek).toBe(1_008);
    expect(forecast.perRunUsd).toBeCloseTo(0.2);
    expect(forecast.weekUsd).toBeCloseTo(201.6);
    expect(forecast.shareOfWeek).toBeCloseTo(201.6 / (9 + 201.6));
    expect(forecast.warnings).toEqual(["frequent", "costly"]);
    expect(forecast.runCosts).toEqual({ a: 0.1, b: 0.3 });
  });

  it("counts a daily schedule's runs and has no forecast price before a run has one", () => {
    expect(runsPerWeek({ type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, NOW)).toBe(5);
    expect(runsPerWeek({ type: "limit_reset", at: null } as never, NOW)).toBeNull();
    const forecast = createSpend({ dataDir: dir(), now: () => NOW }).forecast({ id: "r", botId: "b", schedule: { type: "daily", time: "09:00", weekdays: [1] } });
    expect(forecast).toMatchObject({ runsPerWeek: 1, perRunUsd: null, weekUsd: null, shareOfWeek: null, warnings: [] });
  });

  it("accepts only a positive amount or null for a cap", () => {
    expect(validCap({ kind: "bot", id: "a", usd: 2.345 })).toEqual({ kind: "bot", id: "a", usd: 2.35 });
    expect(validCap({ kind: "routine", id: "r", usd: null })).toEqual({ kind: "routine", id: "r", usd: null });
    expect(validCap({ kind: "bot", id: "a", usd: 0 })).toBeNull();
    expect(validCap({ kind: "bot", id: "../x", usd: 1 })).toBeNull();
    expect(validCap({ kind: "team", id: "a", usd: 1 })).toBeNull();
  });
});

describe("routine usage", () => {
  const routineRow = (routineId: string, runId: string, ago: number, costUsd = 0.2) =>
    row({ botId: "b", costUsd, at: new Date(NOW - ago).toISOString(), trigger: { kind: "routine", routineId, label: "Poller", runId } });

  it("reads runs and use over 7 and 30 days, counting its address's runs as its own", async () => {
    const data = dir();
    await appendUsage(data, routineRow("r", "old", 20 * 24 * HOUR, 1));
    await appendUsage(data, routineRow("r", "a", 2 * HOUR));
    await appendUsage(data, routineRow("hook", "h", 3 * HOUR));
    await appendUsage(data, routineRow("other", "o", 3 * HOUR, 5));
    await flushUsageLedger(data);
    const spend = createSpend({ dataDir: data, now: () => NOW });
    const forecast = spend.forecast({ id: "r", botId: "b", schedule: { type: "daily", time: "09:00", weekdays: [1] } }, ["hook"]);
    expect(forecast.usage?.week).toEqual({ runs: 2, usd: 0.4, tokens: 2_200 });
    expect(forecast.usage?.month.runs).toBe(3);
    expect(forecast.usage?.month.usd).toBeCloseTo(1.4);
    expect(spend.routineUsage().map((one) => [one.routineId, one.month.runs])).toEqual([["other", 1], ["r", 2], ["hook", 1]]);
  });

  it("warns once when a routine suddenly takes most of the day, and not for its steady pace", () => {
    const spikes: unknown[] = [];
    const spend = createSpend({ dataDir: dir(), now: () => NOW, onSpike: (hit) => spikes.push(hit) });
    for (let day = 1; day <= 6; day += 1) spend.booked(routineRow("steady", `s${day}`, day * 24 * HOUR + HOUR, 1));
    for (let n = 0; n < 4; n += 1) spend.booked(routineRow("steady", `t${n}`, HOUR, 0.25));
    expect(spikes).toEqual([]);
    for (let n = 0; n < 12; n += 1) spend.booked(routineRow("poller", `p${n}`, HOUR, 0.5));
    expect(spikes).toEqual([expect.objectContaining({ routineId: "poller", runs: 12 })]);
    spend.booked(routineRow("poller", "p13", HOUR, 0.5));
    expect(spikes).toHaveLength(1);
    expect(spend.forecast({ id: "poller", botId: "b", schedule: { type: "interval", everyMinutes: 15, anchorAt: NOW } }).warnings).toContain("spike");
  });
});
