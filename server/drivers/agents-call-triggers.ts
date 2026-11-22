// The trigger tools a bot uses from chat: trigger_info reads (list, events), trigger changes (create, update, pause,
// resume, run_now) and delete_trigger deletes. Every change applies at once (no confirmation card); the harness records
// it on the automation's card with Pause, Edit and Undo.
import { normalizeCronSchedule } from "../../shared/routine-schedule.ts";
import { plainTimeZone } from "../../shared/plain-time-zone.ts";
import { plainWhen } from "../plain-time.ts";

import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import { WEEKDAYS } from "./agents-catalog.ts";
import type { Json } from "./agents-client.ts";
import { withRepeatHint } from "./repeat-hint.ts";

export const TRIGGER_TOOL_NAMES: ReadonlySet<string> = new Set(["trigger_info", "trigger", "delete_trigger"]);

const LIST_ROUTE = "/api/internal/triggers";
const JOB_LIST_ROUTE = "/api/internal/jobs";
const EVERY_WAIT_ROUTE = "/api/internal/waits/all";
const EVENTS_ROUTE = "/api/internal/trigger-events";
const USAGE_ROUTE = "/api/internal/trigger-usage";
const MAIL_ROUTE = "/api/internal/bot-mail";
const APP_ONLY = ["app", "event", "account"] as const;
const REQUEST_ROUTE = "/api/internal/trigger-requests";
const SCHEDULE_ONLY = ["schedule", "timeout_minutes", "timeoutMinutes", "clear_timeout", "continuity", "overlap", "run_on_startup", "runOnStartup", "check", "clear_check"] as const;

function jsonRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SHORT_WEEKDAYS = {
  mon: "monday",
  tue: "tuesday",
  tues: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  fri: "friday",
  sat: "saturday",
  sun: "sunday",
} as const satisfies Record<string, (typeof WEEKDAYS)[number]>;

const SUPPORTED_SCHEDULES =
  'Supported schedules: {"type":"once","at":"2026-09-01T09:00:00+05:30"} (future RFC3339 with explicit offset), ' +
  '{"type":"weekly","time":"09:00","weekdays":["monday","friday"]}, {"type":"daily","time":"09:00"}, ' +
  '{"type":"interval","every_minutes":15,"weekdays":["monday","friday"],"window_start":"09:00","window_end":"17:00"}, ' +
  'or {"type":"cron","expression":"0 9 1 * *","timeZone":"Asia/Kolkata"} (monthly at 09:00 on day 1; five fields and an explicit IANA timezone).';

interface NormalizedSchedule {
  schedule?: Json;
  error?: string;
}

