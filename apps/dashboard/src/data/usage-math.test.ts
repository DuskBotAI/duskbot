import assert from "node:assert/strict";
import test from "node:test";
import type { ActivityReport } from "../../../../shared/dashboard-protocol.ts";
import { emptySplit, eventsCsv, monthDays, nextMonthStart, seriesBy, usageMonth, type UsageMonth, type UsageSource } from "./usage-math.ts";

const now = new Date(2026, 10, 8, 14).getTime();

function source(days: ActivityReport["days"], shares = [5, 3, 2]): UsageSource {
  return {
    workspaceId: "mac", workspaceName: "My Mac",
    bots: shares.map((_, i) => ({ id: `bot-${i}`, name: `Bot ${i}`, model: i === 0 ? "Model A" : null })),
    activity: {
      from: "2026-10-01", to: "2026-12-01", timeZone: "Asia/Kolkata", days,
      byBot: shares.map((tokens, i) => ({ botId: `bot-${i}`, botName: `Bot ${i}`, tokens, turns: 100 - i, costUsd: null })),
      byModel: [], totals: { turns: 0, tokens: 0, costUsd: null },
    },
  };
}

test("monthDays includes local dates from the first through today", () => {
  assert.deepEqual(monthDays(new Date(2026, 10, 1, 23, 59).getTime()), ["2026-11-01"]);
  assert.deepEqual(monthDays(now), Array.from({ length: 8 }, (_, i) => `2026-11-0${i + 1}`));
  const march = monthDays(new Date(2026, 2, 15, 12).getTime());
  assert.equal(march.length, 15);
  assert.equal(march[0], "2026-03-01");
  assert.equal(march[14], "2026-03-15");
});

test("nextMonthStart returns local midnight and handles a year boundary", () => {
  assert.equal(nextMonthStart(now), new Date(2026, 11, 1).getTime());
  assert.equal(nextMonthStart(new Date(2026, 11, 31, 23, 59).getTime()), new Date(2027, 0, 1).getTime());
});

test("daily allocation preserves turns, tokens and cents in both split modes", () => {
  const days = [
    { date: "2026-11-01", turns: 7, tokens: 101, costUsd: 1.01 },
    { date: "2026-11-02", turns: 1, tokens: 3, costUsd: 0.07 },
    { date: "2026-11-08", turns: 11, tokens: 503, costUsd: 2.03 },
  ];
  for (const split of ["exact", "estimate"] as const) {
    const month = usageMonth([source(days)], now, { split });
    for (const day of days) {
      const events = month.events.filter((event) => event.date === day.date);
      assert.equal(events.reduce((sum, event) => sum + event.turns, 0), day.turns);
      assert.equal(events.reduce((sum, event) => sum + event.tokens, 0), day.tokens);
      assert.equal(events.reduce((sum, event) => sum + Math.round(event.costUsd! * 100), 0), Math.round(day.costUsd * 100));
      for (const event of events) {
        assert.ok(Number.isInteger(event.turns));
        assert.ok(Number.isInteger(event.tokens));
        assert.equal(event.model, "Mixed");
      }
    }
    assert.deepEqual(month.totals, { turns: 19, tokens: 607, costUsd: 3.11 });
    assert.equal(month.events[0]!.date, "2026-11-08");
    for (let i = 1; i < month.events.length; i++) {
      const previous = month.events[i - 1]!, event = month.events[i]!;
      assert.ok(previous.date > event.date || previous.date === event.date && previous.tokens >= event.tokens);
    }
  }
});

test("estimate uses token shares and marks only multi-bot reports estimated", () => {
  const days = [{ date: "2026-11-01", turns: 10, tokens: 100, costUsd: 1 }];
  const month = usageMonth([source(days)], now);
  assert.equal(month.estimated, true);
  assert.deepEqual(month.events.map((event) => [event.turns, event.tokens, event.costUsd]), [[5, 50, 0.5], [3, 30, 0.3], [2, 20, 0.2]]);
  assert.equal(usageMonth([source(days)], now, { split: "exact" }).estimated, false);
  const single = usageMonth([source(days, [0])], now);
  assert.equal(single.estimated, false);
  assert.deepEqual(single.totals, { turns: 10, tokens: 100, costUsd: 1 });
  assert.equal(single.events.length, 1);
});

