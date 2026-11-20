// The admin's "how sessions went" view: every note a workspace sent (after a bad chat, after a big session, and
// weekly), newest first, with the friction they share grouped at the top. Notes are scrubbed on the workspace and
// checked again on the way in; a note carries its account id only so the admin can open that person.
import type { UsageDigest, UsageFrustration, UsageSession } from "../../../../shared/usage-signals.ts";
import { themesOf, type Theme } from "./usage-summary.ts";
import type { UsageRan, UsageRecord, UsageStore } from "./usage.ts";

export const FEEDBACK_KINDS = ["bad", "big", "weekly"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
const RECORD_KIND = { bad: "frustration", big: "session", weekly: "digest" } as const;
export interface FeedbackNote {
  id: string; kind: FeedbackKind; at: number;
  /** the note itself; null when the workspace sent only the counts */
  text: string | null;
  engine?: string; category?: string; tools?: string[]; apps?: string[];
  /** the account the note came from, for the link to that person's page */
  person?: string;
  /** where it ran ("mac", "cloud", "own server") and the app version, when the workspace said */
  where?: string; version?: string;
  /** bad: what the person did, and the follow-ups that repeated the request */
  signals?: string[]; retries?: number;
  /** big: the session's size; weekly: turns and active days that week */
  turns?: number; minutes?: number; failed?: number; days?: number;
}
export interface FeedbackAnswer {
  notes: FeedbackNote[];
  /** pass as `before` for the next page; null at the end */
  next: number | null;
  /** notes per kind over the last THEME_DAYS days */
  counts: Record<FeedbackKind, number>;
  /** true when a kind had more than FEEDBACK_MAX notes in the window, so its count stops there */
  countsCapped: boolean;
  /** themes across the notes of the last THEME_DAYS days, friction first */
  themes: Theme[];
}
export const THEME_DAYS = 30, FEEDBACK_PAGE = 50, FEEDBACK_SCAN = 500, FEEDBACK_MAX = 50_000;
const DAY = 86_400_000;

const OS_WORD: Record<string, string> = { mac: "mac", windows: "windows", linux: "linux" };
/** "mac", "cloud" or "own server" */
export function whereWord(ran: UsageRan): string {
  return ran.place === "cloud" ? "cloud" : ran.place === "server" ? "own server" : OS_WORD[ran.os ?? ""] ?? "desktop";
}

export function feedbackNote(record: UsageRecord): FeedbackNote | null {
  const own = { ...(record.accountId ? { person: record.accountId } : {}), ...(record.ran ? { where: whereWord(record.ran), ...(record.ran.version ? { version: record.ran.version } : {}) } : {}) };
  if (record.kind === "frustration") {
    const f = record.data as UsageFrustration;
    return { id: record.id, kind: "bad", at: record.at, text: f.summary ?? null, engine: f.engine, category: f.category, tools: f.tools, apps: f.apps, signals: f.signals, retries: f.retries, ...own };
  }
  if (record.kind === "session") {
    const s = record.data as UsageSession;
    return { id: record.id, kind: "big", at: record.at, text: s.summary ?? null, engine: s.engine, category: s.category, tools: s.tools, apps: s.apps, turns: s.turns, minutes: s.minutes, failed: s.failed, ...own };
  }
  if (record.kind === "digest") {
    const d = record.data as UsageDigest;
    return { id: record.id, kind: "weekly", at: record.at, text: d.summary, turns: d.turns, days: d.days, ...own };
  }
  return null;
}

/** every record of a kind in [since, until), read a page at a time, up to `max` */
export async function allRecords(store: UsageStore, kind: UsageRecord["kind"], since: number, until: number, max = FEEDBACK_MAX): Promise<{ rows: UsageRecord[]; capped: boolean }> {
  const rows: UsageRecord[] = [], seen = new Set<string>();
  let end = until;
  while (rows.length < max) {
    const page = await store.records(kind, since, end, FEEDBACK_SCAN);
    const fresh = page.filter(record => !seen.has(record.id));
    for (const record of fresh) { seen.add(record.id); rows.push(record); }
    if (page.length < FEEDBACK_SCAN || !fresh.length) return { rows, capped: false };
    // the next page starts at the oldest time read, so records sharing that millisecond are not skipped
    end = page.at(-1)!.at + 1;
  }
  return { rows: rows.slice(0, max), capped: true };
}

export async function feedbackAnswer(store: UsageStore, input: { now: number; kind: FeedbackKind | null; before: number | null; limit?: number;
  /** notes that stay out (test accounts', harness installs'); the page cursor still walks past them */
  hidden?: (record: UsageRecord) => boolean }): Promise<FeedbackAnswer> {
  const kinds = input.kind ? [input.kind] : [...FEEDBACK_KINDS], limit = input.limit ?? FEEDBACK_PAGE;
  const until = input.before ?? input.now + 1, since = input.now - 90 * DAY, recent = input.now - THEME_DAYS * DAY;
  const [pages, ...windows] = await Promise.all([
    Promise.all(kinds.map(kind => store.records(RECORD_KIND[kind], since, until, limit + 1))),
    ...FEEDBACK_KINDS.map(kind => allRecords(store, RECORD_KIND[kind], recent, input.now + 1)),
  ]);
  const hidden = input.hidden, kept = (record: UsageRecord) => !hidden || !hidden(record);
  const page = pages.flat().sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).map(record => ({ record, note: feedbackNote(record) })).filter(row => !!row.note);
  const walked = page.slice(0, limit), shown = walked.filter(row => kept(row.record)).map(row => row.note!);
  const ownWindows = windows.map(window => window.rows.filter(kept));
  const counts = Object.fromEntries(FEEDBACK_KINDS.map((kind, index) => [kind, ownWindows[index]!.length])) as Record<FeedbackKind, number>;
  const texts = FEEDBACK_KINDS.flatMap((kind, index) => input.kind && input.kind !== kind ? [] : ownWindows[index]!.map(feedbackNote).map(note => note?.text).filter((text): text is string => !!text));
  const themes = themesOf(texts).sort((a, b) => Number(b.pain) - Number(a.pain) || b.count - a.count);
  return { notes: shown, next: page.length > limit ? walked.at(-1)!.record.at : null, counts, countsCapped: windows.some(window => window.capped), themes };
}