/** Models stringify nested objects, say "daily" or shorten weekday names; each has one obvious meaning. */
function normalizeScheduleInput(args: Json): NormalizedSchedule {
  let raw = args.schedule;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { error: `The schedule must be a JSON object, not text. ${SUPPORTED_SCHEDULES}` };
    }
  }
  if (!jsonRecord(raw)) return { error: `The schedule must be a JSON object. ${SUPPORTED_SCHEDULES}` };
  const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
  // "at" carries its own offset, so a once schedule's timeZone says nothing more and is dropped.
  const fields = type === "once"
    ? ["type", "at", "timeZone"]
    : type === "weekly" || type === "daily"
      ? ["type", "time", "weekdays", "timeZone", "exact"]
      : type === "interval"
        ? ["type", "every_minutes", "everyMinutes", "starts_at", "anchorAt", "weekdays", "every_day", "window_start", "window_end", "window", "all_day", "ends_at", "endsAt", "never_ends"]
        : type === "cron"
          ? ["type", "expression", "timeZone", "exact"]
          : type === "limit_reset"
            ? ["type", "engine", "repeat"]
            : null;
  // Providers may send unused optional fields as null; any other unknown field refuses the call.
  const unsupported = fields && Object.keys(raw).find((key) => raw[key] != null && !fields.includes(key));
  if (unsupported) {
    return { error: `Unsupported ${type} schedule field "${unsupported}". Weekly and daily times use the computer's timezone from trigger_info unless timeZone names another. ${SUPPORTED_SCHEDULES}` };
  }
  if (raw.exact != null && typeof raw.exact !== "boolean") return { error: '"exact" must be true or false.' };
  const exact = raw.exact === true ? { exact: true } : {};
  if (type === "cron") {
    try {
      return { schedule: { ...normalizeCronSchedule({ type, expression: raw.expression, timeZone: raw.timeZone }), ...exact } };
    } catch (error) {
      return { error: `${error instanceof Error ? error.message : "Invalid cron schedule"}. ${SUPPORTED_SCHEDULES}` };
    }
  }
  if (type === "limit_reset") return limitResetSchedule(raw.engine, raw.repeat);
  if (type === "once") {
    if (typeof raw.at !== "string" || !raw.at.trim()) {
      return { error: `A once schedule needs "at": a future RFC3339 date-time with an explicit offset, for example 2026-09-01T09:00:00+05:30.` };
    }
    return { schedule: { type: "once", at: raw.at.trim() } };
  }
  if (type === "weekly" || type === "daily") {
    const time = typeof raw.time === "string" ? raw.time.trim() : "";
    if (!time) return { error: `A ${type} schedule needs "time" in 24-hour HH:MM, for example 09:00.` };
    let weekdays: string[];
    if (type === "daily") {
      weekdays = Array.isArray(raw.weekdays) && raw.weekdays.length ? raw.weekdays : [...WEEKDAYS];
    } else {
      if (!Array.isArray(raw.weekdays) || raw.weekdays.length === 0) {
        return { error: `A weekly schedule needs "weekdays", for example ["monday","friday"], or use {"type":"daily"} to run every day.` };
      }
      weekdays = raw.weekdays;
    }
    const normalized: string[] = [];
    for (const day of weekdays) {
      const lower = String(day).trim().toLowerCase();
      const full = (WEEKDAYS as readonly string[]).includes(lower)
        ? lower
        : Object.hasOwn(SHORT_WEEKDAYS, lower)
          ? SHORT_WEEKDAYS[lower as keyof typeof SHORT_WEEKDAYS]
          : undefined;
      if (!full) return { error: `Unsupported weekday "${String(day)}". Use full names: ${WEEKDAYS.join(", ")}.` };
      if (!normalized.includes(full)) normalized.push(full);
    }
    if (raw.timeZone == null) return { schedule: { type: "weekly", time, weekdays: normalized, ...exact } };
    if (typeof raw.timeZone !== "string" || !raw.timeZone.trim()) return { error: '"timeZone" must be an IANA timezone such as Europe/London.' };
    return { schedule: { type: "weekly", time, weekdays: normalized, timeZone: raw.timeZone.trim(), ...exact } };
  }
  if (type === "interval") {
    for (const flag of ["every_day", "all_day", "never_ends"]) {
      if (raw[flag] != null && typeof raw[flag] !== "boolean") {
        return { error: `"${flag}" must be true or false.` };
      }
    }
    if (raw.window != null && (!jsonRecord(raw.window)
      || Object.keys(raw.window).some((key) => key !== "start" && key !== "end")
      || typeof raw.window.start !== "string" || typeof raw.window.end !== "string")) {
      return { error: '"window" must contain "start" and "end" in HH:MM, for example {"start":"09:00","end":"17:00"}.' };
    }
    const rawMinutes = raw.every_minutes ?? raw.everyMinutes;
    const everyMinutes = Number(rawMinutes);
    if (!Number.isInteger(everyMinutes) || everyMinutes < 5 || everyMinutes > 1_440) {
      return { error: 'An interval schedule needs "every_minutes": a whole number from 5 to 1440.' };
    }
    const rawStart = raw.starts_at ?? raw.anchorAt;
    if (rawStart !== undefined && (typeof rawStart !== "string" || !rawStart.trim())) {
      return { error: '"starts_at" must be an RFC3339 date-time with an explicit timezone offset.' };
    }
    if (raw.every_day === true && Array.isArray(raw.weekdays) && raw.weekdays.length > 0) {
      return { error: 'Choose interval "weekdays" or "every_day", not both.' };
    }
    let intervalWeekdays: string[] | null | undefined;
    if (raw.every_day === true) {
      intervalWeekdays = null;
    } else if (raw.weekdays !== undefined) {
      if (!Array.isArray(raw.weekdays) || raw.weekdays.length === 0) {
        return { error: 'Interval "weekdays" must contain at least one full weekday name.' };
      }
      intervalWeekdays = [];
      for (const day of raw.weekdays) {
        const lower = String(day).trim().toLowerCase();
        const full = (WEEKDAYS as readonly string[]).includes(lower)
          ? lower
          : Object.hasOwn(SHORT_WEEKDAYS, lower)
            ? SHORT_WEEKDAYS[lower as keyof typeof SHORT_WEEKDAYS]
            : undefined;
        if (!full) return { error: `Unsupported weekday "${String(day)}". Use full names: ${WEEKDAYS.join(", ")}.` };
        if (!intervalWeekdays.includes(full)) intervalWeekdays.push(full);
      }
    }
    const rawWindow = jsonRecord(raw.window) ? raw.window : undefined;
    const windowStart = raw.window_start ?? rawWindow?.start;
    const windowEnd = raw.window_end ?? rawWindow?.end;
    if (raw.all_day === true && (windowStart !== undefined || windowEnd !== undefined)) {
      return { error: 'Choose window_start + window_end or "all_day", not both.' };
    }
    let window: Json | null | undefined;
    if (raw.all_day === true) {
      window = null;
    } else if (windowStart !== undefined || windowEnd !== undefined) {
      if (typeof windowStart !== "string" || !windowStart.trim() || typeof windowEnd !== "string" || !windowEnd.trim()) {
        return { error: 'An interval time window needs both "window_start" and "window_end" in 24-hour HH:MM.' };
      }
      window = { start: windowStart.trim(), end: windowEnd.trim() };
    }
    const rawEnd = raw.ends_at ?? raw.endsAt;
    if (raw.never_ends === true && rawEnd !== undefined) {
      return { error: 'Choose "ends_at" or "never_ends", not both.' };
    }
    let endsAt: string | null | undefined;
    if (raw.never_ends === true) endsAt = null;
    else if (rawEnd !== undefined) {
      if (typeof rawEnd !== "string" || !rawEnd.trim()) {
        return { error: '"ends_at" must be an RFC3339 date-time with an explicit timezone offset.' };
      }
      endsAt = rawEnd.trim();
    }
    return {
      schedule: {
        type: "interval",
        everyMinutes,
        ...(typeof rawStart === "string" ? { anchorAt: rawStart.trim() } : {}),
        ...(intervalWeekdays !== undefined ? { weekdays: intervalWeekdays } : {}),
        ...(window !== undefined ? { window } : {}),
        ...(endsAt !== undefined ? { endsAt } : {}),
      },
    };
  }
  if (type === "hourly" || type === "minutes") {
    return { error: `Use an interval schedule for every-N-minutes work. ${SUPPORTED_SCHEDULES}` };
  }
  return { error: `Unknown schedule type "${type || "(missing)"}". ${SUPPORTED_SCHEDULES}` };
}

