import { describe, expect, it } from "vitest";

import type { RoutineRequestDefinition } from "../shared/routine-request.ts";
import { duplicateOf, duplicateRefusal, endsOnReport, guardBotDefinition, jitter, jitterTime, looksOneOff, WATCH_MAX_DAYS, watchExpired } from "./routine-bot-guard.ts";

const NOW = Date.parse("2026-11-20T10:00:00Z");
const DAY = 24 * 60 * 60_000;
const ALL = [0, 1, 2, 3, 4, 5, 6];
const def = (over: Partial<RoutineRequestDefinition>): RoutineRequestDefinition => ({
  name: "Morning note", instructions: "Write me a short note.", schedule: { type: "daily", time: "09:00", weekdays: ALL }, runOn: "maus", durationMinutes: 30, ...over,
});

describe("bot routine defaults", () => {
  it("moves a time on the hour or half hour a few minutes later, the same each time", () => {
    const first = guardBotDefinition(def({}), NOW);
    const again = guardBotDefinition(def({}), NOW);
    expect(first.schedule).toEqual(again.schedule);
    const time = (first.schedule as { time: string }).time;
    expect(time).toMatch(/^09:0[2-7]$/);
    expect(jitterTime("09:30", 0)).toBe("09:32");
    expect(jitterTime("09:17", 3)).toBe("09:17");
  });

  it("keeps a time the person pinned or that is time-critical", () => {
    expect(guardBotDefinition(def({ instructions: "Remind me at 9 sharp to call the bank." }), NOW).schedule).toMatchObject({ time: "09:00" });
    expect(guardBotDefinition(def({ name: "Uptime", instructions: "Check the work site and tell me if the site is down.", schedule: { type: "interval", everyMinutes: 30 } }), NOW).schedule).not.toHaveProperty("weekdays");
    expect(guardBotDefinition(def({ name: "Digest", instructions: "Every morning, summarize urgent mail in my work inbox." }), NOW).schedule).toMatchObject({ weekdays: [1, 2, 3, 4, 5] });
  });

  it("moves a bot's own change of time again, and runs a work cron on weekdays", () => {
    expect(jitter({ type: "cron", expression: "0 18 * * *", timeZone: "UTC" }, "Plants", "Remind me to water the plants.").expression).toMatch(/^[2-7] 18 \* \* \*$/);
    expect(guardBotDefinition(def({ name: "Digest", instructions: "Summarize my work inbox and Slack.", schedule: { type: "cron", expression: "0 9 * * *", timeZone: "UTC" } }), NOW).schedule)
      .toMatchObject({ expression: expect.stringMatching(/^[2-7] 9 \* \* 1-5$/) });
  });

  it("runs work on weekdays unless it says every day or is personal", () => {
    expect(guardBotDefinition(def({ name: "Inbox brief", instructions: "Summarize my work inbox and Slack." }), NOW).schedule).toMatchObject({ weekdays: [1, 2, 3, 4, 5] });
    expect(guardBotDefinition(def({ name: "Inbox brief", instructions: "Summarize my inbox every day, weekends too." }), NOW).schedule).toMatchObject({ weekdays: ALL });
    expect(guardBotDefinition(def({ name: "Gym", instructions: "Remind me to go to the gym." }), NOW).schedule).toMatchObject({ weekdays: ALL });
    expect(guardBotDefinition(def({ name: "Leads", instructions: "List new sales leads.", schedule: { type: "daily", time: "08:15", weekdays: [1, 3] } }), NOW).schedule)
      .toMatchObject({ weekdays: [1, 3], time: "08:15" });
  });

  it("gives a one-off watch an end 30 days on, but not one that repeats", () => {
    const watch = guardBotDefinition(def({ name: "iPad watch", instructions: "Check apple.com and tell me when the new iPad ships.", schedule: { type: "interval", everyMinutes: 60 } }), NOW);
    expect(watch.schedule).toMatchObject({ endsAt: NOW + WATCH_MAX_DAYS * DAY });
    const feed = guardBotDefinition(def({ name: "HN", instructions: "Tell me every time a new post about Rust appears.", schedule: { type: "interval", everyMinutes: 60 } }), NOW);
    expect(feed.schedule).not.toHaveProperty("endsAt");
  });

  it("tells one-off watches from ongoing ones", () => {
    expect(looksOneOff("Let me know when the PS6 is back in stock")).toBe(true);
    expect(looksOneOff("Tell me when my PR gets merged")).toBe(true);
    expect(looksOneOff("Tell me whenever a new release is out")).toBe(false);
    expect(looksOneOff("Tell me when BTC drops below 50000")).toBe(false);
    expect(looksOneOff("Summarize the news")).toBe(false);
  });

  it("ends a one-off watch made from a chat once it reports, and after 30 days", () => {
    const routine = { name: "iPad", prompt: "Tell me when the new iPad ships", createdAt: NOW, sourceThreadId: "t1", schedule: { type: "interval" } };
    expect(endsOnReport(routine)).toBe(true);
    expect(endsOnReport({ ...routine, sourceThreadId: undefined })).toBe(false);
    expect(watchExpired(routine, NOW + 29 * DAY)).toBe(false);
    expect(watchExpired(routine, NOW + 30 * DAY)).toBe(true);
  });

  it("finds the bot's routine that already checks the same thing", () => {
    const existing = [
      { id: "r1", name: "Digest", prompt: "Summarize  Hacker News!", botId: "b1", enabled: true },
      { id: "r2", name: "Price", prompt: "Watch the price", botId: "b1", enabled: false, probe: { kind: "price" as const, url: "https://shop.example/x" } },
    ];
    expect(duplicateOf(existing, "b1", {})).toBeNull();
    expect(duplicateOf(existing, "b2", { probe: { kind: "price", url: "https://shop.example/x" } })).toBeNull();
    expect(duplicateOf(existing, "b1", { probe: { kind: "page", url: "https://shop.example/x" } })).toBeNull();
    expect(duplicateOf(existing, "b1", { probe: { kind: "price", url: "https://shop.example/x" } })?.id).toBe("r2");
    expect(duplicateRefusal(existing[1]!)).toContain("trigger_id r2; it is paused");
  });
});
