// The harness side of the bot trigger tools (trigger_info, trigger): what a bot is shown about
// its schedules, webhooks and app events, and how a trigger request is read before it reaches its service.
import { z } from "zod";

import type { AppTrigger } from "../shared/app-triggers.ts";
import { appWhenText } from "./app-trigger-requests.ts";
import { canManage, resolveTeammate, type RosterMember } from "./peer-roster.ts";
import { redactSecretsInText } from "./redact.ts";
import type { JsonValue } from "./schema.ts";
import type { Routine, RoutineRun } from "./routines.ts";
import type { WebhookTrigger } from "./webhooks.ts";

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const INSTRUCTIONS_SHOWN = 2_000;
const FIRES_SHOWN = 10;

const timestamp = (value: number | undefined | null) =>
  value !== undefined && value !== null && Number.isFinite(value) ? new Date(value).toISOString() : null;

function agentRun(run: RoutineRun) {
  return {
    id: run.id,
    status: run.status,
    triggerSource: run.triggerSource ?? (run.manual ? "manual" : "schedule"),
    scheduledFor: timestamp(run.scheduledFor),
    startedAt: timestamp(run.startedAt),
    finishedAt: timestamp(run.finishedAt),
    attention: run.attention ? redactSecretsInText(run.attention).slice(0, 500) : null,
    output: run.output ? redactSecretsInText(run.output).slice(0, 1_000) : null,
    error: run.error ? redactSecretsInText(run.error).slice(0, 500) : null,
    executionThreadId: run.threadId ?? null,
  };
}

function instructionsOf(text: string) {
  // Instructions may hold a credential and the result goes back to the model: scrub the whole value before previewing.
  const safe = redactSecretsInText(text);
  return { instructions: safe.slice(0, INSTRUCTIONS_SHOWN), instructionsTruncated: safe.length > INSTRUCTIONS_SHOWN };
}

function agentSchedule(schedule: Routine["schedule"]) {
  if (schedule.type === "once") return { type: "once" as const, at: new Date(schedule.at).toISOString() };
  if (schedule.type === "cron") return { ...schedule };
  if (schedule.type === "limit_reset") {
    return { type: "limit_reset" as const, engine: schedule.engine, repeat: schedule.repeat, at: schedule.at === null ? "not known yet; it runs once the engine reports its reset" : new Date(schedule.at).toISOString() };
  }
  if (schedule.type === "interval") {
    return {
      type: "interval" as const,
      everyMinutes: schedule.everyMinutes,
      anchorAt: new Date(schedule.anchorAt).toISOString(),
      ...(schedule.weekdays === undefined ? {} : { weekdays: schedule.weekdays.map((day) => WEEKDAY_NAMES[day]) }),
      ...(schedule.window === undefined ? {} : { window: { ...schedule.window } }),
      ...(schedule.endsAt === undefined ? {} : { endsAt: new Date(schedule.endsAt).toISOString() }),
    };
  }
  return { type: "weekly" as const, time: schedule.time, weekdays: schedule.weekdays.map((day) => WEEKDAY_NAMES[day]) };
}

export function agentRoutine(routine: Routine, latestRun?: RoutineRun) {
  return {
    id: routine.id,
    kind: "schedule" as const,
    name: redactSecretsInText(routine.name),
    ...instructionsOf(routine.prompt),
    continuity: routine.continuity === true,
    overlap: routine.overlap ?? "skip",
    runOnStartup: routine.runOnStartup === true,
    skippedRuns: routine.skippedRuns ?? 0,
    lastSkippedAt: timestamp(routine.lastSkippedAt),
    failureStreak: routine.failureStreak ?? 0,
    enabled: routine.enabled,
    runOn: routine.runOn,
    durationMinutes: routine.durationMinutes,
    ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
    ...(routine.catchUpMinutes === undefined ? {} : { catchUpMinutes: routine.catchUpMinutes }),
    schedule: agentSchedule(routine.schedule),
    nextRunAt: timestamp(routine.nextRunAt),
    latestRun: latestRun ? agentRun(latestRun) : null,
  };
}

export function agentWebhook(webhook: WebhookTrigger, latestRun?: RoutineRun) {
  return {
    id: webhook.id,
    kind: "webhook" as const,
    name: redactSecretsInText(webhook.name),
    ...instructionsOf(webhook.prompt),
    when: "When another app sends something to its address. For the address to paste into that app's setup, call trigger_info with this trigger_id and include_address; the person also has Copy address on the Automations page.",
    enabled: webhook.enabled,
    runOn: webhook.runOn,
    eventTypes: webhook.eventTypes ?? [],
    calls: webhook.deliveryCount,
    lastCalledAt: timestamp(webhook.lastReceivedAt),
    latestRun: latestRun ? agentRun(latestRun) : null,
  };
}