/** No engine means the bot's own, which the harness knows. */
function limitResetSchedule(engine: unknown, repeat: unknown): NormalizedSchedule {
  if (engine != null && (typeof engine !== "string" || !engine.trim())) return { error: 'engine must be an engine id such as "claude" or "codex"; omit it for your own engine.' };
  if (repeat != null && repeat !== "once" && repeat !== "every_reset") return { error: 'repeat must be "once" or "every_reset".' };
  return { schedule: { type: "limit_reset", ...(typeof engine === "string" ? { engine: engine.trim() } : {}), repeat: repeat === "every_reset" ? "every_reset" : "once" } };
}

type RoutineAction = "update" | "pause" | "resume" | "run_now" | "delete";

function routineAction(value: unknown): RoutineAction | null {
  return value === "update" || value === "pause" || value === "resume" || value === "run_now" || value === "delete"
    ? value
    : null;
}

function routineFields(args: Json): { fields: Json; error?: string } {
  const fields: Json = {};
  if (args.run_on != null && args.runOn != null && args.run_on !== args.runOn) {
    return { fields, error: "Choose one run_on destination; run_on and runOn disagree." };
  }
  if (args.timeout_minutes != null && args.timeoutMinutes != null && args.timeout_minutes !== args.timeoutMinutes) {
    return { fields, error: "Choose one timeout_minutes limit; timeout_minutes and timeoutMinutes disagree." };
  }
  const runOn = args.run_on ?? args.runOn;
  const timeoutMinutes = args.timeout_minutes ?? args.timeoutMinutes;
  if (runOn != null && runOn !== "maus" && runOn !== "cloud") {
    return { fields, error: 'Use run_on="maus" for the bot’s current model and configured computer, or run_on="cloud" for its sandboxed computer on your own connected VPS.' };
  }
  if (timeoutMinutes != null && (
    typeof timeoutMinutes !== "number" || !Number.isInteger(timeoutMinutes) || timeoutMinutes < 5 || timeoutMinutes > 240
  )) {
    return { fields, error: "timeout_minutes must be a whole number from 5 to 240. Use clear_timeout to remove a limit." };
  }
  if (args.continuity != null && typeof args.continuity !== "boolean") {
    return { fields, error: "continuity must be true or false." };
  }
  if (args.run_on_startup != null && args.runOnStartup != null && args.run_on_startup !== args.runOnStartup) {
    return { fields, error: "Choose one run_on_startup value; run_on_startup and runOnStartup disagree." };
  }
  const runOnStartup = args.run_on_startup ?? args.runOnStartup;
  if (runOnStartup != null && typeof runOnStartup !== "boolean") {
    return { fields, error: "run_on_startup must be true or false." };
  }
  if (args.overlap !== undefined && args.overlap !== "skip" && args.overlap !== "queue") {
    return { fields, error: "overlap must be skip or queue." };
  }
  if (args.clear_timeout != null && typeof args.clear_timeout !== "boolean") {
    return { fields, error: "clear_timeout must be true or false." };
  }
  if (args.clear_timeout === true && timeoutMinutes != null) {
    return { fields, error: "Choose timeout_minutes or clear_timeout, not both." };
  }
  if (typeof args.name === "string") fields.name = args.name.trim();
  if (typeof args.instructions === "string") fields.instructions = args.instructions.trim();
  if (args.schedule !== undefined && args.schedule !== null) {
    const normalized = normalizeScheduleInput(args);
    if (normalized.error) return { fields, error: normalized.error };
    fields.schedule = normalized.schedule;
  }
  if (runOn != null) fields.runOn = runOn;
  if (args.clear_timeout === true) fields.timeoutMinutes = null;
  else if (timeoutMinutes != null) fields.timeoutMinutes = timeoutMinutes;
  if (typeof args.continuity === "boolean") fields.continuity = args.continuity;
  if (args.overlap !== undefined) fields.overlap = args.overlap;
  if (typeof runOnStartup === "boolean") fields.runOnStartup = runOnStartup;
  const check = routineCheck(args.check, args.clear_check);
  if (check.error) return { fields, error: check.error };
  if (check.probe !== undefined) fields.probe = check.probe;
  return { fields };
}

