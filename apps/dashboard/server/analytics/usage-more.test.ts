import { describe, expect, it } from "vitest";
import type { UsageTurn } from "../../../../shared/usage-signals.ts";
import { createUsage, memoryUsageStore } from "./usage.ts";
import { moreFocus, moreOf, type MoreInput } from "./usage-more.ts";
import { dayOf } from "./events.ts";
import type { StoredEvent } from "./sink.ts";

const NOW = Date.parse("2026-11-12T12:00:00Z"), DAY = 86_400_000;
let n = 0;
const turn = (patch: Partial<UsageTurn> = {}): UsageTurn => ({ id: `turn${String(++n).padStart(6, "0")}`, at: NOW - 3_600_000, engine: "claude", outcome: "ok", ms: 8000, tools: [], apps: [],
  category: "chat", from: "app", place: "desktop", room: false, ...patch });
const event = (name: string, props: StoredEvent["props"], accountId: string | null = "acct_a", at = NOW - 3_600_000): StoredEvent => ({ id: `ev${++n}`, name, at, accountId, props });

async function setup() {
  const store = memoryUsageStore(() => NOW);
  const usage = createUsage({ store, now: () => NOW, optedOut: () => false });
  await usage.ingest("acct_a", "ws_1", { turns: Array.from({ length: 30 }, (_, i) => turn({ apps: ["gmail"], tools: ["app"], model: "claude-sonnet-4-5", firstMs: 25_000, ms: 40_000, actions: ["gmail_send_email"], bot: "botAAAAAAA", chat: i < 20 ? "chatAAAAAA" : "chatBBBBBB",
      ...(i < 6 ? { failedApps: ["gmail"], failedTools: ["app"] as UsageTurn["tools"] } : {}) })), runs: [{ id: "run0000001", at: NOW - 1000, trigger: "schedule", outcome: "ok", ms: 30_000, every: "daily", routine: "rtnAAAAAAA" }],
  signals: [{ id: "sig0000001", at: NOW - 1000, name: "attachment", props: { kind: "pdf", size: "lt1m" } }, { id: "sig0000002", at: NOW - 1000, name: "setting_changed", props: { key: "theme" } }],
  snapshot: { bots: 3, rooms: 0, routines: 1, webhooks: 0, appEvents: 0, skills: 1, chats: 8, archived: 2, memory: 2, botEngines: { claude: 2, codex: 1 } } });
  await store.routine({ workspaceId: "ws_old", accountId: "acct_b", routine: "rtnOLDAAAA", first: NOW - 20 * DAY, last: NOW - 19 * DAY });
  return store;
}

