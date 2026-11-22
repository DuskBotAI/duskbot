// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppTrigger } from "@/lib/app-triggers";
import type { Routine } from "@/lib/routines";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  api: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  api: (...args: unknown[]) => fixture.api(...args),
}));
const copied = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock("@/lib/copy-text", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/copy-text")>(),
  copyText: async (text: string) => { copied.texts.push(text); return "copied"; },
}));

const { BotRoutines } = await import("./BotRoutines");
const { applyAppTriggerSnapshot } = await import("@/lib/app-triggers");

const now = Date.now();
const scout = { id: "bot-a", name: "Scout", color: "green", threadId: "thread-a", hidden: false, messages: [], tasks: [{ threadId: "thread-r", title: "Inbox digests" }] } as unknown as Bot;
const routine: Routine = {
  id: "routine-1", name: "Morning summary", prompt: "Send me a summary of my inbox.", target: "bot", botId: "bot-a", runOn: "maus", enabled: true,
  schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, durationMinutes: 30, nextRunAt: now + 3_600_000, createdAt: now, updatedAt: now,
};
const webhook = { id: "hook-1", endpointId: "wh_abc", name: "Sales form leads", prompt: "Draft a follow-up for the lead.", botId: "bot-a", runOn: "maus", enabled: true, createdAt: now, updatedAt: now, deliveryCount: 1 };
const acme: AppTrigger = {
  id: "acme", name: "Acme replies", prompt: "Draft a reply.", botId: "bot-a", runOn: "maus", enabled: true, app: "gmail", appName: "Gmail",
  event: "GMAIL_NEW_GMAIL_MESSAGE", eventName: "New Gmail message", delivery: "poll", accountId: "ca_1", config: { query: "from:acme.com" },
  filter: { from: "acme.com" }, remote: { triggerId: "ti_1", state: "active" }, received: 1, filtered: 0, createdAt: now, updatedAt: now,
};

let root: Root | null = null;
let container: HTMLElement;
const render = () => flushSync(() => root!.render(createElement(BotRoutines, { bot: scout })));
/** The card, re-rendered from the store each time it changes, as the app's provider would. */
function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  render();
}
const row = (id: string) => container.querySelector<HTMLElement>(`[data-panel-routine="${id}"]`)!;
const open = (id: string) => flushSync(() => row(id).querySelector<HTMLButtonElement>("button[aria-haspopup=dialog]")!.click());
/** a routine's details and actions open in a small sheet over the panel, never inside the list */
const sheet = () => [...document.querySelectorAll<HTMLElement>('[data-panel-modal="routine"]')].find((el) => !el.closest("[data-leaving]"))!;
const action = (_id: string, name: string) => sheet().querySelector<HTMLButtonElement>(`[data-routine-action="${name}"]`)!;
const writes = () => fixture.api.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method).map(([path, init]) => {
  const { method, body } = init as { method: string; body?: string };
  return [path, method, body ? JSON.parse(body) : undefined];
});
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
  setter.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  fixture.api.mockReset();
  fixture.api.mockResolvedValue({});
  fixture.dispatch.mockReset();
  fixture.dispatch.mockImplementation((next: { type: string; routine?: Routine; routineId?: string }) => {
    const routines = fixture.state.routines as Routine[];
    if (next.type === "routinePatched") fixture.state.routines = routines.some((item) => item.id === next.routine!.id) ? routines.map((item) => (item.id === next.routine!.id ? next.routine : item)) : [...routines, next.routine];
    if (next.type === "routineDeleted") fixture.state.routines = routines.filter((item) => item.id !== next.routineId);
    if (next.type === "routinePatched" || next.type === "routineDeleted") render();
  });
  fixture.state = { hydrated: true, bots: [scout], groups: [], routines: [routine], webhooks: [], webhookAttempts: [], routineRuns: [], routinesLoadState: "ready", routinesFocus: { nonce: 0 }, config: {} };
  applyAppTriggerSnapshot({ triggers: [], attempts: [], service: { available: true, plan: "desktop", eventsPerDay: 500, eventsToday: 0 } });
});
afterEach(() => { root?.unmount(); root = null; document.body.innerHTML = ""; copied.texts = []; });