/** check as the routine keeps it (its probe); null when clear_check removes it. */
function routineCheck(raw: unknown, clear: unknown): { probe?: Json | null; error?: string } {
  if (clear != null && typeof clear !== "boolean") return { error: "clear_check must be true or false." };
  if (clear === true) return raw == null ? { probe: null } : { error: "Choose check or clear_check, not both." };
  if (raw == null) return {};
  let value = raw;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return { error: "check must be an object." }; } }
  if (!jsonRecord(value)) return { error: 'check must be an object such as {"kind":"page","url":"https://example.com/status"} or {"kind":"script","command":"..."}.' };
  const kind = value.kind;
  if (kind === "script") {
    if (typeof value.command !== "string" || !value.command.trim()) return { error: "A script check needs command: one shell command line." };
    return { probe: { kind, url: "", command: value.command.trim() } };
  }
  if (kind !== "page" && kind !== "feed" && kind !== "price") return { error: "check.kind must be page, feed, price or script." };
  if (typeof value.url !== "string" || !value.url.trim()) return { error: `A ${kind} check needs url: the full https address.` };
  const selector = typeof value.selector === "string" && value.selector.trim() ? value.selector.trim() : undefined;
  return { probe: { kind, url: value.url.trim(), ...(selector ? { selector } : {}) } };
}


const FILTER_KEYS = { from: "from", subject_contains: "subject", label: "label", contains: "text" } as const;

/** The plain filter in its stored words; Gmail turns it into its own search, other apps match it on arrival. */
function appFilter(raw: unknown): { filter?: Json; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (!jsonRecord(raw)) return { error: 'filter must be an object such as {"from":"acme.com","subject_contains":"order"}.' };
  const filter: Json = {};
  for (const [key, value] of Object.entries(raw)) {
    const stored = FILTER_KEYS[key as keyof typeof FILTER_KEYS];
    if (!stored) return { error: `filter takes from, subject_contains, label and contains; not ${key}.` };
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string" || value.length > 200) return { error: `filter.${key} must be text of at most 200 characters.` };
    filter[stored] = value.trim();
  }
  return { filter };
}

/** Schedule fields plus the webhook's event types and the app event's filter and settings, normalized once; which apply
 *  is checked against the trigger's kind. */
function triggerFields(args: Json): { fields: Json; error?: string } {
  const { fields, error } = routineFields(args);
  if (error) return { fields, error };
  const { filter, error: filterError } = appFilter(args.filter);
  if (filterError) return { fields, error: filterError };
  if (filter) fields.filter = filter;
  if (args.event_config !== undefined && args.event_config !== null) {
    if (!jsonRecord(args.event_config)) return { fields, error: 'event_config must be an object of the event\'s settings from trigger_info action=events, e.g. {"channel_id":"C0123"}.' };
    fields.config = args.event_config;
  }
  const eventTypes = args.webhook_event_types;
  if (eventTypes !== undefined && eventTypes !== null) {
    if (!Array.isArray(eventTypes) || eventTypes.some((value) => typeof value !== "string")) {
      return { fields, error: "webhook_event_types must be a list of event names." };
    }
    fields.eventTypes = eventTypes.map((value) => String(value).trim()).filter(Boolean);
  }
  return { fields };
}