export function agentAppTrigger(trigger: AppTrigger, latestRun?: RoutineRun) {
  const problem = trigger.problem?.kind === "reconnect"
    ? `${trigger.appName} needs to be reconnected; ask the person to reconnect it in Connected apps.`
    : trigger.problem?.text;
  const skipped = trigger.skipped ? trigger.skipped.dailyLimit + trigger.skipped.queueFull + trigger.skipped.expired + trigger.skipped.tooMany : 0;
  return {
    id: trigger.id,
    kind: "app_event" as const,
    name: redactSecretsInText(trigger.name),
    ...instructionsOf(trigger.prompt),
    when: appWhenText(trigger),
    app: trigger.app,
    event: trigger.event,
    account: trigger.accountLabel ?? trigger.accountId,
    filter: trigger.filter ?? {},
    event_config: trigger.config,
    enabled: trigger.enabled,
    runOn: trigger.runOn,
    eventsReceived: trigger.received,
    lastEventAt: timestamp(trigger.lastEventAt),
    ...(trigger.lastEventAt ? {} : { waiting: trigger.delivery === "poll" ? "Waiting for the first event; it checks every 15 minutes." : "Waiting for the first event." }),
    ...(skipped ? { skippedToday: skipped } : {}),
    ...(problem ? { problem } : {}),
    latestRun: latestRun ? agentRun(latestRun) : null,
  };
}

function withAddress<T extends ReturnType<typeof agentRoutine>>(shown: T, linked: ReadonlyMap<string, string>, routineId: string): T {
  return [...linked.values()].includes(routineId) ? { ...shown, hasAddress: true } : shown;
}

type AgentTrigger = ReturnType<typeof agentRoutine> | ReturnType<typeof agentWebhook> | ReturnType<typeof agentAppTrigger>;
export interface TriggerListing {
  now: string;
  timeZone: string;
  triggers?: AgentTrigger[];
  trigger?: AgentTrigger & { recentFires: Array<ReturnType<typeof agentRun>> };
  error?: string;
}

/** One bot's triggers of every kind, or one trigger with its recent fires. Runs are listed newest first. */
export function listTriggers(input: {
  botId: string;
  triggerId?: string;
  routines: readonly Routine[];
  webhooks: readonly WebhookTrigger[];
  appTriggers?: readonly AppTrigger[];
  runs: readonly RoutineRun[];
  timeZone: string;
  now: number;
}): TriggerListing {
  const routines = input.routines.filter((routine) => routine.botId === input.botId);
  const linked = new Map(input.webhooks.filter((webhook) => webhook.routineId && routines.some((routine) => routine.id === webhook.routineId)).map((webhook) => [webhook.id, webhook.routineId!]));
  // a routine's own address runs that routine: its fires are the routine's
  const ownerOf = (run: RoutineRun) => linked.get(run.routineId) ?? run.routineId;
  const latest = new Map<string, RoutineRun>();
  for (const run of input.runs) {
    if (run.botId === input.botId && !latest.has(ownerOf(run))) latest.set(ownerOf(run), run);
  }
  const webhooks = input.webhooks.filter((webhook) => webhook.botId === input.botId && !linked.has(webhook.id));
  const apps = (input.appTriggers ?? []).filter((trigger) => trigger.botId === input.botId);
  const header = { now: new Date(input.now).toISOString(), timeZone: input.timeZone };
  if (input.triggerId) {
    const routine = routines.find((candidate) => candidate.id === input.triggerId);
    const webhook = webhooks.find((candidate) => candidate.id === input.triggerId);
    const app = apps.find((candidate) => candidate.id === input.triggerId);
    if (!routine && !webhook && !app) return { ...header, error: "No trigger with that id belongs to this bot. Call trigger_info without trigger_id to see its ids." };
    const fires = input.runs.filter((run) => ownerOf(run) === input.triggerId).slice(0, FIRES_SHOWN).map(agentRun);
    const shown = routine ? withAddress(agentRoutine(routine, latest.get(routine.id)), linked, routine.id) : webhook ? agentWebhook(webhook, latest.get(webhook.id)) : agentAppTrigger(app!, latest.get(app!.id));
    return { ...header, trigger: { ...shown, recentFires: fires } };
  }
  return {
    ...header,
    triggers: [
      ...routines.map((routine) => withAddress(agentRoutine(routine, latest.get(routine.id)), linked, routine.id)),
      ...webhooks.map((webhook) => agentWebhook(webhook, latest.get(webhook.id))),
      ...apps.map((trigger) => agentAppTrigger(trigger, latest.get(trigger.id))),
    ].slice(0, 100),
  };
}