describe("a bot's routines in its panel", () => {
  it("lists each by name and when, and opens one in a sheet with what the bot knows about it, the row staying short", () => {
    fixture.state.routines = [{ ...routine, resultsThreadId: "thread-r", checks: ["mail"] }];
    fixture.state.routineRuns = [{ id: "run-1", routineId: "routine-1", routineName: "Morning summary", target: "bot", botId: "bot-a", runOn: "maus", scheduledFor: now - 60_000, startedAt: now - 60_000, status: "completed", manual: false, output: "Three new emails, none urgent.", threadId: "thread-x", createdAt: now - 60_000 }];
    mount();
    expect(row("routine-1").textContent).toBe("Morning summaryEvery day at 9 AM");
    expect(row("routine-1").querySelector("[role=switch]")!.getAttribute("aria-checked")).toBe("true");
    open("routine-1");
    expect(row("routine-1").textContent).toBe("Morning summaryEvery day at 9 AM");
    const text = sheet().textContent!;
    for (const part of ["When", "Every day at 9 AM", "Next:", "What to do", "Send me a summary of my inbox.", "Works on", "This computer", "Results go to", "Inbox digests", "Uses", "New mail", "Recent runs", "Three new emails, none urgent."]) expect(text).toContain(part);
    flushSync(() => sheet().querySelector<HTMLButtonElement>("[data-routine-run]")!.click());
    expect(fixture.dispatch).toHaveBeenCalled();
  });

  it("says what a waiting run waits on; Answer opens its chat, and says so when nothing there waits on the person", () => {
    const waiting = { id: "run-w", routineId: "routine-1", routineName: "Morning summary", target: "bot", botId: "bot-a", runOn: "maus", scheduledFor: now - 60_000, startedAt: now - 60_000,
      status: "waiting", manual: false, attention: "Which inbox should I read?", threadId: "thread-r", createdAt: now - 60_000 };
    fixture.state.routineRuns = [waiting];
    mount();
    open("routine-1");
    expect(sheet().textContent).toContain("Which inbox should I read?");
    expect(sheet().textContent).not.toContain("It's waiting for your answer.");
    flushSync(() => action("routine-1", "fix").click());
    expect(fixture.dispatch.mock.calls.map(([next]) => next)).toEqual([
      { type: "switchTask", botId: "bot-a", threadId: "thread-r" },
      { type: "notice", notice: { kind: "note", botName: "Scout", text: "Nothing in its chat is waiting for your answer now." } },
    ]);
    fixture.dispatch.mockClear();
    fixture.state.bots = [{ ...scout, tasks: [{ threadId: "thread-r", title: "Inbox digests", activity: "waiting-on-you" }] }];
    render();
    flushSync(() => action("routine-1", "fix").click());
    expect(fixture.dispatch.mock.calls.map(([next]) => next)).toEqual([{ type: "switchTask", botId: "bot-a", threadId: "thread-r" }]);
  });

  it("is not Needs you while a run waits on nothing it names", () => {
    fixture.state.routineRuns = [{ id: "run-w", routineId: "routine-1", routineName: "Morning summary", target: "bot", botId: "bot-a", runOn: "maus", scheduledFor: now - 60_000,
      startedAt: now - 60_000, status: "waiting", manual: false, threadId: "thread-r", createdAt: now - 60_000 }];
    mount();
    open("routine-1");
    expect(action("routine-1", "fix")).toBeNull();
    expect(sheet().textContent).not.toContain("It's waiting for your answer.");
  });

  it("edits name, when and what in its sheet, and keeps a schedule no preset can say", async () => {
    fixture.state.routines = [{ ...routine, schedule: { type: "cron", expression: "0 9 1 * *", timeZone: "UTC" } as Routine["schedule"] }];
    fixture.api.mockImplementation(async (_path: unknown, init: unknown) => ({ routine: { ...(fixture.state.routines as Routine[])[0], ...JSON.parse((init as { body: string }).body), updatedAt: now + 1 } }));
    mount();
    open("routine-1");
    flushSync(() => action("routine-1", "edit").click());
    const form = sheet().querySelector("form")!;
    expect(form.querySelector<HTMLInputElement>("input:not([type])")!.value).toBe("Morning summary");
    expect(form.querySelector("input[data-routine-time]")).toBeNull();
    flushSync(() => type(form.querySelector<HTMLInputElement>("input:not([type])")!, "Monthly summary"));
    flushSync(() => form.querySelector<HTMLButtonElement>("button[type=submit]")!.click());
    await vi.waitFor(() => expect(sheet().querySelector("form")).toBeNull());
    expect(writes()).toEqual([["/api/routines/routine-1", "PATCH", { name: "Monthly summary", prompt: "Send me a summary of my inbox." }]]);
    expect(row("routine-1").textContent).toContain("Monthly summary");
  });

  it("gives focus back to the sheet's Edit after saving or cancelling, so one Escape closes only the sheet", async () => {
    fixture.api.mockImplementation(async (_path: unknown, init: unknown) => ({ routine: { ...routine, ...JSON.parse((init as { body: string }).body), updatedAt: now + 1 } }));
    mount();
    open("routine-1");
    flushSync(() => action("routine-1", "edit").click());
    flushSync(() => sheet().querySelector<HTMLButtonElement>("button[type=submit]")!.click());
    await vi.waitFor(() => expect(sheet().querySelector("form")).toBeNull());
    expect(document.activeElement).toBe(action("routine-1", "edit"));
    flushSync(() => action("routine-1", "edit").click());
    const cancel = [...sheet().querySelectorAll<HTMLButtonElement>("form button[type=button]")].find((button) => button.textContent === "Cancel")!;
    flushSync(() => cancel.click());
    expect(document.activeElement).toBe(action("routine-1", "edit"));
  });

  it("says what is missing instead of saving a one-time routine in the past", () => {
    mount();
    open("routine-1");
    flushSync(() => action("routine-1", "edit").click());
    const form = sheet().querySelector("form")!;
    expect(form.querySelector("[data-panel-select=routine-when]")!.textContent).toContain("Every day");
    flushSync(() => type(form.querySelector("textarea")!, "   "));
    flushSync(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(form.querySelector("[role=alert]")!.textContent).toBe("Say what it should do.");
    expect(writes()).toEqual([]);
  });

  it("runs now, pauses with the switch, and deletes only after a second press", async () => {
    fixture.api.mockImplementation(async (path: unknown, init: unknown) => {
      if (String(path).endsWith("/run")) return { run: { id: "run-9" } };
      const body = (init as { body?: string } | undefined)?.body;
      return body ? { routine: { ...routine, ...JSON.parse(body), updatedAt: now + 2 } } : { ok: true };
    });
    fixture.dispatch.mockImplementation((next: { type: string; routineId?: string; onStarted?: () => void; routine?: Routine }) => {
      if (next.type === "runRoutine") { void fixture.api(`/api/routines/${next.routineId}/run`, { method: "POST" }); next.onStarted?.(); }
      if (next.type === "routinePatched") { fixture.state.routines = [next.routine]; render(); }
      if (next.type === "routineDeleted") { fixture.state.routines = []; render(); }
    });
    mount();
    open("routine-1");
    flushSync(() => action("routine-1", "run").click());
    await vi.waitFor(() => expect(action("routine-1", "run").disabled).toBe(false));
    flushSync(() => row("routine-1").querySelector<HTMLButtonElement>("[role=switch]")!.click());
    await vi.waitFor(() => expect(row("routine-1").querySelector("[role=switch]")!.getAttribute("aria-checked")).toBe("false"));
    await vi.waitFor(() => expect(action("routine-1", "delete").disabled).toBe(false));
    flushSync(() => action("routine-1", "delete").click());
    expect(writes().some(([, method]) => method === "DELETE")).toBe(false);
    flushSync(() => action("routine-1", "confirm-delete").click());
    await vi.waitFor(() => expect(row("routine-1")).toBeNull());
    expect(writes()).toEqual([
      ["/api/routines/routine-1/run", "POST", undefined],
      ["/api/routines/routine-1", "PATCH", { enabled: false }],
      ["/api/routines/routine-1", "DELETE", undefined],
    ]);
  });

  it("says why beside a closed routine when turning it on is refused, and keeps it off", async () => {
    fixture.state.routines = [{ ...routine, enabled: false, nextRunAt: null }];
    fixture.api.mockRejectedValue(new Error("The assigned bot no longer exists"));
    mount();
    expect(row("routine-1").textContent).toContain("Paused");
    flushSync(() => row("routine-1").querySelector<HTMLButtonElement>("[role=switch]")!.click());
    await vi.waitFor(() => expect(row("routine-1").querySelector("[role=alert]")?.textContent).toBe("The assigned bot no longer exists"));
    expect(row("routine-1").querySelector("[role=switch]")!.getAttribute("aria-checked")).toBe("false");
  });

  it("offers no switch for a one-time routine that already happened", () => {
    fixture.state.routines = [{ ...routine, enabled: false, nextRunAt: null, schedule: { type: "once", at: now - 60_000 } }];
    mount();
    expect(row("routine-1").querySelector("[role=switch]")).toBeNull();
    open("routine-1");
    expect(sheet().textContent).toContain("Its time has passed. Edit it to pick a new time.");
  });

  it("lists the bot's other automations too: a webhook copies its address, an app event runs through its own routes", async () => {
    fixture.state.webhooks = [webhook];
    applyAppTriggerSnapshot({ triggers: [acme], attempts: [], service: { available: true, plan: "desktop", eventsPerDay: 500, eventsToday: 0 } });
    fixture.api.mockImplementation(async (path: unknown) => (String(path).endsWith("/address") ? { credential: { url: "https://hooks.example/wh_abc?key=s" } } : {}));
    mount();
    expect(row("hook-1").textContent).toContain("When another app sends something");
    open("hook-1");
    flushSync(() => [...sheet().querySelectorAll("button")].find((button) => button.textContent === "Copy address")!.click());
    await vi.waitFor(() => expect(copied.texts).toEqual(["https://hooks.example/wh_abc?key=s"]));
    open("acme");
    flushSync(() => action("acme", "run").click());
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledWith("/api/app-triggers/acme/test", expect.objectContaining({ method: "POST" })));
  });

  it("lists a webhook's recent deliveries, refused ones with why, and never a refused delivery's body", () => {
    fixture.state.webhooks = [webhook];
    const attempt = (id: string, at: number, extra: Record<string, unknown>) => ({ id, webhookId: "hook-1", receivedAt: now - at, ...extra });
    fixture.state.webhookAttempts = [
      attempt("a1", 60_000, { outcome: "accepted", statusCode: 202, preview: "{\"lead\":\"ok\"}" }),
      attempt("a2", 50_000, { outcome: "rejected", statusCode: 401, reason: "Invalid webhook URL or secret (2 requests)" }),
      attempt("a3", 40_000, { outcome: "rejected", statusCode: 400, reason: "Invalid JSON webhook body", preview: "PRIVATE-BODY" }),
      attempt("a4", 30_000, { outcome: "rejected", statusCode: 413, reason: "Webhook body is too large" }),
      { id: "other", webhookId: "hook-2", receivedAt: now, outcome: "rejected", statusCode: 401 },
    ];
    mount();
    open("hook-1");
    const lines = [...sheet().querySelectorAll<HTMLElement>("[data-webhook-delivery]")];
    expect(lines.map((line) => line.dataset.webhookDelivery)).toEqual(["refused", "refused", "refused", "ok"]);
    const text = lines.map((line) => line.textContent).join("\n");
    expect(text).toContain("Refused: too large");
    expect(text).toContain("Refused: not valid JSON");
    expect(text).toContain("Refused: wrong or missing secret · 2 requests");
    expect(text).toContain("Accepted");
    expect(sheet().textContent).not.toContain("PRIVATE-BODY");
    expect(sheet().textContent).not.toContain("Invalid webhook URL");
  });

  it("opens the routine a chat card names, straight into its form when asked", async () => {
    mount();
    fixture.state.routinesFocus = { routineId: "routine-1", edit: true, nonce: 1 };
    render();
    await vi.waitFor(() => expect(row("routine-1").dataset.routineOpen).toBe("true"));
    expect(sheet().querySelector("form")).not.toBeNull();
  });

  it("says what a routine is when the bot has none and points to the chat, with no add button", () => {
    fixture.state.routines = [];
    mount();
    expect(container.textContent).toContain("Ask it in chat to set one up");
    expect(container.querySelector("[data-panel-action=new-routine]")).toBeNull();
  });

  it("shows its 7- and 30-day usage, slows a spiking poller with one tap, and gives the routine its own address", async () => {
    const poller = { ...routine, schedule: { type: "interval" as const, everyMinutes: 15, anchorAt: now } };
    fixture.state.routines = [poller];
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    fixture.api.mockImplementation(async (...args: unknown[]) => {
      const [path, init] = args as [string, { method?: string; body?: string } | undefined];
      if (path.endsWith("/forecast")) return { runsPerWeek: 672, perRunUsd: 0.02, weekUsd: 13.44, shareOfWeek: 0.4, warnings: ["frequent", "spike"], runCosts: {}, spentUsd: 2,
        usage: { week: { runs: 96, usd: 1.92, tokens: 1 }, month: { runs: 300, usd: 6, tokens: 1 } } };
      if (path.startsWith("/api/webhooks/mail/")) return { mail: { address: "scout-1@in.dusk.bot", routes: [{ alias: "receipts", targetId: "routine-1", from: ["@shop.example"], address: "scout-1+receipts@in.dusk.bot" }] } };
      if (path === "/api/webhooks" && init?.method === "POST") return { webhook: { ...webhook, id: "hook-r", routineId: "routine-1" }, credential: { url: "https://home.example/hooks/wh_r/whsec_r", endpointUrl: "https://home.example/hooks/wh_r", secret: "whsec_r" } };
      if (path === "/api/routines/routine-1" && init?.method === "PATCH") return { routine: { ...poller, schedule: JSON.parse(init.body!).schedule } };
      return {};
    });
    mount();
    open("routine-1");
    await settle(); render(); await settle();
    const text = sheet().textContent!;
    for (const part of ["Usage", "Last 7 days: 96 runs", "Last 30 days: 300 runs", "Used far more today than it usually does.", "scout-1+receipts@in.dusk.bot", "from @shop.example"]) expect(text).toContain(part);
    flushSync(() => action("routine-1", "less-often").click());
    await settle();
    expect(writes()).toContainEqual(["/api/routines/routine-1", "PATCH", { schedule: { type: "interval", everyMinutes: 30, anchorAt: now } }]);
    flushSync(() => action("routine-1", "address").click());
    await settle(); await settle();
    expect(writes()).toContainEqual(["/api/webhooks", "POST", { name: "Morning summary", prompt: "", botId: "bot-a", routineId: "routine-1" }]);
    expect(copied.texts).toEqual(["https://home.example/hooks/wh_r/whsec_r"]);
  });

  it("pushes routine detail and edit pages natively on the phone instead of opening a desktop dialog", () => {
    document.documentElement.dataset.mobileApp = "ios";
    const shell = document.createElement("div");
    shell.className = "dusk-mobile";
    document.body.append(shell);
    try {
      mount();
      open("routine-1");
      expect(document.querySelector('[data-phone-pushed-page="routine"]')).not.toBeNull();
      expect(document.querySelector("[data-phone-modal-layer]")).toBeNull();
      flushSync(() => document.querySelector<HTMLButtonElement>('[data-phone-pushed-page="routine"] [data-routine-action="edit"]')!.click());
      expect(document.querySelector('[data-phone-pushed-page="routine-edit"] form')).not.toBeNull();
    } finally {
      delete document.documentElement.dataset.mobileApp;
      shell.remove();
    }
  });
});