/** A webhook's address as the bot reads it: what to paste, or why this turn does not get it. */
function addressText(r: Json): string {
  if (typeof r.addressRefused === "string") return `\n\nIts address: ${r.addressRefused}`;
  if (!jsonRecord(r.address)) return "";
  if (typeof r.address.unavailable === "string") return `\n\nIts address: ${r.address.unavailable}`;
  return `\n\nIts private address, for you to paste into that app's setup yourself: ${JSON.stringify(r.address, null, 2)}\n\nNever write it in your reply: when the person pastes it into the app, tell them to use Copy address on this automation's card. It is on now and waits for calls. Test it once before you say it works: trigger action=run_now with this trigger_id and payload, a sample shaped as that app posts it, with the person's own name and email, so its real steps run end to end (the row lands, the email reaches them); then tell them it is live and what the test did.`;
}

/** What the bot should say about a schedule it just set: what it assumed, with the time zone and the next run in words. */
function closingWords(r: Json, action: string): string {
  const zone = typeof r.timeZone === "string" ? r.timeZone : "";
  const plain = zone ? plainTimeZone(zone) : "";
  const next = typeof r.nextRunAt === "number" && zone ? `${plainWhen(r.nextRunAt, zone)} ${plain}` : "";
  if (next && action === "create") {
    return `In a sentence or two of plain words, tell the person what you set up and what you assumed: when it runs, saying the time zone as "${plain}", never as a zone id; where its results will appear (here in this chat); what each run covers; that the first run is ${next}; and that they can change, pause or stop it by saying so here.`;
  }
  if (next && (action === "update" || action === "resume")) return `Tell the person in one plain sentence what changed, saying the time zone as "${plain}", and that the next run is ${next}.`;
  if (action === "create") return "Tell the person in a sentence or two what will happen, and that they can change, pause or stop it by saying so here.";
  return "Tell the person in one sentence what will happen.";
}

function appliedText(r: Json, done: string, action: string): ToolCallResult {
  const summary = typeof r.summary === "string" && r.summary.trim() ? `\n\n${r.summary.trim()}` : "";
  const detail = typeof r.detail === "string" && r.detail.trim() ? `\n\n${r.detail.trim()}` : "";
  const id = typeof r.resultId === "string" ? r.resultId : jsonRecord(r.result) && typeof r.result.resultId === "string" ? r.result.resultId : "";
  const attention = r.settlementPending && typeof r.message === "string" ? `\n\nNeeds attention: ${r.message}`
    : jsonRecord(r.result) && typeof r.result.message === "string" ? `\n\nNeeds attention: ${r.result.message}` : "";
  return {
    text: `${done}${id ? ` (trigger id ${id})` : ""}. It applied at once; the person sees it right here in the chat, with Pause, Edit and Undo.${summary}${detail}${attention}${addressText(r)}\n\nDo not ask for confirmation. ${closingWords(r, action)}`,
  };
}

async function request(body: Json, context: ToolCallContext, done: string): Promise<ToolCallResult> {
  const { ok, status, body: r } = await context.client.apiResponse(REQUEST_ROUTE, {
    method: "POST",
    body: JSON.stringify({ fromBotId: context.botId, fromThreadId: context.threadId, ...body }),
  });
  if (!ok) {
    const error = typeof r.error === "string" ? r.error : `HTTP ${status}`;
    return { text: `The trigger change did not apply: ${error}\n\nDo not claim it was applied. Fix what the error says, or tell the person plainly what is missing.`, isError: true };
  }
  if (r.state === "pending") return { text: "Not applied yet: this check runs a command with no AI, so a card in this chat now asks the person to allow it, showing the exact command. It applies once they confirm. Tell them in one sentence and end your turn; do not set it up again." };
  return appliedText(r, done, String(body.action ?? ""));
}

/** Everything a trigger call may carry beyond the fields it sets. */
const CALL_KEYS = new Set(["action", "trigger_id", "for_bot_id", "test", "payload"]);
const CREATE_ONLY = ["when", "app", "event", "account", "engine", "repeat"] as const;

