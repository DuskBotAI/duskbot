import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { commandReceipt, runCommand } from "./commands.ts";
import { DATA_DIR } from "./config.ts";
import { appendMessage, closeMessageDb, readThread } from "./message-db.ts";
import { RoutineManager } from "./routines.ts";
import { WebhookManager } from "./webhooks.ts";

const dirs: string[] = [];
const week = 7 * 24 * 60 * 60_000;
const input = {
  webhookId: "hook", webhookName: "Incoming", prompt: "Handle once", botId: "bot",
  runOn: "maus" as const, deliveryId: "delivery", receivedAt: Date.now(),
};
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "dusk-webhook-commit-"));
  dirs.push(dir);
  let now = Date.now();
  const options = {
    file: join(dir, "routines.json"), now: () => now,
    botState: () => "busy" as const, createTask: () => null, startTurn: async () => {},
  };
  return { dir, options, manager: new RoutineManager(options), advance: (ms: number) => { now += ms; } };
}
afterEach(() => { vi.restoreAllMocks(); closeMessageDb(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it.each(["chat", "room"] as const)("recovers a committed %s webhook post when the webhook receipt could not be saved", async (destination) => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "dusk-webhook-post-commit-"));
  dirs.push(dir);
  const file = join(dir, "webhooks.json");
  const commit = (endpointId: string, deliveryId: string) => runCommand({ kind: "webhook.post", key: `${endpointId}:${deliveryId}` }, () => {
    appendMessage("fixture-thread", { id: "fixture-message", at: Date.now(), role: "bot", kind: "text", text: "once", webhookPost: true });
    return true;
  });
  const options = {
    file,
    botState: () => "ready" as const,
    enqueue: () => ({ id: "unused" }),
    resolvePostThread: () => "fixture-thread",
    roomMember: () => ({ ok: true as const }),
    post: (_botId: string, _threadId: string, _text: string, endpointId: string, deliveryId: string) => { commit(endpointId, deliveryId); },
    roomPost: async (trigger: { endpointId: string }, _payload: unknown, deliveryId: string) => {
      commit(trigger.endpointId, deliveryId);
      return { posted: true as const, attachments: 0, threadId: "fixture-thread" };
    },
    findPost: (endpointId: string, deliveryId: string) => commandReceipt("webhook.post", `${endpointId}:${deliveryId}`) !== null,
  };
  const manager = new WebhookManager(options);
  const { webhook, secret } = manager.create({ name: "Fixture", prompt: "", botId: "fixture-bot", delivery: "post",
    ...(destination === "room" ? { groupId: "fixture-room" } : {}) });
  vi.spyOn(manager as unknown as { save(): void }, "save").mockImplementation(() => { throw new Error("receipt write failed"); });
  const event = { deliveryId: "fixture-delivery", payload: { text: "once" } };
  await expect(async () => manager.receive(webhook.endpointId, secret, event)).rejects.toThrow("receipt write failed");
  closeMessageDb();

  const restarted = new WebhookManager(options);
  expect(await restarted.receive(webhook.endpointId, secret, event)).toMatchObject({ duplicate: true, deliveryId: event.deliveryId });
  expect(readThread("fixture-thread", "/nonexistent").messages.map((message) => message.text)).toEqual(["once"]);
});

it("recovers the canonical job when saving the ingress receipt failed, even with a full queue", () => {
  const h = harness();
  const options = {
    file: join(h.dir, "webhooks.json"), botState: () => "busy" as const,
    enqueue: (event: Parameters<RoutineManager["enqueueWebhook"]>[0]) => {
      h.manager.enqueueWebhook(event);
      throw new Error("lost response after durable enqueue");
    },
  };
  const webhook = new WebhookManager(options);
  const { webhook: hook, secret } = webhook.create({ name: "Incoming", prompt: "Handle once", botId: "bot" });
  const event = { deliveryId: "retry", payload: { item: 1 } };
  expect(() => webhook.receive(hook.endpointId, secret, event)).toThrow("lost response");
  const first = h.manager.listRuns()[0]!;
  expect(JSON.parse(readFileSync(options.file, "utf8")).deliveries).toEqual([]);

  const recovered = new RoutineManager(h.options);
  const retried = new WebhookManager({
    ...options, enqueue: (event) => recovered.enqueueWebhook(event),
    findRun: (hookId, deliveryId) => recovered.webhookRunReceipt(hookId, deliveryId), pendingRuns: () => 3,
  });
  expect(retried.receive(hook.endpointId, secret, event)).toEqual({
    runId: first.id, deliveryId: "retry", duplicate: true,
  });
  expect(recovered.listRuns()).toHaveLength(1);
  expect(recovered.enqueueWebhook({ ...input, webhookId: hook.id, deliveryId: "retry" })).toEqual({ id: first.id });
});

it("retains delivery identities after run-history pruning, with a seven-day retry window", () => {
  const h = harness();
  const first = h.manager.enqueueWebhook(input);
  const disk = JSON.parse(readFileSync(h.options.file, "utf8"));
  disk.runs = [];
  writeFileSync(h.options.file, JSON.stringify(disk));
  let reloaded = new RoutineManager(h.options);
  expect(reloaded.enqueueWebhook(input)).toEqual({ id: first.id });
  expect(reloaded.listRuns()).toEqual([]);
  expect(reloaded.enqueueWebhook({ ...input, webhookId: "another-hook" }).id).not.toBe(first.id);
  h.advance(week + 1);
  reloaded = new RoutineManager(h.options);
  expect(reloaded.enqueueWebhook(input).id).not.toBe(first.id);
});