describe("the deeper usage answer", () => {
  it("rolls the richer records into reliability, engagement, bots, apps and routines", async () => {
    const store = await setup(), days = [dayOf(NOW)];
    const daily = new Map((await store.daily(days[0]!, days[0]!)).map(row => [row.day, row.c]));
    const input: MoreInput = { days, daily, people: await store.people(days[0]!, days[0]!), snapshots: await store.snapshots(), routines: await store.routines(), from: NOW - DAY, to: NOW + DAY, now: NOW,
      accounts: [{ id: "acct_a", createdAt: NOW - 10 * DAY }], wake: { count: 12, p50Ms: 6000, p90Ms: 20_000 },
      events: [
        event("app_open", { kind: "desktop", platform: "darwin", appVersion: "0.2.15" }), event("app_close", { ms: 600_000 }),
        event("app_action", { name: "env", os: "darwin", arch: "arm64", locale: "en", screen: "m", theme: "dark", skin: "grok_dark", notifications: "granted", hour: 9 }),
        event("app_feature", { feature: "routine_created" }, "acct_a", NOW - 7 * DAY),
        ...["connected", "failed", "failed", "timed_out", "failed"].map(result => event("app_action", { name: "connector_connect", app: "notion", result })),
        event("engine_sign_in", { engine: "codex", outcome: "started" }), event("engine_sign_in", { engine: "codex", outcome: "failed", reason: "auth" }),
        ...Array.from({ length: 4 }, () => event("engine_sign_in", { engine: "codex", outcome: "started" })),
      ],
      billing: { checkouts: Array.from({ length: 6 }, (_, i) => ({ accountId: "acct_a", status: i < 1 ? "completed" : "expired", createdAt: NOW - 1000 })),
        subscriptions: [{ accountId: "acct_a", totalCents: 900, createdAt: NOW - 40 * DAY, status: "ended" }, { accountId: "acct_a", totalCents: 2900, createdAt: NOW - 1000, status: "active" }],
        feedback: [{ answer: "price", at: NOW - 1000 }] } };
    const m = moreOf(input);
    expect(m.reliability.models[0]).toMatchObject({ key: "claude-sonnet-4-5", turns: 30, firstP50: 30_000 });
    expect(m.reliability.toolErrors.find(row => row.kind === "app" && row.key === "gmail")).toMatchObject({ errors: 6, turns: 30, rate: 0.2 });
    expect(m.reliability.wake).toMatchObject({ count: 12, p50Ms: 6000 });
    expect(m.engagement).toMatchObject({ turnsPerChat: 10, attachments: [{ key: "pdf", count: 1 }], settings: [{ key: "theme", count: 1 }], archivedShare: 0.2, sessionMedianMs: 600_000 });
    expect(m.engagement.hours[9]).toBe(1);
    expect(m.bots).toMatchObject({ perPerson: 3, topBotShare: 1, engines: [{ key: "claude", count: 2 }, { key: "codex", count: 1 }] });
    expect(m.apps.actions).toEqual([{ key: "gmail_send_email", count: 30 }]);
    expect(m.apps.connects[0]).toMatchObject({ key: "notion", total: 5, good: 1, rate: 0.2 });
    expect(m.routines).toMatchObject({ every: [{ key: "daily", total: 1, good: 1 }], survival: { eligible: 1, survived: 0, share: 0 } });
    expect(m.money).toMatchObject({ checkouts: { started: 6, paid: 1, abandoned: 5 }, cancelReasons: [{ key: "price", count: 1 }], upgrades: 1, downgrades: 0 });
    expect(m.setup.signIn[0]).toMatchObject({ key: "codex", total: 5, bad: 1, reason: "auth" });
    expect(m.discovery[0]).toMatchObject({ feature: "routine_created", people: 1, medianDays: 3 });
    expect(m.setups.locale).toEqual([{ key: "en", count: 1 }]);
    expect(m.setups.version).toEqual([{ key: "0.2.15", count: 1 }]);

    const focus = moreFocus(m).map(item => item.text);
    expect(focus).toContain("only 0% of codex sign-ins finish (mostly sign-in expired or was refused): people can't even start there.");
    expect(focus).toContain("83% of checkouts are left unpaid (5 of 6): look at the checkout step.");
    expect(focus).toContain("connecting notion works 20% of the time: fix the connect flow.");
    expect(focus).toContain("the first reply takes 30 s for half of turns: people wait before seeing anything.");
    expect(focus).toContain("connected app calls error in 20% of the turns that use it.");
  });

  it("rolls the app's account sign-in into a funnel by install, attempts by way, and error codes", () => {
    const signIn = (install: string, props: StoredEvent["props"]): StoredEvent => ({ ...event("app_action", { name: "account_sign_in", ...props }, null), ctx: { install } });
    const m = moreOf({ days: [dayOf(NOW)], daily: new Map(), people: [], snapshots: [], routines: [], from: NOW - DAY, to: NOW + DAY, now: NOW, accounts: [],
      billing: { checkouts: [], subscriptions: [], feedback: [] },
      events: [
        ...["i1", "i1", "i2", "i3"].map(install => signIn(install, { step: "shown" })),
        signIn("i1", { step: "method", method: "google", via: "browser" }), signIn("i1", { step: "handoff", method: "google", via: "browser" }), signIn("i1", { step: "returned", method: "google", via: "browser" }),
        signIn("i2", { step: "method", method: "email", via: "code" }), signIn("i2", { step: "error", method: "email", via: "code", code: "wrong_code" }),
        signIn("i3", { step: "skipped" }), event("app_action", { name: "account_sign_in" }, null),
      ] });
    expect(m.setup.account.steps).toEqual([{ step: "shown", reached: 3 }, { step: "method", reached: 2 }, { step: "handoff", reached: 1 }, { step: "returned", reached: 1 },
      { step: "cancelled", reached: 0 }, { step: "skipped", reached: 1 }, { step: "error", reached: 1 }, { step: "back", reached: 0 }]);
    expect(m.setup.account.methods).toEqual([{ key: "google", total: 1, good: 1, bad: 0, rate: 1 }, { key: "email", total: 1, good: 0, bad: 1, rate: 0 }]);
    expect(m.setup.account.errors).toEqual([{ key: "wrong_code", count: 1 }]);
  });

  it("joins the app's account step, the website's sign-in and onboarding, and the way back into one funnel with times", () => {
    const T = NOW - 3_600_000, s = 1000;
    const app = (props: StoredEvent["props"], at: number, accountId: string | null = null): StoredEvent => ({ ...event("app_action", props, accountId, T + at * s), ctx: { install: "inst_one", session: "app_ses_1" } });
    const web = (name: string, props: StoredEvent["props"], at: number, accountId: string | null = "acct_h"): StoredEvent => ({ ...event(name, props, accountId, T + at * s), ctx: { session: "tab_1" } });
    const m = moreOf({ days: [dayOf(NOW)], daily: new Map(), people: [], snapshots: [], routines: [], from: NOW - DAY, to: NOW + DAY, now: NOW, accounts: [],
      billing: { checkouts: [], subscriptions: [], feedback: [] },
      events: [
        app({ name: "account_sign_in", step: "shown" }, 0),
        // a google try given up on first: the email that worked is what the next steps are timed from
        app({ name: "account_sign_in", step: "method", method: "google", via: "browser" }, 2), app({ name: "account_sign_in", step: "handoff", method: "google", via: "browser" }, 3),
        app({ name: "account_sign_in", step: "method", method: "email", via: "link" }, 10),
        app({ name: "account_sign_in", step: "handoff", method: "email", via: "link" }, 11),
        // the website before it is signed in: only its tab, joined later through the same tab signed in
        web("page_view", { path: "/sign-in" }, 41, null),
        app({ name: "account_sign_in", step: "returned", method: "email", via: "link" }, 50, "acct_h"), app({ name: "onboarding_step", step: "place" }, 52, "acct_h"),
        web("onboarding_step", { step: "name", from: "app" }, 47), web("onboarding_step", { step: "plan", ms: 9000, from: "app" }, 56),
        web("onboarding_step", { step: "app", ms: 4000, from: "app" }, 60), web("app_return", { link: "open", how: "auto" }, 61),
        app({ name: "account_sign_in", step: "back", link: "open" }, 62, "acct_h"),
        // someone who signed up on the website alone is not in this funnel
        { ...event("onboarding_step", { step: "name" }, "acct_other", T), ctx: { session: "tab_2" } },
      ] });
    const row = (step: string) => m.setup.handoff.find(item => item.step === step)!;
    expect(row("shown")).toMatchObject({ reached: 1, medianMs: null });
    expect(row("method")).toMatchObject({ reached: 1, medianMs: 2000 });
    expect(row("handoff")).toMatchObject({ side: "app", reached: 1, medianMs: 1000 });
    expect(row("landed")).toMatchObject({ side: "web", reached: 1, medianMs: 30_000 });
    expect(row("signed_in")).toMatchObject({ reached: 1, medianMs: 39_000 });
    expect(row("name")).toMatchObject({ reached: 1, medianMs: 6000 });
    expect(row("plan")).toMatchObject({ reached: 1, medianMs: 9000 });
    expect(row("checkout")).toMatchObject({ reached: 0, medianMs: null });
    expect(row("all_set")).toMatchObject({ reached: 1, medianMs: 4000 });
    expect(row("sent_back")).toMatchObject({ reached: 1, medianMs: 1000 });
    expect(row("back")).toMatchObject({ side: "app", reached: 1, medianMs: 1000 });
    expect(row("app_place")).toMatchObject({ reached: 1, medianMs: 2000 });
  });
});