export async function callTriggerTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const forBotId = typeof args.for_bot_id === "string" && args.for_bot_id.trim() ? args.for_bot_id.trim() : undefined;
  if (name === "trigger_info") {
    if (args.action === "events") return listEvents(args, context);
    if (args.action === "usage") return listUsage(context);
    if (args.action !== undefined && args.action !== null && args.action !== "list") return { text: "trigger_info action is list, events or usage.", isError: true };
    return listTriggers(args, forBotId, context);
  }
  if (name === "trigger" && args.action === "email") return emailRoute(args, context);
  if (name === "trigger" && args.action === "note") {
    if (typeof args.note !== "string") return { text: "trigger action=note needs note: the whole notes for this automation's next run.", isError: true };
    const { ok, body } = await context.client.apiResponse(REQUEST_ROUTE, { method: "POST", body: JSON.stringify({ action: "note", note: args.note }) });
    return ok ? { text: String(body.text ?? "Saved.") } : { text: String(body.error ?? "The note was not saved."), isError: true };
  }
  if (name === "trigger" && args.action === "create") {
    if (args.trigger_id !== undefined && args.trigger_id !== null) return { text: "trigger_id is for a trigger that exists; leave it out to create one.", isError: true };
    return createTrigger(args, forBotId, context);
  }
  const triggerId = typeof args.trigger_id === "string" ? args.trigger_id.trim() : "";
  // Deleting is its own tool, so an engine's remembered allow for trigger never covers it.
  if (name === "trigger" && args.action === "delete") return { text: "trigger does not delete: call delete_trigger with the trigger_id.", isError: true };
  const action = name === "delete_trigger" ? "delete" : routineAction(args.action);
  if (!action) return { text: "trigger needs action: create, or update, pause, resume or run_now with a trigger_id from trigger_info.", isError: true };
  if (!triggerId) return { text: `${name === "delete_trigger" ? "delete_trigger" : `trigger action=${action}`} needs the trigger_id from trigger_info.`, isError: true };
  const createOnly = CREATE_ONLY.find((key) => args[key] !== undefined && args[key] !== null);
  if (createOnly) return { text: `${createOnly} applies only to action=create.`, isError: true };
  const { fields, error } = triggerFields(Object.fromEntries(Object.entries(args).filter(([key]) => !CALL_KEYS.has(key))));
  if (error) return { text: error, isError: true };
  if (args.test === true && action !== "run_now") return { text: "test applies only to action=run_now.", isError: true };
  const test = action === "run_now" && args.test === true;
  if (args.payload !== undefined && action !== "run_now") return { text: "payload applies only to action=run_now on a webhook or app event.", isError: true };
  const payload = action === "run_now" && args.payload !== undefined ? { payload: args.payload } : {};
  const body: Json = { action, triggerId, ...(forBotId ? { forBotId } : {}), ...(test ? { test: true } : {}), ...payload };
  if (action === "update") {
    if (!Object.keys(fields).length) return { text: "The update action needs at least one supported field to change.", isError: true };
    body.changes = fields;
  } else if (Object.keys(fields).length) {
    return { text: name === "delete_trigger" ? "delete_trigger takes only trigger_id and for_bot_id." : `The ${action} action changes no fields; send them with action=update.`, isError: true };
  }
  const done = test ? `Started a test run of trigger ${triggerId}: it reads what it needs and puts what it would send in its report instead of sending; its report is posted in the chat when it finishes`
    : action === "run_now" && "payload" in payload ? `Sent your sample to trigger ${triggerId}: it runs its real steps on it now, as a call from the app would, and its report is posted in the chat when it finishes. Check what it really did (the row, the email) before telling the person it works`
    : action === "run_now" ? `Started trigger ${triggerId} once now` : `Applied ${action} to trigger ${triggerId}`;
  return request(body, context, done);
}

async function listTriggers(args: Json, forBotId: string | undefined, context: ToolCallContext): Promise<ToolCallResult> {
  const query = new URLSearchParams({ fromBotId: context.botId, fromThreadId: context.threadId });
  if (typeof args.trigger_id === "string" && args.trigger_id.trim()) query.set("triggerId", args.trigger_id.trim());
  if (args.include_address === true) {
    if (!query.has("triggerId")) return { text: "include_address needs trigger_id: the webhook automation whose address you want, from trigger_info.", isError: true };
    query.set("includeAddress", "1");
  }
  if (forBotId) query.set("forBotId", forBotId);
  const everything = !query.has("triggerId") && !forBotId;
  const [r, others] = await Promise.all([context.client.api(`${LIST_ROUTE}?${query.toString()}`), everything ? alsoRunning(context) : ""]);
  const now = typeof r.now === "string" ? r.now : new Date().toISOString();
  const timeZone = typeof r.timeZone === "string" && r.timeZone ? r.timeZone : "local computer timezone";
  const clock = `current time: ${now}; timezone: ${timeZone}`;
  if (typeof r.error === "string") return { text: `${r.error} (${clock})`, isError: true };
  if (r.trigger) return { text: `Trigger (${clock}):\n${JSON.stringify(r.trigger, null, 2)}` };
  const triggers = Array.isArray(r.triggers) ? r.triggers : [];
  if (!triggers.length) return { text: `This bot has no triggers. Current time: ${now}. Timezone: ${timeZone}.${others}` };
  return { text: `This bot's triggers (${clock}):\n${JSON.stringify(triggers, null, 2)}${others}` };
}

