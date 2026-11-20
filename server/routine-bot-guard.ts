// What a bot's new routine gets before the person sees its card: a time on the hour or half hour moves a few minutes
// (no stampede of every bot at 9:00), work that reads as the person's job runs on weekdays, a watch for something that
// happens once ends 30 days on at the latest, and a second routine with the same instructions or check is refused with
// the one already there. The person's own words win: "every day", "sharp", "every time" keep what the bot asked for.
import { createHash } from "node:crypto";

import type { RoutineRequestDefinition } from "../shared/routine-request.ts";
import type { RoutineProbe } from "../shared/routines.ts";
import { timeCritical } from "./routine-shape.ts";

export const WATCH_MAX_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
const WEEKDAYS = [1, 2, 3, 4, 5];

const PINNED = /\b(?:sharp|exactly|on the dot|precisely|no later than|not a minute)\b/i;
const EVERY_DAY = /\b(?:every ?day|each day|daily|7 days|seven days|weekends?|saturdays?|sundays?|including weekends)\b/i;
const WORK = /\b(?:work|job|office|inbox|e-?mails?|slack|stand-?ups?|meetings?|calendar|clients?|customers?|sales|leads?|pipeline|crm|deals?|jira|linear|github|pull requests?|prs?|deploys?|tickets?|support|team|invoices?|revenue|metrics|kpis?|analytics|competitors?|hiring|candidates?|recruit\w*|standup|sprint|okrs?|reports?)\b/i;
const PERSONAL = /\b(?:family|kids?|gym|workout|run(?:ning)?|health|medication|pills?|meds|garden|plants?|groceries|grocery|personal|home|weather|sports?|scores?|game|match|birthday|pets?|dog|cat|bills?|rent|church|prayer|meditat\w*|journal\w*|sleep|diet|water)\b/i;

const WHEN = /\b(?:tell|let|notify|ping|alert|message|text|email|remind|inform)\b[^.\n]{0,40}\b(?:when|once|as soon as|the moment|if)\b/i;
const HAPPENS_ONCE = new RegExp([
  String.raw`\bships?\b`, String.raw`\bshipped\b`, String.raw`\blaunch(?:es|ed)?\b`, String.raw`\breleased?\b`, String.raw`\bcomes? out\b`,
  String.raw`\b(?:is|are|it's|gets?|goes|go) (?:out|live|released|published|announced|available|approved|merged|accepted|done|ready|back|open|delivered|shipped)\b`,
  String.raw`\b(?:back )?in stock\b`, String.raw`\barrives?\b`, String.raw`\b(?:re)?opens?\b`, String.raw`\b(?:replies|responds|answers|writes back|gets back)\b`,
  String.raw`\bfinish(?:es|ed)?\b`, String.raw`\bappears?\b`, String.raw`\bbecomes? available\b`, String.raw`\bresults? (?:are|is) (?:out|up|posted)\b`,
].join("|"), "i");
const ONGOING = /\b(?:every ?time|each time|whenever|any ?time|every new|each new|all new|any new|keep (?:watching|checking|an eye|me (?:posted|updated))|ongoing|always|until i say|until (?:i|you) stop)\b/i;

const words = (definition: Pick<RoutineRequestDefinition, "name" | "instructions">) => `${definition.name}\n${definition.instructions}`;

/** Instructions that watch for something that happens once ("tell me when the new iPad ships"), not one that repeats. */
export function looksOneOff(text: string): boolean {
  return WHEN.test(text) && HAPPENS_ONCE.test(text) && !ONGOING.test(text) && !timeCritical(text);
}

function seedOf(text: string): number {
  return createHash("sha256").update(text).digest().readUInt32BE(0);
}

/** On the hour or half hour, a few minutes later (2 to 7), the same each time for the same routine. */
export function jitterTime(time: string, seed: number): string {
  const match = /^(\d{2}):(00|30)$/.exec(time);
  if (!match) return time;
  return `${match[1]}:${String(Number(match[2]) + 2 + (seed % 6)).padStart(2, "0")}`;
}

function jitterCron(expression: string, seed: number): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || !/^(?:0|30)$/.test(fields[0]!) || !/^\d{1,2}(?:,\d{1,2})*$/.test(fields[1]!)) return expression;
  return [String(Number(fields[0]) + 2 + (seed % 6)), ...fields.slice(1)].join(" ");
}

function weekdaysCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  return fields.length === 5 && fields[2] === "*" && fields[3] === "*" && fields[4] === "*" ? [...fields.slice(0, 4), "1-5"].join(" ") : expression;
}

const allWeek = (weekdays: readonly number[] | undefined) => weekdays === undefined || weekdays.length === 7;
const workOnly = (text: string) => WORK.test(text) && !PERSONAL.test(text) && !EVERY_DAY.test(text);

