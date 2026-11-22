import { describe, expect, it } from "vitest";

import { listTriggers, parseTriggerRequest, timelessName, triggerTarget } from "./trigger-tools.ts";
import type { Routine, RoutineRun } from "./routines.ts";
import type { WebhookTrigger } from "./webhooks.ts";

const now = Date.parse("2026-10-17T10:00:00Z");
const routine = (id: string, botId: string, prompt = "Summarize the inbox."): Routine => ({
  id, name: `Routine ${id}`, prompt, target: "bot", botId, runOn: "maus", enabled: true,
  schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30, nextRunAt: now + 3_600_000, createdAt: now, updatedAt: now,
});
const webhook = (id: string, botId: string): WebhookTrigger => ({
  id, endpointId: `wh_${id}`, name: `Hook ${id}`, prompt: "Draft a reply.", botId, runOn: "maus", enabled: true,
  createdAt: now, updatedAt: now, deliveryCount: 2, lastReceivedAt: now - 60_000,
});
const run = (id: string, routineId: string, botId: string, output = "done"): RoutineRun => ({
  id, routineId, routineName: routineId, target: "bot", botId, runOn: "maus", scheduledFor: now, status: "completed", manual: false, output, createdAt: now,
});

describe("listTriggers", () => {
  it("lists only the bot's own schedules and webhooks, each with its kind, and scrubs credentials", () => {
    const listed = listTriggers({
      botId: "bot-a", routines: [routine("r1", "bot-a", "Use token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 to check."), routine("r2", "bot-b")],
      webhooks: [webhook("w1", "bot-a"), webhook("w2", "bot-b")], runs: [run("x1", "w1", "bot-a")], timeZone: "Asia/Kolkata", now,
    });
    expect(listed).toMatchObject({ now: "2026-10-17T10:00:00.000Z", timeZone: "Asia/Kolkata" });
    expect(listed.triggers!.map((trigger) => [trigger.id, trigger.kind])).toEqual([["r1", "schedule"], ["w1", "webhook"]]);
    expect(JSON.stringify(listed)).not.toContain("sk-ant-api03");
    expect(listed.triggers![1]).toMatchObject({ calls: 2, latestRun: { id: "x1", status: "completed" } });
    // A listing never carries the address; the bot asks for it with include_address.
    expect(JSON.stringify(listed.triggers![1])).toContain("call trigger_info with this trigger_id and include_address");
    expect(listed.triggers![1]).not.toHaveProperty("address");
    expect(listed.triggers![0]).toMatchObject({ schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"] } });
  });

  it("gives one trigger with its recent fires, and says plainly when the id is not the bot's", () => {
    const runs = Array.from({ length: 12 }, (_, index) => run(`run-${index}`, "r1", "bot-a", `report ${index}`));
    const one = listTriggers({ botId: "bot-a", triggerId: "r1", routines: [routine("r1", "bot-a")], webhooks: [], runs, timeZone: "UTC", now });
    expect(one.trigger).toMatchObject({ id: "r1", kind: "schedule" });
    expect(one.trigger!.recentFires).toHaveLength(10);
    expect(listTriggers({ botId: "bot-b", triggerId: "r1", routines: [routine("r1", "bot-a")], webhooks: [], runs, timeZone: "UTC", now }).error)
      .toContain("No trigger with that id belongs to this bot");
  });
});

describe("parseTriggerRequest", () => {
  const source = { fromBotId: "bot-a", fromThreadId: "thread-a" };
  const isSchedule = (id: string) => id.startsWith("r") ? "schedule" as const : id.startsWith("a") ? "app" as const : "webhook" as const;

  it("routes a create by its kind and a change by whose id it is", () => {
    expect(parseTriggerRequest({ ...source, action: "create", kind: "schedule", routine: { name: "x" } }, isSchedule))
      .toMatchObject({ ok: true, kind: "schedule", proposal: { action: "create", routine: { name: "x" } } });
    expect(parseTriggerRequest({ ...source, action: "create", kind: "webhook", webhook: { name: "x" } }, isSchedule))
      .toMatchObject({ ok: true, kind: "webhook", operation: { action: "create", webhook: { name: "x" } } });
    expect(parseTriggerRequest({ ...source, action: "pause", triggerId: "r1" }, isSchedule))
      .toMatchObject({ ok: true, kind: "schedule", proposal: { action: "pause", routineId: "r1" } });
    expect(parseTriggerRequest({ ...source, action: "update", triggerId: "w1", changes: { name: "y" } }, isSchedule))
      .toMatchObject({ ok: true, kind: "webhook", operation: { action: "update", webhookId: "w1", changes: { name: "y" } } });
    expect(parseTriggerRequest({ ...source, action: "create", kind: "app", trigger: { name: "x" } }, isSchedule))
      .toMatchObject({ ok: true, kind: "app", operation: { action: "create", trigger: { name: "x" } } });
    expect(parseTriggerRequest({ ...source, action: "update", triggerId: "a1", changes: { filter: { from: "acme" } } }, isSchedule))
      .toMatchObject({ ok: true, kind: "app", operation: { action: "update", triggerId: "a1", changes: { filter: { from: "acme" } } } });
  });

  it("carries a test run to a schedule, and asks a webhook or app event for a sample instead of a dry run", () => {
    expect(parseTriggerRequest({ ...source, action: "run_now", triggerId: "r1", test: true }, isSchedule))
      .toEqual({ ok: true, kind: "schedule", forBotId: undefined, proposal: { action: "run_now", routineId: "r1", test: true } });
    for (const triggerId of ["w1", "a1"]) {
      for (const extra of [{}, { test: true }]) {
        const refused = parseTriggerRequest({ ...source, action: "run_now", triggerId, ...extra }, isSchedule);
        expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("Nothing ran") });
        expect(refused).toMatchObject({ error: expect.stringContaining("payload, a realistic sample") });
        expect(refused).toMatchObject({ error: expect.stringContaining("the person's own name and email") });
      }
    }
    expect(parseTriggerRequest({ ...source, action: "pause", triggerId: "r1", test: true }, isSchedule)).toMatchObject({ ok: false });
  });

  it("hands a webhook's or app event's run_now the bot's sample body, and refuses one on a schedule", () => {
    const lead = { data: { fields: [{ label: "Email", value: "maya@loomware.co" }] } };
    expect(parseTriggerRequest({ ...source, action: "run_now", triggerId: "w1", payload: lead }, isSchedule))
      .toEqual({ ok: true, kind: "webhook", forBotId: undefined, operation: { action: "run_now", webhookId: "w1" }, payload: lead });
    expect(parseTriggerRequest({ ...source, action: "run_now", triggerId: "a1", payload: lead }, isSchedule))
      .toEqual({ ok: true, kind: "app", forBotId: undefined, operation: { action: "run_now", triggerId: "a1" }, payload: lead });
    expect(parseTriggerRequest({ ...source, action: "run_now", triggerId: "r1", payload: lead }, isSchedule)).toMatchObject({ ok: false, error: expect.stringContaining("webhook") });
    expect(parseTriggerRequest({ ...source, action: "run_now", triggerId: "w1", payload: "hi" }, isSchedule)).toMatchObject({ ok: false });
    expect(parseTriggerRequest({ ...source, action: "run_now", triggerId: "w1", payload: [lead] }, isSchedule)).toMatchObject({ ok: false });
    expect(parseTriggerRequest({ ...source, action: "run_now", triggerId: "w1", payload: lead, test: true }, isSchedule)).toMatchObject({ ok: false, error: expect.stringContaining("no test") });
    expect(parseTriggerRequest({ ...source, action: "run_now", triggerId: "w1", payload: { big: "x".repeat(40_000) } }, isSchedule)).toMatchObject({ ok: false });
  });

  it("refuses a field the trigger's kind does not have, and unknown shapes", () => {
    expect(parseTriggerRequest({ ...source, action: "update", triggerId: "w1", changes: { schedule: {} } }, isSchedule))
      .toMatchObject({ ok: false, error: expect.stringContaining("has no schedule") });
    expect(parseTriggerRequest({ ...source, action: "update", triggerId: "r1", changes: { eventTypes: ["push"] } }, isSchedule))
      .toMatchObject({ ok: false });
    expect(parseTriggerRequest({ ...source, action: "update", triggerId: "a1", changes: { event: "SLACK_X" } }, isSchedule))
      .toMatchObject({ ok: false, error: expect.stringContaining("delete it and create a new one") });
    expect(parseTriggerRequest({ ...source, action: "create", kind: "email", routine: {} }, isSchedule)).toMatchObject({ ok: false });
    expect(parseTriggerRequest({ ...source, action: "create", kind: "schedule", routine: {}, extra: 1 }, isSchedule)).toMatchObject({ ok: false });
  });
});

