import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAppTriggerHost } from "./app-trigger-host.ts";
import type { RoutineManager } from "./routines.ts";
import { WebhookManager } from "./webhooks.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dusk-host-routine-"));
  dirs.push(dir);
  const bots: Record<string, any> = { scout: { id: "scout", name: "Scout", color: "#000", createdBy: "a@example.com" }, other: { id: "other", name: "Other", color: "#000", createdBy: "b@example.com" } };
  const poller = { id: "r1", botId: "scout", name: "Price watch", prompt: "Check the price.", enabled: true, schedule: { type: "interval", everyMinutes: 15, anchorAt: 0 }, nextRunAt: null };
  const routines = { listRoutines: () => [poller], listRuns: () => [] } as unknown as RoutineManager;
  const webhooks = new WebhookManager({ file: join(dir, "webhooks.json"), botState: () => "ready", enqueue: () => ({ id: "run" }), routinePrompt: (id) => (id === "r1" ? poller : null) });
  const host = createAppTriggerHost({
    file: join(dir, "app-triggers.json"),
    store: { bot: (id) => bots[id], messagesFor: () => [], appendMessage: () => ({ id: "m" }), patchMessage: () => undefined },
    connectionMode: () => "unavailable", access: () => null, connectedApps: async () => ({}),
    routines: () => routines, webhooks, webhookBase: () => "https://home.example", botState: () => "ready", timeZone: () => "UTC",
    visibleBot: () => true, emit: () => {}, audit: () => {},
    bots: () => Object.values(bots),
    routineUsage: () => [
      { routineId: "r1", botId: "scout", name: "Price watch", week: { runs: 96, usd: 2, tokens: 1 }, month: { runs: 300, usd: 6, tokens: 1 } },
      { routineId: "x", botId: "other", name: "Not mine", week: { runs: 1, usd: 9, tokens: 1 }, month: { runs: 1, usd: 9, tokens: 1 } },
    ],
  });
  const call = async (path: string, context: { guestDriven?: boolean; outside?: boolean } = {}) => {
    let answer: { status: number; body: any } | null = null;
    await host.internalRoutes({ from: bots.scout, threadId: "t1", ownsThread: () => true, guestDriven: context.guestDriven ?? false, outsideDriven: () => context.outside ?? false, canCommit: () => true })({
      res: {} as never, url: new URL(`http://x${path}`), path: path.split("?")[0]!, method: "GET",
      json: ((_res: unknown, status: number, body: unknown) => { answer = { status, body }; }) as never,
    } as never);
    return answer!;
  };
  return { webhooks, call };
}

describe("a routine's address and usage from chat", () => {
  it("gives a routine its own address the first time it is asked, and the same one after", async () => {
    const { webhooks, call } = setup();
    const first = await call("/api/internal/triggers?triggerId=r1&includeAddress=1");
    expect(first.body.trigger.address.url).toMatch(/^https:\/\/home\.example\/hooks\/wh_[^/]+\/whsec_/);
    const again = await call("/api/internal/triggers?triggerId=r1&includeAddress=1");
    expect(again.body.trigger.address.url).toBe(first.body.trigger.address.url);
    expect(webhooks.list()).toHaveLength(1);
    const listing = await call("/api/internal/triggers");
    expect(listing.body.triggers.map((one: any) => [one.kind, one.id, one.hasAddress])).toEqual([["schedule", "r1", true]]);
  });

  it("never makes or shows an address in a turn an outside event drove", async () => {
    const { webhooks, call } = setup();
    expect((await call("/api/internal/triggers?triggerId=r1&includeAddress=1", { outside: true })).body.trigger.addressRefused).toMatch(/outside event/);
    expect(webhooks.list()).toHaveLength(0);
  });

  it("reports what this bot's automations used, and refuses a guest's turn", async () => {
    const { call } = setup();
    const usage = await call("/api/internal/trigger-usage");
    expect(usage.body.automations).toEqual([expect.objectContaining({ trigger_id: "r1", runsEveryMinutes: 15, last7Days: { runs: 96, usd: 2 } })]);
    expect((await call("/api/internal/trigger-usage", { guestDriven: true })).status).toBe(403);
  });
});