test("exact jitter is deterministic and gives different daily shares", () => {
  const input = source([1, 2, 3].map((day) => ({ date: `2026-11-0${day}`, turns: 1000, tokens: 10000, costUsd: 100 })));
  const month = usageMonth([input], now, { split: "exact" });
  assert.deepEqual(usageMonth([input], now, { split: "exact" }), month);
  const botTokens = month.days.slice(0, 3).map((date) => month.events.find((event) => event.date === date && event.bot === "Bot 0")!.tokens);
  assert.ok(new Set(botTokens).size > 1);
  assert.notDeepEqual(month.events, usageMonth([input], now).events);
});

test("all-zero shares split equally and zero-activity rows are dropped", () => {
  const month = usageMonth([source([{ date: "2026-11-01", turns: 8, tokens: 8, costUsd: 0.08 }], [0, 0, 0])], now);
  assert.deepEqual(month.events.map((event) => [event.turns, event.tokens, event.costUsd]), [[3, 3, 0.03], [3, 3, 0.03], [2, 2, 0.02]]);
  const small = usageMonth([source([{ date: "2026-11-01", turns: 1, tokens: 1, costUsd: 1.01 }], [0, 0, 0])], now);
  assert.equal(small.events.length, 1);
  assert.deepEqual(small.totals, { turns: 1, tokens: 1, costUsd: 1.01 });
});

test("out-of-month and future days are ignored and missing reports are allowed", () => {
  const input = source([
    { date: "2026-10-31", turns: 1, tokens: 100, costUsd: 10 },
    { date: "2026-11-01", turns: 2, tokens: 20, costUsd: null },
    { date: "2026-11-09", turns: 1, tokens: 100, costUsd: 10 },
    { date: "2026-12-01", turns: 1, tokens: 100, costUsd: 10 },
  ], [1]);
  const month = usageMonth([input, { ...input, workspaceId: "missing", activity: null }], now);
  assert.equal(month.events.length, 1);
  assert.deepEqual(month.totals, { turns: 2, tokens: 20, costUsd: null });
  assert.deepEqual(usageMonth([], now).totals, { turns: 0, tokens: 0, costUsd: null });
});

test("reports without bot shares use All bots and the sole model or Mixed", () => {
  const input = source([{ date: "2026-11-01", turns: 2, tokens: 20, costUsd: null }], []);
  input.activity!.byModel = [{ model: "Only model", turns: 2, tokens: 20, costUsd: null }];
  assert.equal(usageMonth([input], now).events[0]!.model, "Only model");
  input.activity!.byModel.push({ model: "Second model", turns: 0, tokens: 0, costUsd: null });
  const month = usageMonth([input], now);
  assert.equal(month.events[0]!.bot, "All bots");
  assert.equal(month.events[0]!.model, "Mixed");
  assert.equal(month.estimated, false);
  input.activity!.byModel = [];
  assert.equal(usageMonth([input], now).events[0]!.model, "Mixed");
});

test("totals sum known costs and preserve null event costs", () => {
  const month = usageMonth([source([{ date: "2026-11-01", turns: 2, tokens: 20, costUsd: null }, { date: "2026-11-02", turns: 3, tokens: 30, costUsd: 0 }], [1])], now);
  assert.equal(month.events[1]!.costUsd, null);
  assert.equal(month.totals.costUsd, 0);
});

