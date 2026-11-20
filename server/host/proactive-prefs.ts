// What the person wants to hear about without asking, kept as one memory topic of the proactive bot
// (memory/proactive.md, "What to tell me about" under What it remembers), in their words, so they can read and edit it:
//   ## Tell me about        - lines the bot looks out for
//   ## Never tell me about  - lines it leaves out of anything it sends unasked
//   ## Quiet hours          - one "21:30 to 08:00" line: nothing unasked in between
// Suggestions, the day watch and every routine run read it; memory_update action notify and "Stop sending me these"
// write it.
import type { RoutineIntervalWindow } from "../../shared/routines.ts";
import { validZone } from "./check-plan.ts";

export const PROACTIVE_TOPIC = "proactive.md";
export type ProactiveRule = "tell" | "never" | "quiet";
export interface QuietHours { from: string; to: string }
export interface ProactivePrefs { tell: string[]; never: string[]; quiet: QuietHours | null }

const MAX_LINES = 30;
const LINE_CHARS = 200;
const HEADER = [
  "---",
  "title: What to tell me about",
  "description: What dusk bot tells you about without being asked, what it never does, and when it stays quiet. Edit or delete any line.",
  "aliases: notifications, proactive, quiet hours, don't tell me, ping me, alerts, updates",
  "---",
  "",
];
const QUIET = /\b([01]?\d|2[0-3])(?::([0-5]\d))?\s*(?:to|until|till|-|–)\s*([01]?\d|2[0-3])(?::([0-5]\d))?\b/i;

const clean = (text: string) => text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").replace(/^[-*\s]+/, "").trim().slice(0, LINE_CHARS);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const pad = (hour: string, minute: string | undefined) => `${hour.padStart(2, "0")}:${minute ?? "00"}`;

export function parseQuiet(text: string): QuietHours | null {
  const match = QUIET.exec(text);
  if (!match) return null;
  const from = pad(match[1]!, match[2]), to = pad(match[3]!, match[4]);
  return from === to ? null : { from, to };
}

export function parsePrefs(text: string | null): ProactivePrefs {
  const prefs: ProactivePrefs = { tell: [], never: [], quiet: null };
  if (!text) return prefs;
  let section: ProactiveRule | null = null;
  for (const raw of text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").split("\n")) {
    const heading = /^#{1,6}\s+(.+)$/.exec(raw.trim())?.[1]?.toLowerCase();
    if (heading) {
      section = /\bnever\b|\bdon'?t\b|\bnot\b/.test(heading) ? "never" : /quiet/.test(heading) ? "quiet" : /tell|ping|always/.test(heading) ? "tell" : null;
      continue;
    }
    const line = /^\s*[-*]\s+(.+)$/.exec(raw)?.[1];
    if (!line || !section) continue;
    if (section === "quiet") prefs.quiet ??= parseQuiet(line);
    else {
      const kept = clean(line);
      if (kept && !prefs[section].some((one) => same(one, kept)) && prefs[section].length < MAX_LINES) prefs[section].push(kept);
    }
  }
  return prefs;
}

export function renderPrefs(prefs: ProactivePrefs): string {
  const list = (lines: readonly string[]) => lines.map((line) => `- ${line}`);
  return [
    ...HEADER,
    "## Tell me about", ...list(prefs.tell), "",
    "## Never tell me about", ...list(prefs.never), "",
    "## Quiet hours", ...(prefs.quiet ? [`- ${prefs.quiet.from} to ${prefs.quiet.to}`] : []), "",
  ].join("\n");
}

/** The rule added: a tell line drops the same never line and the other way round, so the newest word wins. Null when
 * the text is not a rule (no words, or quiet hours without two times). */
export function withRule(prefs: ProactivePrefs, rule: ProactiveRule, text: string): ProactivePrefs | null {
  if (rule === "quiet") {
    const quiet = parseQuiet(text);
    return quiet ? { ...prefs, quiet } : null;
  }
  const line = clean(text);
  if (!line) return null;
  const other = rule === "tell" ? "never" : "tell";
  if (prefs[rule].some((one) => same(one, line))) return prefs;
  const kept = prefs[rule].filter((one) => !same(one, line));
  return { ...prefs, [other]: prefs[other].filter((one) => !same(one, line)), [rule]: [...kept, line].slice(-MAX_LINES) };
}

const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

export function localMinute(at: number, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: validZone(timeZone) ?? "UTC", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(at));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return (value("hour") % 24) * 60 + value("minute");
}

export function isQuiet(quiet: QuietHours | null, minute: number): boolean {
  if (!quiet) return false;
  const from = minutes(quiet.from), to = minutes(quiet.to);
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/** A waking window narrowed to the hours outside the person's quiet hours; the window itself when they leave none. */
export function outsideQuiet(window: RoutineIntervalWindow | null, quiet: QuietHours | null): RoutineIntervalWindow | null {
  if (!quiet || minutes(quiet.from) <= minutes(quiet.to)) return window;
  const start = window && minutes(window.start) > minutes(quiet.to) ? window.start : quiet.to;
  const end = window && minutes(window.end) < minutes(quiet.from) ? window.end : quiet.from;
  return minutes(start) < minutes(end) ? { start, end } : window;
}

/** A never line that names this (its words all in it), for code that picks what to offer. */
export function neverAbout(prefs: ProactivePrefs, text: string): string | null {
  const haystack = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return prefs.never.find((line) => {
    const words = line.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2);
    return words.length > 0 && words.every((word) => haystack.includes(` ${word}`));
  }) ?? null;
}

/** The block a run that may message the person unasked reads, or "" when they set nothing. Their own words: data, not
 * instructions to anyone else. */
export function prefsBlock(prefs: ProactivePrefs): string {
  if (!prefs.tell.length && !prefs.never.length && !prefs.quiet) return "";
  return [
    "[dusk bot: what the person told you about messages they did not ask for, from their notes. Leave out anything under Never; what is under Tell is worth a short message when it comes up.]",
    ...(prefs.tell.length ? ["Tell: " + prefs.tell.join("; ")] : []),
    ...(prefs.never.length ? ["Never: " + prefs.never.join("; ")] : []),
    ...(prefs.quiet ? [`Quiet hours: ${prefs.quiet.from} to ${prefs.quiet.to}; nothing that can wait is sent then.`] : []),
  ].join("\n");
}

export interface ProactivePrefsDeps {
  /** The proactive bot (proactiveOwner), whose memory holds the file; null on a team, where no one person owns it. */
  owner(): { id: string } | null;
  read(botId: string): string | null;
  write(botId: string, before: string | null, after: string, actor: "bot" | "person"): void;
}

export function createProactivePrefs(deps: ProactivePrefsDeps) {
  const get = (): ProactivePrefs => {
    const owner = deps.owner();
    return owner ? parsePrefs(deps.read(owner.id)) : { tell: [], never: [], quiet: null };
  };
  return {
    get,
    /** Saves one rule in the person's file: "saved", "known" when it was there already, null when it can't be saved. */
    rule(rule: ProactiveRule, text: string, actor: "bot" | "person" = "bot"): "saved" | "known" | null {
      const owner = deps.owner();
      if (!owner) return null;
      const before = deps.read(owner.id);
      const next = withRule(parsePrefs(before), rule, text);
      if (!next) return null;
      const after = renderPrefs(next);
      if (after === (before ?? "") || (before !== null && renderPrefs(parsePrefs(before)) === after)) return "known";
      deps.write(owner.id, before, after, actor);
      return "saved";
    },
    block: (): string => prefsBlock(get()),
  };
}

export type ProactivePrefsStore = ReturnType<typeof createProactivePrefs>;