/** A daily or cron time a bot asked for, moved off the hour or half hour unless the person pinned it. Applies to a
 * bot's changes too, so a bot that "fixes" the moved minute gets it moved again. */
export function jitter<T extends { type: string; time?: string; expression?: string }>(schedule: T, name: string, instructions: string): T {
  if (PINNED.test(`${name}\n${instructions}`)) return schedule;
  const seed = seedOf(instructions);
  if (schedule.type === "daily" && schedule.time) return { ...schedule, time: jitterTime(schedule.time, seed) };
  if (schedule.type === "cron" && schedule.expression) return { ...schedule, expression: jitterCron(schedule.expression, seed) };
  return schedule;
}

/** The definition a bot's create proposes, with the defaults above; anything the person pinned stays as asked. */
export function guardBotDefinition(definition: RoutineRequestDefinition, now: number): RoutineRequestDefinition {
  const text = words(definition);
  const urgent = timeCritical(text);
  const schedule = definition.schedule;
  const weekdaysOnly = workOnly(text);
  if (schedule.type === "daily") {
    const weekdays = weekdaysOnly && allWeek(schedule.weekdays) ? WEEKDAYS : schedule.weekdays;
    return { ...definition, schedule: { ...jitter(schedule, definition.name, definition.instructions), weekdays: [...weekdays] } };
  }
  if (schedule.type === "cron") {
    const jittered = jitter(schedule, definition.name, definition.instructions);
    return { ...definition, schedule: weekdaysOnly ? { ...jittered, expression: weekdaysCron(jittered.expression) } : jittered };
  }
  if (schedule.type === "interval") {
    const next = { ...schedule };
    if (!urgent && allWeek(schedule.weekdays) && weekdaysOnly) next.weekdays = [...WEEKDAYS];
    if (looksOneOff(text)) {
      const cap = now + WATCH_MAX_DAYS * DAY_MS;
      if (next.endsAt === undefined || next.endsAt > cap) next.endsAt = cap;
    }
    return { ...definition, schedule: next };
  }
  return definition;
}

const whenOf = (schedule: { type: string; time?: string; weekdays?: readonly number[]; expression?: string }) =>
  JSON.stringify([schedule.type, schedule.time, schedule.weekdays, schedule.expression]);

/** A bot's new routine with the defaults, except where the bot already has one with these instructions at the time it
 * asked for: then it stays as asked, so the same request is still found to be a repeat. */
export function guardAgainst(definition: RoutineRequestDefinition, existing: ReadonlyArray<{ prompt: string; schedule: { type: string } }>, now: number): RoutineRequestDefinition {
  const asked = whenOf(definition.schedule);
  const twin = existing.some((routine) => routine.prompt.trim() === definition.instructions.trim() && whenOf(routine.schedule) === asked);
  return twin ? definition : guardBotDefinition(definition, now);
}

const sameProbe = (a: RoutineProbe | undefined, b: RoutineProbe | undefined) =>
  Boolean(a && b && a.kind === b.kind && a.url === b.url && (a.selector ?? "") === (b.selector ?? "") && (a.command ?? "") === (b.command ?? ""));

export interface ExistingRoutine { id: string; name: string; prompt: string; botId: string; enabled: boolean; probe?: RoutineProbe }

/** The bot's routine, on or paused, that already checks the same page, price, feed or script. Identical instructions and
 * settings are refused where a card is checked (routine-requests.ts). */
export function duplicateOf<T extends ExistingRoutine>(routines: readonly T[], botId: string, definition: Pick<RoutineRequestDefinition, "probe">): T | null {
  return routines.find((routine) => routine.botId === botId && sameProbe(routine.probe, definition.probe)) ?? null;
}

/** What the bot reads when it tried to make a second routine for the same thing. */
export function duplicateRefusal(existing: ExistingRoutine): string {
  const state = existing.enabled ? "it is on" : "it is paused; resume it with that trigger_id";
  return `This bot already has a routine for that: "${existing.name}" (trigger_id ${existing.id}; ${state}). ` +
    "Change that one with action update instead of making another, and tell the person it is already set up.";
}

export interface WatchFacts { prompt: string; name: string; createdAt: number; sourceThreadId?: string; schedule: { type: string } }

/** A watch a bot made from a chat for something that happens once: it ends once it has told the person. */
export function endsOnReport(routine: WatchFacts): boolean {
  return Boolean(routine.sourceThreadId) && routine.schedule.type !== "once" && routine.schedule.type !== "limit_reset" &&
    looksOneOff(`${routine.name}\n${routine.prompt}`);
}

/** Such a watch that has been looking for 30 days without the thing happening. */
export function watchExpired(routine: WatchFacts, now: number): boolean {
  return endsOnReport(routine) && now - routine.createdAt >= WATCH_MAX_DAYS * DAY_MS;
}