describe("triggerTarget", () => {
  const bots = {
    a: { id: "bot-a", name: "A", section: "Ops" },
    b: { id: "bot-b", name: "B", section: "Ops" },
    c: { id: "bot-c", name: "C", section: "Sales" },
    // on a Team Cloud ownership draws the line; sidebar sections grant nothing (5199eb9df)
    d: { id: "bot-d", name: "D", section: "Ops", createdBy: "someone@else.test" },
  };
  const lookup = (id: string) => Object.values(bots).find((bot) => bot.id === id);
  it("needs no target for the sender, names any teammate whatever its section, and refuses one someone else owns", () => {
    expect(triggerTarget(bots.a, undefined, lookup)).toEqual({});
    expect(triggerTarget(bots.a, "bot-a", lookup)).toEqual({});
    expect(triggerTarget(bots.a, "bot-b", lookup)).toEqual({ forBot: { botId: "bot-b", name: "B" } });
    expect(triggerTarget(bots.a, "bot-c", lookup)).toEqual({ forBot: { botId: "bot-c", name: "C" } });
    expect(triggerTarget(bots.a, "bot-d", lookup)).toMatchObject({ status: 403 });
    expect(triggerTarget(bots.a, "bot-zzz", lookup)).toMatchObject({ status: 404 });
    expect(triggerTarget(bots.a, "  ", lookup)).toMatchObject({ status: 400 });
    // a unique name it may reach resolves like its id
    expect(triggerTarget(bots.a, "b", lookup, Object.values(bots))).toEqual({ forBot: { botId: "bot-b", name: "B" } });
    expect(triggerTarget(bots.a, "Nobody", lookup, Object.values(bots))).toMatchObject({ status: 404 });
  });
});

describe("automation names", () => {
  it("drop a day said relative to now, so the name stays true", () => {
    expect(timelessName("Calculus midterm tomorrow")).toBe("Calculus midterm");
    expect(timelessName("Call the dentist tomorrow morning")).toBe("Call the dentist");
    expect(timelessName("Rent reminder (next week)")).toBe("Rent reminder");
    expect(timelessName("History essay due December 2")).toBe("History essay due December 2");
    expect(timelessName("Weekly review")).toBe("Weekly review");
    expect(timelessName("Tomorrow")).toBe("Tomorrow");
  });
  it("are cleaned when an automation is made or renamed", () => {
    const made = parseTriggerRequest({ fromBotId: "b", fromThreadId: "t", action: "create", kind: "schedule", routine: { name: "Calculus midterm tomorrow", instructions: "x" } }, () => "schedule");
    expect(made).toMatchObject({ ok: true, proposal: { routine: { name: "Calculus midterm" } } });
    const renamed = parseTriggerRequest({ fromBotId: "b", fromThreadId: "t", action: "update", triggerId: "r1", changes: { name: "Standup today" } }, () => "schedule");
    expect(renamed).toMatchObject({ ok: true, proposal: { changes: { name: "Standup" } } });
  });
});