test("seriesBy groups workspace ids, bot names and models with day alignment", () => {
  const first = source([{ date: "2026-11-01", turns: 2, tokens: 20, costUsd: null }], [1]);
  const second = { ...source([{ date: "2026-11-02", turns: 3, tokens: 30, costUsd: null }], [1]), workspaceId: "vps", workspaceName: "My VPS" };
  first.activity!.byModel = [{ model: "Model A", turns: 2, tokens: 20, costUsd: null }];
  second.activity!.byModel = [{ model: "Model A", turns: 3, tokens: 30, costUsd: null }];
  const month = usageMonth([first, second], now);
  const workspace = seriesBy(month, "workspace");
  assert.deepEqual(workspace.map((entry) => [entry.key, entry.label]), [["vps", "My VPS"], ["mac", "My Mac"]]);
  assert.deepEqual(workspace[0]!.values, [0, 30, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(seriesBy(month, "bot"), [{ key: "Bot 0", label: "Bot 0", values: [20, 30, 0, 0, 0, 0, 0, 0] }]);
  assert.deepEqual(seriesBy(month, "model"), [{ key: "Model A", label: "Model A", values: [20, 30, 0, 0, 0, 0, 0, 0] }]);
});

test("seriesBy keeps six groups and merges the remainder beyond six", () => {
  const inputs = Array.from({ length: 8 }, (_, i) => ({ ...source([{ date: "2026-11-01", turns: 1, tokens: i + 1, costUsd: null }, { date: "2026-11-02", turns: 1, tokens: (i + 1) * 2, costUsd: null }], [1]), workspaceId: String(i), workspaceName: `Workspace ${i}` }));
  assert.equal(seriesBy(usageMonth(inputs.slice(0, 6), now), "workspace").length, 6);
  const series = seriesBy(usageMonth(inputs, now), "workspace");
  assert.deepEqual(series.map((entry) => entry.key), ["7", "6", "5", "4", "3", "other"]);
  assert.equal(series[5]!.label, "Everything else");
  assert.deepEqual(series[5]!.values, [6, 12, 0, 0, 0, 0, 0, 0]);
  const empty: UsageMonth = { days: monthDays(now), events: [], totals: { turns: 0, tokens: 0, costUsd: null }, split: { days: [], totals: emptySplit() }, estimated: false };
  assert.deepEqual(seriesBy(empty, "type"), []);
  assert.deepEqual(seriesBy(empty, "model"), []);
});

test("eventsCsv quotes RFC 4180 fields, formats cost and ends in CRLF", () => {
  const event = { date: "2026-11-01", workspaceId: "mac", workspaceName: 'Office, "Mac"', bot: "Bot\nOne", model: "Model\r\nTwo", turns: 2, tokens: 20, costUsd: null };
  const header = "Date,Workspace,Bot,Model,Turns,Tokens,Cost (USD)\r\n";
  assert.equal(eventsCsv([event, { ...event, workspaceName: "VPS", bot: "Bot", model: "Model", costUsd: 1.2 }]), header + '2026-11-01,"Office, ""Mac""","Bot\nOne","Model\r\nTwo",2,20,\r\n2026-11-01,VPS,Bot,Model,2,20,1.20\r\n');
  assert.equal(eventsCsv([]), header);
});

test("token split adds up per day and keeps older reports as not split", () => {
  const split = { input: 30, output: 10, cacheRead: 55, cacheWrite: 5 };
  const days = [
    { date: "2026-11-01", turns: 2, tokens: 100, costUsd: null, ...split },
    { date: "2026-11-03", turns: 1, tokens: 40, costUsd: null },
  ];
  const month = usageMonth([source(days)], now);
  assert.deepEqual(month.split.totals, { ...split, unsplit: 40 });
  assert.deepEqual(month.split.days[0], { ...split, unsplit: 0 });
  assert.deepEqual(month.split.days[2], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unsplit: 40 });
  const series = seriesBy(month, "type");
  assert.deepEqual(series.map((entry) => entry.label), ["input", "output", "cache read", "cache write", "not split"]);
  assert.deepEqual(series.find((entry) => entry.key === "cacheRead")!.values.slice(0, 3), [55, 0, 0]);
  assert.equal(series.reduce((sum, entry) => sum + entry.values.reduce((a, b) => a + b, 0), 0), month.totals.tokens);
  assert.deepEqual(seriesBy(usageMonth([source(days.slice(0, 1))], now), "type").map((entry) => entry.key), ["input", "output", "cacheRead", "cacheWrite"]);
});

test("historical model attribution", async (t) => {
  const now = new Date(2026, 10, 25, 12).getTime();
  const totals = { turns: 1, tokens: 1200, costUsd: 0.02 };

  function source(): UsageSource {
    return {
      workspaceId: "fixture", workspaceName: "Fixture workspace",
      bots: [{ id: "bot", name: "Fixture bot", model: "Recorded model" }],
      activity: {
        from: "2026-11-01", to: "2026-11-25", timeZone: "Asia/Kolkata",
        days: [{ date: "2026-11-24", ...totals }],
        byBot: [{ botId: "bot", botName: "Fixture bot", ...totals }],
        byModel: [{ model: "Recorded model", ...totals }], totals,
      },
    };
  }

  await t.test("current model changes cannot relabel historical rows, the chart or CSV", () => {
    const input = source();
    const before = usageMonth([input], now);
    input.bots[0]!.model = "New model";
    const after = usageMonth([input], now);

    assert.deepEqual(after, before);
    assert.equal(after.events[0]!.model, "Recorded model");
    assert.deepEqual(after.totals, totals);
    assert.deepEqual(seriesBy(after, "model"), [{ key: "Recorded model", label: "Recorded model", values: after.days.map((day) => day === "2026-11-24" ? 1200 : 0) }]);
    assert.equal(eventsCsv(after.events), "Date,Workspace,Bot,Model,Turns,Tokens,Cost (USD)\r\n2026-11-24,Fixture workspace,Fixture bot,Recorded model,1,1200,0.02\r\n");
  });

  await t.test("recorded model attribution survives an unset model or a removed bot", () => {
    const input = source();
    input.bots[0]!.model = null;
    assert.equal(usageMonth([input], now).events[0]!.model, "Recorded model");
    input.bots = [];
    assert.equal(usageMonth([input], now).events[0]!.model, "Recorded model");
  });

  await t.test("multiple bots use the sole recorded model rather than their current settings", () => {
    const input = source();
    input.bots.push({ id: "other", name: "Other bot", model: "Never used" });
    input.activity!.byBot.push({ botId: "other", botName: "Other bot", ...totals });
    const combined = { turns: 2, tokens: 2400, costUsd: 0.04 };
    input.activity!.days[0] = { date: "2026-11-24", ...combined };
    input.activity!.byModel[0] = { model: "Recorded model", ...combined };
    input.activity!.totals = combined;
    const month = usageMonth([input], now);
    assert.ok(month.events.length > 1);
    assert.ok(month.events.every((event) => event.model === "Recorded model"));
    assert.deepEqual(month.totals, combined);
  });

  await t.test("multiple recorded models do not infer daily attribution from current settings", () => {
    const input = source();
    input.activity!.byModel = ["Recorded model", "Earlier model"].map((model) => ({ model, turns: 1, tokens: 600, costUsd: 0.01 }));
    input.activity!.days[0] = { date: "2026-11-24", ...totals, turns: 2 };
    input.activity!.byBot[0] = { botId: "bot", botName: "Fixture bot", ...totals, turns: 2 };
    input.activity!.totals = { ...totals, turns: 2 };
    const month = usageMonth([input], now);
    assert.equal(month.events[0]!.model, "Mixed");
    assert.deepEqual(month.totals, { ...totals, turns: 2 });
    assert.equal(seriesBy(month, "model")[0]!.label, "Mixed");
    assert.ok(eventsCsv(month.events).includes(",Mixed,2,1200,0.02\r\n"));
  });

  await t.test("missing recorded model attribution does not fall back to current settings", () => {
    const input = source();
    input.activity!.byModel = [];
    assert.equal(usageMonth([input], now).events[0]!.model, "Mixed");
  });
});