describe("tool failures", () => {
  it("counts turns, calls and people per tool and class, with bad arguments last, next to turns from older workspaces", async () => {
    const store = memoryUsageStore(() => NOW);
    const usage = createUsage({ store, now: () => NOW, optedOut: () => false });
    const clicked = { toolFailures: [{ tool: "computer.click", error: "timeout" as const, count: 2 }, { tool: "computer.click", error: "schema_invalid" as const, count: 5 }] };
    await usage.ingest("acct_a", "ws_1", { turns: [turn({ tools: ["computer"], ...clicked }), turn({ tools: ["computer"], ...clicked }), turn({ tools: ["browser"], failedTools: ["browser"] })], runs: [] });
    await usage.ingest("acct_b", "ws_2", { turns: [turn({ tools: ["browser"], toolFailures: [{ tool: "browser.navigate", error: "bot_wall", count: 1 }] })], runs: [] });
    await usage.ingest("acct_c", "ws_3", { turns: [turn({ tools: ["computer"], toolFailures: [{ tool: "computer.click", error: "timeout", count: 1 }] })], runs: [] });
    const days = [dayOf(NOW)], daily = new Map((await store.daily(days[0]!, days[0]!)).map(row => [row.day, row.c]));
    const m = moreOf({ days, daily, people: await store.people(days[0]!, days[0]!), snapshots: [], routines: [], from: NOW - DAY, to: NOW + DAY, now: NOW, accounts: [], events: [],
      billing: { checkouts: [], subscriptions: [], feedback: [] } });
    expect(m.reliability.toolFailures).toEqual([
      { tool: "computer.click", error: "timeout", turns: 3, calls: 5, people: 2 },
      { tool: "browser.navigate", error: "bot_wall", turns: 1, calls: 1, people: 1 },
      { tool: "computer.click", error: "schema_invalid", turns: 2, calls: 10, people: 1 },
    ]);
    expect(m.reliability.toolErrors.find(row => row.kind === "tool" && row.key === "browser")).toMatchObject({ errors: 1 });
  });
});
