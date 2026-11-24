import { describe, expect, it } from "vitest";

import { callTool, type ToolCallContext } from "./agents-call.ts";

function context(answers: { api?: unknown; response?: { ok: boolean; status: number; body: Record<string, unknown> } } = {}) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const client = {
    api: async (path: string) => { calls.push({ path }); return answers.api ?? {}; },
    apiResponse: async (path: string, init: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init.body)) });
      return answers.response ?? { ok: true, status: 201, body: { resultId: "t-1", summary: "When an email arrives in Gmail from acme.com, Scout follows: Draft." } };
    },
  };
  return { calls, context: { botId: "scout", threadId: "thread-1", depth: 0, externalRuntime: false, client } as unknown as ToolCallContext };
}

describe("app events in the trigger tools", () => {
  it("sends an app_event with its filter in stored words, and says it applied", async () => {
    const { calls, context: ctx } = context();
    const result = await callTool("create_trigger", {
      when: "app_event", name: "Acme", instructions: "Draft.", app: "Gmail", event: "GMAIL_NEW_GMAIL_MESSAGE",
      filter: { from: "acme.com", subject_contains: "order", label: "" }, event_config: { interval: 15 },
    }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Created the app-event trigger “Acme” (trigger id t-1). It applied at once");
    expect(calls[0]).toEqual({ path: "/api/internal/trigger-requests", body: {
      fromBotId: "scout", fromThreadId: "thread-1", action: "create", kind: "app",
      trigger: { name: "Acme", instructions: "Draft.", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", filter: { from: "acme.com", subject: "order" }, config: { interval: 15 } },
    } });
  });

  it("refuses fields of the other kinds and a missing app or event, before anything is sent", async () => {
    const { calls, context: ctx } = context();
    expect((await callTool("create_trigger", { when: "app_event", name: "A", instructions: "B", app: "gmail", event: "X", schedule: { type: "daily", time: "09:00" } }, ctx)).text)
      .toContain("takes no schedule");
    expect((await callTool("create_trigger", { when: "app_event", name: "A", instructions: "B", app: "gmail" }, ctx)).text).toContain("Call trigger_info action=events first");
    expect((await callTool("create_trigger", { when: "schedule", name: "A", instructions: "B", app: "gmail", schedule: { type: "daily", time: "09:00" } }, ctx)).text)
      .toBe("app applies only to when=app_event.");
    expect((await callTool("create_trigger", { when: "app_event", name: "A", instructions: "B", app: "gmail", event: "X", filter: { cc: "x" } }, ctx)).text)
      .toContain("filter takes from, subject_contains, label and contains");
    expect(calls).toEqual([]);
  });

  it("lists events and names apps to connect, or says why there are none", async () => {
    const listed = await callTool("list_trigger_events", { app: "Gmail" }, context({ api: {
      apps: [{ app: "gmail", name: "Gmail", accounts: [], events: [{ event: "GMAIL_NEW_GMAIL_MESSAGE", delivery: "poll" }] }],
      notConnected: [{ app: "slack", name: "Slack" }],
    } }).context);
    expect(listed.text).toContain("GMAIL_NEW_GMAIL_MESSAGE");
    expect(listed.text).toContain("Not connected yet: Slack.");
    const none = context({ api: { apps: [], notConnected: [], unavailable: "App events need dusk bot's connected apps." } });
    expect((await callTool("list_trigger_events", {}, none.context)).text).toBe("App events need dusk bot's connected apps.");
    expect(none.calls[0]!.path).toBe("/api/internal/trigger-events?fromBotId=scout&fromThreadId=thread-1");
  });

  it("updates an app event's filter and settings through manage_trigger", async () => {
    const { calls, context: ctx } = context();
    await callTool("manage_trigger", { trigger_id: "t-1", action: "update", changes: { filter: { contains: "urgent" }, event_config: { channel_id: "C1" } } }, ctx);
    expect(calls[0]!.body).toMatchObject({ action: "update", triggerId: "t-1", changes: { filter: { text: "urgent" }, config: { channel_id: "C1" } } });
  });
});

describe("a schedule's confirmation, in the person's words", () => {
  // tomorrow at 9:00 in India, from today's date there
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(Date.now());
  const nextRunAt = Date.parse(`${today}T03:30:00Z`) + 86_400_000;
  const applied = (action: string) => context({ response: { ok: true, status: 201, body: {
    result: { resultId: "r-1" }, nextRunAt, timeZone: "Asia/Calcutta",
    summary: `${action === "create" ? "Create routine" : "Update routine"} “AI news” · weekdays at 9:00 India time · Bot’s current model, where it usually works · no run limit`,
  } } });
  const schedule = { type: "weekly", time: "09:00", weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"] };

  it("asks for what was assumed, with the time zone as people say it and the first run in words", async () => {
    const result = await callTool("create_trigger", { when: "schedule", name: "AI news", instructions: "Send five bullets of AI news.", schedule }, applied("create").context);
    expect(result.isError).toBeUndefined();
    expect(result.text).not.toContain("Asia/Calcutta");
    expect(result.text).toMatch(/tell the person what you set up and what you assumed: when it runs, saying the time zone as "India time", never as a zone id; where its results will appear \(here in this chat\); what each run covers; that the first run is tomorrow \(\w+, \w+ \d+\) at 9:00 AM India time; and that they can change, pause or stop it by saying so here\.$/);
  });

  it("says what changed and the next run for an update, and one sentence for the rest", async () => {
    const update = await callTool("manage_trigger", { trigger_id: "r-1", action: "update", changes: { schedule } }, applied("update").context);
    expect(update.text).toMatch(/Tell the person in one plain sentence what changed, saying the time zone as "India time", and that the next run is tomorrow/);
    const paused = await callTool("manage_trigger", { trigger_id: "r-1", action: "pause" }, context({ response: { ok: true, status: 201, body: { result: { resultId: "r-1" }, nextRunAt: null, timeZone: "Asia/Calcutta" } } }).context);
    expect(paused.text).toMatch(/Tell the person in one sentence what will happen\.$/);
    const hook = await callTool("create_trigger", { when: "webhook", name: "Website leads", instructions: "Add the lead to the sheet." }, context({ response: { ok: true, status: 201, body: { result: { resultId: "r-2" }, nextRunAt: null } } }).context);
    expect(hook.text).toMatch(/what will happen, and that they can change, pause or stop it by saying so here\.$/);
  });
});

describe("the trigger tool's actions", () => {
  it("updates with the fields to change at the top level, and refuses what an action cannot take, before anything is sent", async () => {
    const { calls, context: ctx } = context();
    await callTool("trigger", { action: "update", trigger_id: "t-1", name: "Inbox", run_on: null, filter: { contains: "urgent" } }, ctx);
    expect(calls[0]!.body).toEqual({ fromBotId: "scout", fromThreadId: "thread-1", action: "update", triggerId: "t-1", changes: { name: "Inbox", filter: { text: "urgent" } } });
    const refused = context();
    const text = async (args: Record<string, unknown>) => (await callTool("trigger", args, refused.context)).text;
    expect(await text({ action: "update", trigger_id: "t-1" })).toBe("The update action needs at least one supported field to change.");
    expect(await text({ action: "update", trigger_id: "t-1", when: "schedule", name: "A" })).toBe("when applies only to action=create.");
    expect(await text({ action: "pause", trigger_id: "t-1", name: "A" })).toBe("The pause action changes no fields; send them with action=update.");
    expect(await text({ action: "delete", trigger_id: "t-1" })).toBe("trigger does not delete: call delete_trigger with the trigger_id.");
    expect(await text({ action: "pause" })).toBe("trigger action=pause needs the trigger_id from trigger_info.");
    expect(await text({ action: "create", trigger_id: "t-1", when: "webhook", name: "A", instructions: "B" })).toBe("trigger_id is for a trigger that exists; leave it out to create one.");
    expect(await text({ trigger_id: "t-1" })).toContain("trigger needs action: create, or update, pause, resume or run_now");
    const deletes = async (args: Record<string, unknown>) => (await callTool("delete_trigger", args, refused.context)).text;
    expect(await deletes({})).toBe("delete_trigger needs the trigger_id from trigger_info.");
    expect(await deletes({ trigger_id: "t-1", schedule: { type: "daily", time: "09:00" } })).toBe("delete_trigger takes only trigger_id and for_bot_id.");
    expect((await callTool("trigger_info", { action: "delete" }, refused.context)).text).toBe("trigger_info action is list, events or usage.");
    expect(refused.calls).toEqual([]);
  });

  it("lists triggers or events by action", async () => {
    const listed = context({ api: { now: "2026-10-29T09:00:00Z", timeZone: "UTC", triggers: [] } });
    expect((await callTool("trigger_info", { action: "list", for_bot_id: "helper" }, listed.context)).text).toContain("This bot has no triggers.");
    expect(listed.calls[0]!.path).toBe("/api/internal/triggers?fromBotId=scout&fromThreadId=thread-1&forBotId=helper");
    const events = context({ api: { apps: [], notConnected: [] } });
    await callTool("trigger_info", { action: "events", app: "Gmail" }, events.context);
    expect(events.calls[0]!.path).toBe("/api/internal/trigger-events?fromBotId=scout&fromThreadId=thread-1&app=gmail");
  });
});

describe("delete_trigger", () => {
  it("deletes one trigger, its own or another bot's in the section, and nothing else", async () => {
    const { calls, context: ctx } = context();
    const result = await callTool("delete_trigger", { trigger_id: " t-1 ", for_bot_id: "helper" }, ctx);
    expect(result.text).toContain("Applied delete to trigger t-1 (trigger id t-1). It applied at once");
    expect(calls).toEqual([{ path: "/api/internal/trigger-requests", body: { fromBotId: "scout", fromThreadId: "thread-1", action: "delete", triggerId: "t-1", forBotId: "helper" } }]);
  });
});

describe("schedule triggers", () => {
  it("takes a once schedule that also names its timezone, keeping only the instant", async () => {
    const { calls, context: ctx } = context();
    const result = await callTool("create_trigger", { when: "schedule", name: "Stretch", instructions: "Say: Time to stretch",
      schedule: { type: "once", at: "2099-11-07T13:34:00+00:00", timeZone: "UTC" } }, ctx);
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(calls[0]!.body)).toContain(JSON.stringify({ type: "once", at: "2099-11-07T13:34:00+00:00" }));
    expect(JSON.stringify(calls[0]!.body)).not.toContain("timeZone");
  });

  it("passes a weekly time in the zone the person named, and whether they named it, for the harness to check", async () => {
    const { calls, context: ctx } = context();
    const result = await callTool("create_trigger", { when: "schedule", name: "Invoice chaser", instructions: "Chase unpaid invoices",
      schedule: { type: "weekly", time: "10:00", weekdays: ["mon", "tue", "wed", "thu", "fri"], timeZone: " Europe/London ", exact: true } }, ctx);
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(calls[0]!.body)).toContain(JSON.stringify({ type: "weekly", time: "10:00", weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"], timeZone: "Europe/London", exact: true }));
    const bad = await callTool("create_trigger", { when: "schedule", name: "x", instructions: "y", schedule: { type: "daily", time: "10:00", exact: "yes" } }, ctx);
    expect(bad.isError).toBe(true);
  });
});


describe("what runs on its own, in one list", () => {
  function routed(replies: Record<string, { ok: boolean; status: number; body: Record<string, unknown> }>) {
    const calls: string[] = [];
    const client = {
      api: async (path: string) => { calls.push(path); return { now: "2026-11-20T09:00:00Z", timeZone: "Asia/Kolkata", triggers: [{ id: "r-1", name: "Support inbox" }] }; },
      apiResponse: async (path: string) => { calls.push(path); return replies[path] ?? { ok: false, status: 404, body: {} }; },
    };
    return { calls, ctx: { botId: "scout", threadId: "thread-1", depth: 0, externalRuntime: false, client } as unknown as ToolCallContext };
  }

  it("adds the bot's background jobs and its waits in every chat after its automations", async () => {
    const { ctx } = routed({
      "/api/internal/jobs": { ok: true, status: 200, body: { text: "- Deals group watch (id j-1): running" } },
      "/api/internal/waits/all": { ok: true, status: 200, body: { text: "- w-1 · the pricing page · until it shows $12" } },
    });
    const text = (await callTool("trigger_info", { action: "list" }, ctx)).text;
    expect(text).toContain("Support inbox");
    expect(text).toContain("Background jobs (background_job):\n- Deals group watch (id j-1): running");
    expect(text).toContain("Waits, in every chat (wait_until):\n- w-1 · the pricing page");
  });

  it("leaves out a part this turn may not read instead of calling it empty, and asks nothing more for one trigger", async () => {
    const refused = routed({ "/api/internal/jobs": { ok: false, status: 403, body: { error: "not in a room" } } });
    const text = (await callTool("trigger_info", { action: "list" }, refused.ctx)).text;
    expect(text).not.toContain("Background jobs");
    expect(text).not.toContain("Waits");
    const one = routed({});
    await callTool("trigger_info", { action: "list", trigger_id: "r-1" }, one.ctx);
    expect(one.calls).toEqual(["/api/internal/triggers?fromBotId=scout&fromThreadId=thread-1&triggerId=r-1"]);
  });
});

describe("a test run", () => {
  it("asks for a run that sends nothing, and refuses test on any other action", async () => {
    const { calls, context: ctx } = context();
    const started = await callTool("trigger", { action: "run_now", trigger_id: "r-1", test: true }, ctx);
    expect(calls[0]!.body).toEqual({ fromBotId: "scout", fromThreadId: "thread-1", action: "run_now", triggerId: "r-1", test: true });
    expect(started.text).toContain("Started a test run of trigger r-1");
    expect((await callTool("trigger", { action: "pause", trigger_id: "r-1", test: true }, ctx)).text).toBe("test applies only to action=run_now.");
  });

  it("sends a webhook's or app event's sample through its real steps, and passes on a refused dry run", async () => {
    const lead = { email: "maya@loomware.co", name: "Maya" };
    for (const triggerId of ["w-1", "a-1"]) {
      const { calls, context: ctx } = context();
      const sent = await callTool("trigger", { action: "run_now", trigger_id: triggerId, payload: lead }, ctx);
      expect(calls[0]!.body).toEqual({ fromBotId: "scout", fromThreadId: "thread-1", action: "run_now", triggerId, payload: lead });
      expect(sent.text).toContain(`Sent your sample to trigger ${triggerId}: it runs its real steps`);
    }
    const refusal = "Nothing ran: a webhook's run_now runs its real steps on a sample, never a dry run. Call trigger action=run_now again with this trigger_id and payload.";
    const { context: refused } = context({ response: { ok: false, status: 400, body: { error: refusal } } });
    const result = await callTool("trigger", { action: "run_now", trigger_id: "w-1", test: true }, refused);
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining(refusal) });
    expect(result.text).not.toContain("Started a test run");
    expect((await callTool("trigger", { action: "pause", trigger_id: "w-1", payload: lead }, refused)).text).toBe("payload applies only to action=run_now on a webhook or app event.");
  });
});

describe("mail routes and usage in the trigger tools", () => {
  const recorder = (body: Record<string, unknown>) => {
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    const client = {
      api: async () => ({}),
      apiResponse: async (path: string, init: RequestInit) => {
        calls.push({ path, method: init.method, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
        return { ok: true, status: 200, body };
      },
    };
    return { calls, ctx: { botId: "scout", threadId: "thread-1", depth: 0, externalRuntime: false, client } as unknown as ToolCallContext };
  };

  it("routes mail to an automation, shows the address without a trigger, and refuses senders without one", async () => {
    const { calls, ctx } = recorder({ address: "scout-1@in.dusk.bot", routes: [{ alias: "receipts", targetId: "r1", from: ["@shop.example"] }], received: 0 });
    const routed = await callTool("trigger", { action: "email", trigger_id: "r1", email_alias: "receipts", email_from: ["@shop.example"] }, ctx);
    expect(routed.text).toContain("scout-1@in.dusk.bot");
    expect(calls[0]).toEqual({ path: "/api/internal/bot-mail?fromBotId=scout&fromThreadId=thread-1", method: "POST", body: { triggerId: "r1", alias: "receipts", from: ["@shop.example"] } });
    await callTool("trigger", { action: "email" }, ctx);
    expect(calls[1]).toMatchObject({ method: "GET" });
    expect((await callTool("trigger", { action: "email", email_from: ["a@b.c"] }, ctx)).isError).toBe(true);
    expect((await callTool("trigger", { action: "email", trigger_id: "r1" }, ctx)).isError).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("reads what the automations used", async () => {
    const { calls, ctx } = recorder({ basis: "usd", automations: [{ name: "Poller", last7Days: { runs: 90, usd: 3 } }], note: "Most used first." });
    const result = await callTool("trigger_info", { action: "usage" }, ctx);
    expect(calls[0]!.path).toBe("/api/internal/trigger-usage?fromBotId=scout&fromThreadId=thread-1");
    expect(result.text).toContain("approximate dollars");
    expect(result.text).toContain("Poller");
  });
});

describe("a schedule's plain check in the trigger tool", () => {
  it("sends check as the routine's probe, with continuity on by default", async () => {
    const { calls, context: ctx } = context();
    await callTool("trigger", { action: "create", when: "schedule", name: "Group watch", instructions: "Tell me what is new.",
      schedule: { type: "interval", every_minutes: 30 }, check: { kind: "script", command: " ./last-id.sh " } }, ctx);
    expect((calls[0]!.body as { routine: unknown }).routine).toMatchObject({ continuity: true, probe: { kind: "script", url: "", command: "./last-id.sh" } });
    await callTool("trigger", { action: "create", when: "schedule", name: "Status", instructions: "Tell me.", continuity: false,
      schedule: { type: "interval", every_minutes: 30 }, check: { kind: "page", url: "https://status.example/", selector: "#state" } }, ctx);
    expect((calls[1]!.body as { routine: unknown }).routine).toMatchObject({ continuity: false, probe: { kind: "page", url: "https://status.example/", selector: "#state" } });
  });

  it("keeps a script check's post and access", async () => {
    const { calls, context: ctx } = context();
    await callTool("trigger", { action: "create", when: "schedule", name: "Prices", instructions: "Post the prices.",
      schedule: { type: "interval", every_minutes: 60 }, check: { kind: "script", command: "./prices.sh", post: true, access: "full" } }, ctx);
    expect((calls[0]!.body as { routine: unknown }).routine).toMatchObject({ probe: { kind: "script", url: "", command: "./prices.sh", post: true, access: "full" } });
  });

  it("removes a check with clear_check and refuses a check without what it reads", async () => {
    const { calls, context: ctx } = context();
    await callTool("trigger", { action: "update", trigger_id: "r-1", clear_check: true }, ctx);
    expect((calls[0]!.body as { changes: unknown }).changes).toEqual({ probe: null });
    expect((await callTool("trigger", { action: "update", trigger_id: "r-1", check: { kind: "script" } }, ctx)).text).toContain("needs command");
    expect((await callTool("trigger", { action: "update", trigger_id: "r-1", check: { kind: "feed" } }, ctx)).text).toContain("needs url");
    expect((await callTool("trigger", { action: "create", when: "webhook", name: "A", instructions: "B", check: { kind: "feed", url: "https://a.example/f" } }, ctx)).text).toContain("takes no check");
  });
});