const source = { fromBotId: z.string().min(1).max(128), fromThreadId: z.string().min(1).max(128), forBotId: z.unknown().optional() };
const triggerRequestSchema = z.union([
  z.object({ ...source, action: z.literal("create"), kind: z.literal("schedule"), routine: z.unknown() }).strict(),
  z.object({ ...source, action: z.literal("create"), kind: z.literal("webhook"), webhook: z.unknown() }).strict(),
  z.object({ ...source, action: z.literal("create"), kind: z.literal("app"), trigger: z.unknown() }).strict(),
  z.object({ ...source, action: z.literal("update"), triggerId: z.string().min(1).max(200), changes: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ ...source, action: z.enum(["pause", "resume", "delete"]), triggerId: z.string().min(1).max(200) }).strict(),
  z.object({ ...source, action: z.literal("run_now"), triggerId: z.string().min(1).max(200), test: z.literal(true).optional(), payload: z.unknown().optional() }).strict(),
]);
/** A sample body a bot tests its webhook or app event with, as the sending app would post it. */
const TEST_PAYLOAD_MAX = 32 * 1024;
const SAMPLE_NEEDED = {
  webhook: "Nothing ran: a webhook's run_now runs its real steps on a sample, never a dry run. Call trigger action=run_now again with this trigger_id and payload, a realistic sample shaped as that app posts it (its usual field names), with the person's own name and email, and no test, so the row lands and the email reaches them.",
  app: "Nothing ran: an app event's run_now runs its real steps on a sample, never a dry run. Call trigger action=run_now again with this trigger_id and payload, a realistic sample of that event as the app sends it (its usual field names), with the person's own name and email, and no test.",
} as const;

const WEBHOOK_FIELDS = new Set(["name", "instructions", "runOn", "eventTypes"]);
const APP_FIELDS = new Set(["name", "instructions", "runOn", "filter", "config"]);

export type ParsedTriggerRequest =
  | { ok: false; error: string }
  | { ok: true; kind: "schedule"; forBotId: unknown; proposal: { action: string; routine?: unknown; routineId?: string; changes?: unknown; test?: boolean } }
  | { ok: true; kind: "webhook"; forBotId: unknown; operation: { action: string; webhook?: unknown; webhookId?: string; changes?: unknown }; payload?: JsonValue }
  | { ok: true; kind: "app"; forBotId: unknown; operation: { action: string; trigger?: unknown; triggerId?: string; changes?: unknown }; payload?: JsonValue };

/** A create names its kind; a change finds it from the trigger id (routine, webhook and app-event ids never collide). */
const WEEKDAY = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
// a day said relative to when the automation was made: true that day, wrong every day after
const RELATIVE_DAY = new RegExp(`\\s*[,(-]?\\s*\\b(?:(?:due|on|for|by|until)\\s+)?(?:today|tonight|tomorrow(?:\\s+(?:morning|afternoon|evening|night))?|yesterday|this\\s+(?:morning|afternoon|evening|week|weekend|month)|next\\s+(?:week|month|weekend|${WEEKDAY})|in\\s+\\d+\\s+(?:days?|weeks?))\\b\\s*\\)?`, "gi");

/** An automation's name without a day said relative to now ("Calculus midterm tomorrow" names it "Calculus midterm"),
 * so it stays true after that day; a name that is nothing but such a day stays as it was. */
export function timelessName(name: string): string {
  const kept = name.replace(RELATIVE_DAY, " ").replace(/\s{2,}/g, " ").replace(/^[\s,:;-]+|[\s,:;-]+$/g, "");
  return kept.length >= 2 ? kept : name;
}

function withTimelessName<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" ? { ...record, name: timelessName(record.name) } as T : value;
}