it("never duplicates unfinished work after the retry window expires", () => {
  const h = harness();
  const first = h.manager.enqueueWebhook(input);
  h.advance(week + 1);
  expect(new RoutineManager(h.options).enqueueWebhook(input)).toEqual({ id: first.id });
});

it("upgrades legacy run identities and does not acknowledge a failed disk commit", () => {
  const h = harness();
  mkdirSync(h.options.file);
  expect(() => h.manager.enqueueWebhook(input)).toThrow();
  expect(h.manager.listRuns()).toEqual([]);
  expect(h.manager.webhookRunReceipt(input.webhookId, input.deliveryId)).toBeNull();
  rmSync(h.options.file, { recursive: true });
  const first = h.manager.enqueueWebhook(input);
  const disk = JSON.parse(readFileSync(h.options.file, "utf8"));
  delete disk.webhookRunReceipts;
  writeFileSync(h.options.file, JSON.stringify(disk));
  expect(new RoutineManager(h.options).enqueueWebhook(input)).toEqual({ id: first.id });
});

it("refuses fresh work instead of evicting unexpired retry identities at capacity", () => {
  const h = harness();
  h.manager.enqueueWebhook(input);
  const disk = JSON.parse(readFileSync(h.options.file, "utf8"));
  disk.webhookRunReceipts = Array.from({ length: 20_000 }, (_, index) => ({
    webhookId: "hook", deliveryId: `event-${index}`, runId: `run-${index}`, acceptedAt: Date.now(),
  }));
  disk.runs = [];
  writeFileSync(h.options.file, JSON.stringify(disk));
  const reloaded = new RoutineManager(h.options);
  expect(reloaded.enqueueWebhook({ ...input, deliveryId: "event-0" })).toEqual({ id: "run-0" });
  expect(() => reloaded.enqueueWebhook(input)).toThrow("retry history is full");
  expect(reloaded.listRuns()).toEqual([]);
});

it("restores pruned run history when the webhook disk commit fails at the retention limit", () => {
  const h = harness();
  h.manager.enqueueWebhook(input);
  const disk = JSON.parse(readFileSync(h.options.file, "utf8"));
  disk.runs = Array.from({ length: 2_000 }, (_, index) => ({
    ...disk.runs[0], id: `history-${index}`, deliveryId: `history-${index}`, status: "completed",
  }));
  writeFileSync(h.options.file, JSON.stringify(disk));
  const manager = new RoutineManager(h.options);
  const before = manager.listRuns();
  const saved = join(h.dir, "saved-routines.json");
  renameSync(h.options.file, saved);
  mkdirSync(h.options.file); // Fail the real atomic rename, after save() prunes.
  expect(() => manager.enqueueWebhook({ ...input, deliveryId: "next" })).toThrow();
  expect(manager.listRuns()).toEqual(before);
  expect(manager.webhookRunReceipt(input.webhookId, "next")).toBeNull();
  rmSync(h.options.file, { recursive: true });
  renameSync(saved, h.options.file);

  manager.create({ name: "Unrelated save", prompt: "No work", botId: "bot", enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() },
  });
  expect(new RoutineManager(h.options).listRuns()).toEqual(before);
  const accepted = manager.enqueueWebhook({ ...input, deliveryId: "next" });
  expect(manager.listRuns()).toHaveLength(2_000);
  expect(manager.listRuns().some((run) => run.id === "history-0")).toBe(false);
  expect(new RoutineManager(h.options).webhookRunReceipt(input.webhookId, "next")).toEqual({ id: accepted.id });
});

it.each(["capacity", "disk", "routine-write"] as const)("a rejected %s admission does not detach the scheduler's live runs", async (failure) => {
  const h = harness();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const starts: string[] = [];
  const manager = new RoutineManager({
    ...h.options, botState: () => "ready", createTask: (botId) => ({ threadId: `thread-${botId}` }),
    startTurn: async (botId) => { starts.push(botId); if (botId === "A") await held; },
  });
  manager.enqueueWebhook({ ...input, botId: "A", deliveryId: "A" });
  const second = manager.enqueueWebhook({ ...input, botId: "B", deliveryId: "B" });
  await Promise.resolve();
  expect(starts).toEqual(["A"]);
  const internals = manager as unknown as {
    webhookRunReceipts: Array<{ webhookId: string; deliveryId: string; runId: string; acceptedAt: number }>;
    save(): void;
  };
  if (failure === "capacity") {
    internals.webhookRunReceipts = Array.from({ length: 20_000 }, (_, index) => ({
      webhookId: "hook", deliveryId: `filler-${index}`, runId: `run-${index}`, acceptedAt: Date.now(),
    }));
  } else {
    vi.spyOn(internals, "save").mockImplementationOnce(() => { throw new Error("disk full"); });
  }
  if (failure === "routine-write") {
    expect(() => manager.create({ name: "Unrelated routine", prompt: "Never saved", botId: "C", enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() },
    })).toThrow("disk full");
  } else {
    expect(() => manager.enqueueWebhook({ ...input, botId: "C", deliveryId: "C" })).toThrow();
  }
  release();
  await vi.waitFor(() => expect(starts).toEqual(["A", "B"]));
  expect(manager.listRuns().find((run) => run.id === second.id)).toMatchObject({ status: "running", threadId: "thread-B" });
  await manager.tick();
  expect(starts).toEqual(["A", "B"]);
  expect(manager.listRuns()).toHaveLength(2);
});
