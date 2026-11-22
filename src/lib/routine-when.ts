// The routine editor's one "when" picker: a few plain presets and a time, mapped to and from the schedules the server
// keeps. A schedule no preset can say (a cron line, another interval, after a limit resets) stays as it is.
import type { LocaleKey } from "@/locales";
import { toLocalDateInput, toLocalTimeInput } from "@/lib/routine-calendar";
import type { RoutineIntervalWindow, RoutineSchedule, RoutineScheduleInput } from "@/lib/routines";

export type WhenPreset = "daily" | "weekdays" | "weekly" | "hourly" | "once" | "keep";

export interface WhenDraft {
  preset: WhenPreset;
  /** "HH:MM", local; "" while the typed time reads as none. */
  time: string;
  /** Sunday = 0, for "weekly". */
  day: number;
  /** "YYYY-MM-DD", local, for "once". */
  date: string;
  /** "hourly" only: the hours it runs in, null for all day, missing on a new one (the server picks the person's waking
   * hours, quiet at night). */
  window?: RoutineIntervalWindow | null;
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const HOUR_MS = 60 * 60_000;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const sameDays = (days: readonly number[], expected: readonly number[]) =>
  days.length === expected.length && [...days].sort().every((day, index) => day === expected[index]);

/** The draft a new routine starts from: every day at 9 AM, the weekly day today, the one-time date tomorrow. */
export function newWhenDraft(now = Date.now()): WhenDraft {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return { preset: "daily", time: "09:00", day: new Date(now).getDay(), date: toLocalDateInput(tomorrow.getTime()) };
}

/** The preset a saved schedule reads as, or "keep" when none says it exactly. */
export function whenDraftFor(schedule: RoutineSchedule | undefined, now = Date.now()): WhenDraft {
  const draft = newWhenDraft(now);
  if (!schedule) return draft;
  if (schedule.type === "once") return { ...draft, preset: "once", time: toLocalTimeInput(schedule.at), date: toLocalDateInput(schedule.at) };
  if (schedule.type === "daily") {
    const time = schedule.time;
    if (sameDays(schedule.weekdays, ALL_DAYS)) return { ...draft, preset: "daily", time };
    if (sameDays(schedule.weekdays, WEEKDAYS)) return { ...draft, preset: "weekdays", time };
    if (schedule.weekdays.length === 1) return { ...draft, preset: "weekly", time, day: schedule.weekdays[0]! };
  }
  if (schedule.type === "interval" && schedule.everyMinutes === 60 && !schedule.weekdays && schedule.endsAt == null) {
    return { ...draft, preset: "hourly", window: schedule.window ?? null };
  }
  return { ...draft, preset: "keep" };
}

function sameWindow(a: WhenDraft["window"], b: WhenDraft["window"]): boolean {
  return a === b || (!!a && !!b && a.start === b.start && a.end === b.end);
}

function sameWhen(a: WhenDraft, b: WhenDraft): boolean {
  if (a.preset !== b.preset) return false;
  switch (a.preset) {
    case "keep": return true;
    case "hourly": return sameWindow(a.window, b.window);
    case "once": return a.date === b.date && a.time === b.time;
    case "weekly": return a.day === b.day && a.time === b.time;
    default: return a.time === b.time;
  }
}

/** The schedule an edit saves: none while the draft still says the saved one, so its anchor and next run stay. */
export function editedSchedule(saved: WhenDraft, draft: WhenDraft, now = Date.now()): ReturnType<typeof scheduleFromDraft> {
  return sameWhen(saved, draft) ? {} : scheduleFromDraft(draft, now);
}

/** The next local hour's start: an hourly routine runs on the hour. */
export function nextLocalHour(now = Date.now()): number {
  const date = new Date(now);
  date.setMinutes(0, 0, 0);
  return date.getTime() + HOUR_MS;
}

/** The schedule a draft saves as. `keep` returns no schedule: the saved one stays untouched. */
export function scheduleFromDraft(draft: WhenDraft, now = Date.now()): { schedule?: RoutineScheduleInput; error?: LocaleKey } {
  if (draft.preset === "keep") return {};
  if (draft.preset === "hourly") {
    if (draft.window && !(TIME.test(draft.window.start) && TIME.test(draft.window.end))) return { error: "routines.inline.error.time" };
    if (draft.window && draft.window.start >= draft.window.end) return { error: "routines.inline.error.hours" };
    return { schedule: { type: "interval", everyMinutes: 60, anchorAt: nextLocalHour(now), weekdays: null, ...(draft.window === undefined ? {} : { window: draft.window }), endsAt: null } };
  }
  if (!TIME.test(draft.time)) return { error: "routines.inline.error.time" };
  if (draft.preset === "once") {
    const at = new Date(`${draft.date}T${draft.time}`).getTime();
    if (!Number.isFinite(at)) return { error: "routines.inline.error.date" };
    if (at <= now) return { error: "routines.inline.error.past" };
    return { schedule: { type: "once", at } };
  }
  const weekdays = draft.preset === "daily" ? ALL_DAYS : draft.preset === "weekdays" ? WEEKDAYS : [draft.day];
  return { schedule: { type: "daily", time: draft.time, weekdays: [...weekdays] } };
}

const NAME_CHARS = 48;

/** A name for a routine saved without one: the first clause of what it does. */
export function autoRoutineName(prompt: string): string {
  const clause = prompt.trim().replace(/^please\s+/i, "").split(/[.!?\n:;]/)[0]?.trim() ?? "";
  if (!clause) return "";
  const named = clause.charAt(0).toLocaleUpperCase() + clause.slice(1);
  if (named.length <= NAME_CHARS) return named;
  const cut = named.slice(0, NAME_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > 16 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