export function parseTriggerRequest(body: unknown, kindOf: (id: string) => "schedule" | "app" | "webhook"): ParsedTriggerRequest {
  const parsed = triggerRequestSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: "invalid trigger request" };
  const request = parsed.data;
  if (request.action === "create") Object.assign(request, request.kind === "schedule" ? { routine: withTimelessName(request.routine) } : request.kind === "app" ? { trigger: withTimelessName(request.trigger) } : { webhook: withTimelessName(request.webhook) });
  if (request.action === "update") request.changes = withTimelessName(request.changes);
  if (request.action === "create") {
    if (request.kind === "app") return { ok: true, kind: "app", forBotId: request.forBotId, operation: { action: "create", trigger: request.trigger } };
    return request.kind === "schedule"
      ? { ok: true, kind: "schedule", forBotId: request.forBotId, proposal: { action: "create", routine: request.routine } }
      : { ok: true, kind: "webhook", forBotId: request.forBotId, operation: { action: "create", webhook: request.webhook } };
  }
  const changes = request.action === "update" ? request.changes : undefined;
  const kind = kindOf(request.triggerId);
  const payload = request.action === "run_now" ? request.payload : undefined;
  if (payload !== undefined && kind === "schedule") return { ok: false, error: "payload is for run_now on a webhook or app event: a sample of what the sending app posts. A schedule runs without one." };
  // a webhook or app event never dry-runs: its test is a realistic sample run through its real steps
  if (request.action === "run_now" && kind !== "schedule" && (payload === undefined || request.test)) return { ok: false, error: SAMPLE_NEEDED[kind] };
  if (payload !== undefined) {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, error: "payload must be a JSON object: the body the sending app posts." };
    if (JSON.stringify(payload).length > TEST_PAYLOAD_MAX) return { ok: false, error: "payload is too long: send a sample of at most 32 KB." };
  }
  if (kind === "app") {
    const misplaced = changes && Object.keys(changes).find((key) => !APP_FIELDS.has(key));
    if (misplaced) return { ok: false, error: `An app-event trigger has no ${misplaced} to change. Change name, instructions, run_on, filter or event_config; to watch another app, event or account, delete it and create a new one.` };
    return { ok: true, kind: "app", forBotId: request.forBotId, operation: { action: request.action, triggerId: request.triggerId, ...(changes ? { changes } : {}) }, ...(payload !== undefined ? { payload: payload as JsonValue } : {}) };
  }
  if (kind === "schedule") {
    if (changes && "eventTypes" in changes) return { ok: false, error: "webhook_event_types applies only to webhook triggers" };
    if (changes && ("filter" in changes || "config" in changes)) return { ok: false, error: "filter and event_config apply only to app-event triggers" };
    const test = request.action === "run_now" && request.test ? { test: true } : {};
    return { ok: true, kind: "schedule", forBotId: request.forBotId, proposal: { action: request.action, routineId: request.triggerId, ...(changes ? { changes } : {}), ...test } };
  }
  const misplaced = changes && Object.keys(changes).find((key) => !WEBHOOK_FIELDS.has(key));
  if (misplaced) return { ok: false, error: `A webhook trigger has no ${misplaced}; it fires when its link is called. Change name, instructions, run_on or webhook_event_types.` };
  return { ok: true, kind: "webhook", forBotId: request.forBotId, operation: { action: request.action, webhookId: request.triggerId, ...(changes ? { changes } : {}) }, ...(payload !== undefined ? { payload: payload as JsonValue } : {}) };
}

/** An automation is part of a bot's setup: another bot named by for_bot_id needs the sender's authority, not just reach. */
export function triggerTarget<T extends RosterMember>(from: T, forBotId: unknown, bot: (id: string) => T | null | undefined, bots?: readonly T[]):
  { forBot?: { botId: string; name: string } } | { status: number; error: string } {
  if (forBotId === undefined) return {};
  const id = typeof forBotId === "string" ? forBotId.trim().slice(0, 128) : "";
  if (!id) return { status: 400, error: 'for_bot_id must be a bot id from list_bots, e.g. { "for_bot_id": "bot-abc123" }' };
  if (id === from.id) return {};
  // a model often writes the name it just saw ("Scout"); a unique reachable name means that bot, as in coordinate_bots
  const named = bot(id) ? undefined : bots && resolveTeammate(bots, from, id);
  const target = bot(named && "id" in named ? named.id : id);
  if (target?.id === from.id) return {};
  if (!target) return { status: 404, error: "no bot with that id: call list_bots and copy the exact id from the result" };
  if (!canManage(from, target)) return { status: 403, error: "that bot's automations are set up by its Chief, or it is unavailable. You can still hand it the work itself with coordinate_bots, or tell the person what to set up there." };
  return { forBot: { botId: target.id, name: target.name } };
}