/** The rest of what runs on its own for this bot, so "what's running for me" is one call: its background jobs and its
 * waits in every chat. A part that cannot be read here (a guest's turn, a room) is left out, never reported as none. */
async function alsoRunning(context: ToolCallContext): Promise<string> {
  const [jobs, waits] = await Promise.all([
    context.client.apiResponse(JOB_LIST_ROUTE, { method: "POST", body: JSON.stringify({ action: "list" }) }).catch(() => null),
    context.client.apiResponse(EVERY_WAIT_ROUTE).catch(() => null),
  ]);
  const part = (title: string, reply: { ok: boolean; body: Json } | null) =>
    reply?.ok && typeof reply.body.text === "string" && reply.body.text.trim() ? `\n\n${title}:\n${reply.body.text.trim()}` : "";
  return part("Background jobs (background_job)", jobs) + part("Waits, in every chat (wait_until)", waits);
}

async function emailRoute(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const triggerId = typeof args.trigger_id === "string" ? args.trigger_id.trim() : "";
  if (!triggerId && args.email_from !== undefined && args.email_from !== null) return { text: "email_from needs trigger_id: the routine or webhook automation the mail runs.", isError: true };
  if (triggerId && !Array.isArray(args.email_from)) return { text: "trigger action=email with trigger_id needs email_from: the senders it takes mail from (an empty list removes the route).", isError: true };
  const query = new URLSearchParams({ fromBotId: context.botId, fromThreadId: context.threadId });
  const { ok, body: r } = triggerId
    ? await context.client.apiResponse(`${MAIL_ROUTE}?${query.toString()}`, { method: "POST", body: JSON.stringify({ triggerId, alias: typeof args.email_alias === "string" ? args.email_alias : "", from: args.email_from }) })
    : await context.client.apiResponse(`${MAIL_ROUTE}?${query.toString()}`, { method: "GET" });
  if (!ok) return { text: `The mail setting did not apply: ${typeof r.error === "string" ? r.error : "unknown error"}. Do not claim it did.`, isError: true };
  const problem = typeof r.problem === "string" ? `\n\nNot receiving yet: ${r.problem}` : "";
  return { text: `Your mail address and its routes:\n${JSON.stringify({ address: r.address, routes: r.routes, received: r.received }, null, 2)}${problem}\n\nThe address is not a secret: give the route's address to the person or paste it where mail should come from. Mail from anyone not listed in a route is dropped without a reply.` };
}

async function listUsage(context: ToolCallContext): Promise<ToolCallResult> {
  const query = new URLSearchParams({ fromBotId: context.botId, fromThreadId: context.threadId });
  const { ok, body: r } = await context.client.apiResponse(`${USAGE_ROUTE}?${query.toString()}`, { method: "GET" });
  if (!ok || typeof r.error === "string") return { text: typeof r.error === "string" ? r.error : "The usage could not be read.", isError: true };
  return { text: `What your automations used, runs and ${r.basis === "usd" ? "approximate dollars" : "tokens"} over the last 7 and 30 days:\n${JSON.stringify(r.automations, null, 2)}\n\n${String(r.note ?? "")}` };
}

async function listEvents(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const query = new URLSearchParams({ fromBotId: context.botId, fromThreadId: context.threadId });
  if (typeof args.app === "string" && args.app.trim()) query.set("app", args.app.trim().toLowerCase());
  if (typeof args.search === "string" && args.search.trim()) query.set("search", args.search.trim().slice(0, 100));
  const r = await context.client.api(`${EVENTS_ROUTE}?${query.toString()}`);
  if (typeof r.error === "string") return { text: r.error, isError: true };
  if (typeof r.unavailable === "string") return { text: r.unavailable };
  const apps = Array.isArray(r.apps) ? r.apps : [];
  const notConnected = Array.isArray(r.notConnected) ? r.notConnected : [];
  const connect = notConnected.length
    ? `\n\nNot connected yet: ${notConnected.map((app) => jsonRecord(app) ? String(app.name) : "").filter(Boolean).join(", ")}. If the person wants one of these, ask them to connect it (call COMPOSIO_MANAGE_CONNECTIONS for that app if you have it; otherwise they connect it under Connected apps), then call trigger_info action=events again and create the trigger.`
    : "";
  if (!apps.length) return { text: `No connected app this bot may use offers events.${connect}` };
  return {
    text: `Events you can watch (delivery "poll" checks every 15 minutes; "instant" arrives at once). Filter at the source with filter for Gmail; put other required settings in event_config:\n${JSON.stringify(apps, null, 2)}${connect}`,
  };
}