describe("a bot's routines that have not loaded", () => {
  const panelText = () => container.textContent ?? "";
  const empty = "Ask it in chat to set one up";

  it("says it has none only once the list has loaded", () => {
    fixture.state.routines = [];
    fixture.state.routinesLoadState = "loading";
    mount();
    expect(panelText()).not.toContain(empty);
    expect(panelText()).toContain("Loading routines");
    fixture.state.routinesLoadState = "ready";
    render();
    expect(panelText()).toContain(empty);
  });

  it("says the list failed, not that there are none, and Try again reloads it", async () => {
    fixture.state.routines = [];
    fixture.state.routinesLoadState = "error";
    fixture.api.mockResolvedValue({ routines: [routine], runs: [] });
    mount();
    expect(panelText()).not.toContain(empty);
    expect(container.querySelector("[role=alert]")!.textContent).toContain("Couldn't load routines");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again")!;
    flushSync(() => retry.click());
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "routinesHydrated", routines: [routine], runs: [] })));
    expect(String(fixture.api.mock.calls[0]![0])).toMatch(/^\/api\/routines\?since=\d+$/);
  });

  it("still says so above the bot's webhooks when its routines failed", () => {
    fixture.state.routines = [];
    fixture.state.webhooks = [webhook];
    fixture.state.routinesLoadState = "error";
    mount();
    expect(row("hook-1")).not.toBeNull();
    expect(container.querySelector("[role=alert]")!.textContent).toContain("Couldn't load routines");
  });
});