async function createTrigger(args: Json, forBotId: string | undefined, context: ToolCallContext): Promise<ToolCallResult> {
  const when = args.when;
  if (when !== "schedule" && when !== "webhook" && when !== "app_event" && when !== "limit_reset") return { text: 'trigger action=create needs when: "schedule", "app_event", "webhook" or "limit_reset".', isError: true };
  if (when !== "limit_reset") {
    const limitOnly = ["engine", "repeat"].find((key) => args[key] !== undefined && args[key] !== null);
    if (limitOnly) return { text: `${limitOnly} applies only to when=limit_reset.`, isError: true };
  }
  const { fields, error } = triggerFields(args);
  if (error) return { text: error, isError: true };
  if (!fields.name || !fields.instructions) return { text: "trigger action=create needs name and instructions.", isError: true };
  if (when !== "app_event") {
    const appOnly = [...APP_ONLY, "filter", "event_config"].find((key) => args[key] !== undefined && args[key] !== null);
    if (appOnly) return { text: `${appOnly} applies only to when=app_event.`, isError: true };
  }
  if (when === "app_event") {
    const misplaced = [...SCHEDULE_ONLY, "webhook_event_types"].find((key) => args[key] !== undefined && args[key] !== null);
    if (misplaced) return { text: `An app-event trigger fires when the app's event happens, so it takes no ${misplaced}.`, isError: true };
    const app = typeof args.app === "string" ? args.app.trim().toLowerCase() : "";
    const event = typeof args.event === "string" ? args.event.trim() : "";
    if (!app || !event) return { text: "An app_event trigger needs app and event from trigger_info action=events. Call trigger_info action=events first.", isError: true };
    const trigger = {
      name: fields.name, instructions: fields.instructions, app, event,
      ...(typeof args.account === "string" && args.account.trim() ? { account: args.account.trim() } : {}),
      ...(fields.filter ? { filter: fields.filter } : {}), ...(fields.config ? { config: fields.config } : {}), ...(fields.runOn ? { runOn: fields.runOn } : {}),
    };
    return request({ action: "create", kind: "app", trigger, ...(forBotId ? { forBotId } : {}) }, context, `Created the app-event trigger “${String(fields.name)}”`);
  }
  if (when === "limit_reset") {
    const misplaced = ["schedule", "webhook_event_types", "run_on_startup", "runOnStartup"].find((key) => args[key] !== undefined && args[key] !== null);
    if (misplaced) return { text: `A limit-reset trigger runs when the engine's limit resets, so it takes no ${misplaced}.`, isError: true };
    const timing = limitResetSchedule(args.engine, args.repeat);
    if (timing.error) return { text: timing.error, isError: true };
    const { eventTypes: _unused, ...routine } = fields;
    return request({ action: "create", kind: "schedule", routine: { ...routine, schedule: timing.schedule }, ...(forBotId ? { forBotId } : {}) }, context,
      `Created the trigger “${String(fields.name)}” for when the limit resets`);
  }
  const label = `the ${when === "webhook" ? "webhook" : "schedule"} trigger “${String(fields.name)}”`;
  if (when === "schedule") {
    if (!fields.schedule) return { text: "A schedule trigger needs schedule.", isError: true };
    if (fields.eventTypes) return { text: "webhook_event_types applies only to when=webhook.", isError: true };
    const { eventTypes: _unused, ...asked } = fields;
    const routine = typeof asked.continuity === "boolean" ? asked : { ...asked, continuity: true };
    return withRepeatHint(await request({ action: "create", kind: "schedule", routine, ...(forBotId ? { forBotId } : {}) }, context, `Created ${label}`), fields);
  }
  const misplaced = SCHEDULE_ONLY.find((key) => args[key] !== undefined && args[key] !== null);
  if (misplaced) return { text: `A webhook trigger fires when its link is called, so it takes no ${misplaced}.`, isError: true };
  const webhook = { name: fields.name, instructions: fields.instructions, ...(fields.runOn ? { runOn: fields.runOn } : {}), ...(fields.eventTypes ? { eventTypes: fields.eventTypes } : {}) };
  return request({ action: "create", kind: "webhook", webhook, ...(forBotId ? { forBotId } : {}) }, context, `Created ${label}`);
}
