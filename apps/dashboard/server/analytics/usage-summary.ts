// The admin overview's "what people use it for" answer, built from usage rollups, and the plain "where to focus" lines
// written from it by fixed rules.
import type { UsageDigest, UsageFrustration } from "../../../../shared/usage-signals.ts";
import { LATENCY_EDGES, REASON_WORDS, problemKey, type PersonDay, type SnapshotRow, type UsageRecord } from "./usage.ts";

export interface UsageRow { key: string; turns: number; failed: number; share: number; previous: number; trend: number[] }
export interface FailureRow { kind: "engine" | "tool" | "app"; key: string; turns: number; failed: number; rate: number; reason: string; reasonWords: string }
export interface ProblemGroup { key: string; engine: string; category: string; touch: string; count: number; previous: number; trend: number[]; examples: string[] }
export interface Theme { key: string; label: string; count: number; examples: string[]; pain: boolean }
export interface FocusItem { id: string; text: string; target: string; weight: number }
export interface UsageAnswer {
  from: string; to: string; days: string[]; tracked: boolean;
  totals: { turns: number; people: number; perPersonDay: number | null; success: number | null; failRate: number | null; cancelRate: number | null; p50Ms: number | null; p90Ms: number | null;
    runs: number; runSuccess: number | null; frustrations: number; digests: number };
  previous: { turns: number; people: number; failRate: number | null };
  series: number[];
  categories: UsageRow[]; tools: UsageRow[]; apps: UsageRow[]; engines: Array<UsageRow & { p50Ms: number | null }>; sources: UsageRow[]; places: UsageRow[];
  failures: FailureRow[];
  reasons: Array<{ key: string; count: number; words: string }>;
  routines: { made: { routines: number; webhooks: number; appEvents: number }; peopleWithRoutines: number; peopleRan: number; peopleRanTwice: number; runs: number; failed: number;
    byTrigger: UsageRow[] };
  people: { total: number; buckets: Array<{ key: string; label: string; count: number }>; activeDays: Array<{ key: string; label: string; count: number }>; topShare: number | null; medianTurns: number | null };
  adoption: Array<{ id: string; label: string; count: number }>;
  frustration: { total: number; previous: number; groups: ProblemGroup[]; signals: Array<{ key: string; count: number }> };
  themes: Theme[];
  focus: FocusItem[];
}
export interface AdoptionInput { accounts: number; bot: number; routine: number; connector: number; phone: number; cloud: number }

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const rate = (part: number, whole: number) => whole > 0 ? part / whole : null;
const pct = (value: number) => `${Math.round(value * 100)}%`;
const words = (key: string) => key.replace(/_/g, " ");

function percentile(buckets: number[], p: number): number | null {
  const total = sum(buckets);
  if (!total) return null;
  let seen = 0;
  for (const [index, count] of buckets.entries()) { seen += count; if (seen / total >= p) { const edge = LATENCY_EDGES[index]!; return Number.isFinite(edge) ? edge * 1000 : 900_000; } }
  return null;
}

/** every key under a prefix in the rollups, as rows with a per-day trend and the previous window's total */
function rows(days: string[], current: Map<string, Record<string, number>>, previous: Record<string, number>, prefix: string): UsageRow[] {
  const keys = new Set<string>();
  for (const c of current.values()) for (const key of Object.keys(c)) if (key.startsWith(`${prefix}:`)) keys.add(key.slice(prefix.length + 1));
  const failPrefix = prefix === "run" ? "run_fail" : `${prefix}_fail`;
  const list = [...keys].map(key => {
    const trend = days.map(day => current.get(day)?.[`${prefix}:${key}`] ?? 0);
    return { key, turns: sum(trend), failed: sum(days.map(day => current.get(day)?.[`${failPrefix}:${key}`] ?? 0)), share: 0, previous: previous[`${prefix}:${key}`] ?? 0, trend };
  });
  const total = sum(list.map(row => row.turns));
  for (const row of list) row.share = total ? row.turns / total : 0;
  return list.sort((a, b) => b.turns - a.turns);
}

const THEMES: Array<{ key: string; label: string; pattern: RegExp; pain?: true }> = [
  { key: "email", label: "email and inbox", pattern: /\b(?:e-?mails?|inbox|mail|repl(?:y|ies)|newsletter)/ },
  { key: "calendar", label: "calendar and scheduling", pattern: /\b(?:calendar|meeting|schedul|appointment|availability)/ },
  { key: "coding", label: "coding and building", pattern: /\b(?:code|coding|bug|repo|deploy|script|website|app development|programm)/ },
  { key: "research", label: "research and reading", pattern: /\b(?:research|search|look(?:ing)? up|summar|article|news|compare|reading)/ },
  { key: "writing", label: "writing and editing", pattern: /\b(?:writ|draft|blog|copy|essay|edit|proofread)/ },
  { key: "data", label: "spreadsheets and numbers", pattern: /\b(?:spreadsheet|sheet|data|report|finance|budget|invoice|receipt|accounting)/ },
  { key: "social", label: "social posting", pattern: /\b(?:social|tweet|post(?:s|ing)?\b|followers|audience)/ },
  { key: "automation", label: "routines and automation", pattern: /\b(?:routine|automat|recurring|every (?:day|morning|week)|remind)/ },
  { key: "files", label: "files and documents", pattern: /\b(?:files?|documents?|pdf|folder|notes)\b/ },
  { key: "life", label: "personal life and planning", pattern: /\b(?:travel|trip|flight|shopping|recipe|workout|health|plan(?:ning)? (?:a|their))/ },
  { key: "learning", label: "learning and explaining", pattern: /\b(?:learn|study|tutor|explain|language practice)/ },
  { key: "slow", label: "slowness", pattern: /\b(?:slow|takes? too long|waiting|lag)/, pain: true },
  { key: "failures", label: "things failing", pattern: /\b(?:fail|error|broke|crash|doesn't work|didn't work|not working)/, pain: true },
  { key: "connecting", label: "connecting apps and signing in", pattern: /\b(?:connect(?:ing|ed)? (?:an? |the )?\w+|sign(?:ing|ed)? ?in|log(?:ging|ged)? ?in|re-?auth|permission)/, pain: true },
  { key: "retries", label: "needing several tries", pattern: /\b(?:\d+|several|many|few) (?:tries|attempts|retries)|\bretr(?:y|ied)|tried again/, pain: true },
  { key: "confusing", label: "confusing setup", pattern: /\b(?:confus|unclear|hard to (?:set|find|understand)|setup|set up)/, pain: true },
  { key: "memory", label: "forgetting context", pattern: /\b(?:forg[eo]t|lost (?:track|context)|remember)/, pain: true },
  { key: "wants", label: "asks for more", pattern: /\b(?:wants?|wish|would like|hope|next|more)\b/ },
];
/** notes grouped into themes by the words they use */
export function themesOf(summaries: string[]): Theme[] {
  return THEMES.map(theme => {
    const hits = summaries.filter(text => theme.pattern.test(text));
    return { key: theme.key, label: theme.label, count: hits.length, examples: hits.slice(0, 3), pain: !!theme.pain };
  }).filter(theme => theme.count > 0).sort((a, b) => b.count - a.count);
}

export function summarize(input: {
  days: string[];
  daily: Array<{ day: string; c: Record<string, number> }>; previousDaily: Array<{ day: string; c: Record<string, number> }>;
  people: PersonDay[]; previousPeople: number; snapshots: SnapshotRow[]; frustrations: UsageRecord[]; digests: UsageRecord[]; adoption: AdoptionInput;
}): UsageAnswer {
  const { days } = input;
  const current = new Map(input.daily.map(row => [row.day, row.c]));
  const previous: Record<string, number> = {};
  for (const row of input.previousDaily) for (const [key, value] of Object.entries(row.c)) previous[key] = (previous[key] ?? 0) + value;
  const total = (key: string) => sum(days.map(day => current.get(day)?.[key] ?? 0));
  const turns = total("turns"), failed = total("failed"), cancelled = total("cancelled");
  const latency = LATENCY_EDGES.map((_, index) => total(`lat:${index}`));
  const peopleRows = input.people, perPerson = new Map<string, { turns: number; days: number; runs: number }>();
  for (const row of peopleRows) { const p = perPerson.get(row.accountId) ?? { turns: 0, days: 0, runs: 0 }; p.turns += row.turns; p.runs += row.runs; if (row.turns > 0) p.days++; perPerson.set(row.accountId, p); }
  const active = [...perPerson.values()].filter(p => p.turns > 0);

  const engines = rows(days, current, previous, "engine").map(row => ({ ...row, p50Ms: percentile(LATENCY_EDGES.map((_, i) => total(`lat_engine:${row.key}:${i}`)), 0.5) }));
  const tools = rows(days, current, previous, "tool"), apps = rows(days, current, previous, "app");
  const reasonOf = (scope: string, key: string) => {
    const found = Object.keys(previous).concat(...[...current.values()].map(c => Object.keys(c))).filter(name => name.startsWith(`reason_${scope}:${key}:`));
    const counts = new Map<string, number>();
    for (const name of new Set(found)) counts.set(name.slice(`reason_${scope}:${key}:`.length), total(name));
    const top = [...counts].sort((a, b) => b[1] - a[1])[0];
    return top && top[1] > 0 ? top[0] : "unknown";
  };
  const failures: FailureRow[] = [
    ...engines.map(row => ({ kind: "engine" as const, row })), ...tools.filter(row => row.key !== "other").map(row => ({ kind: "tool" as const, row })), ...apps.map(row => ({ kind: "app" as const, row })),
  ].filter(({ row }) => row.failed > 0).map(({ kind, row }) => {
    const reason = reasonOf(kind, row.key);
    return { kind, key: row.key, turns: row.turns, failed: row.failed, rate: row.turns ? row.failed / row.turns : 0, reason, reasonWords: REASON_WORDS[reason as keyof typeof REASON_WORDS] ?? words(reason) };
  }).sort((a, b) => b.failed - a.failed || b.rate - a.rate);

  const made = { routines: 0, webhooks: 0, appEvents: 0 }, withRoutines = new Set<string>();
  for (const row of input.snapshots) {
    made.routines += row.snapshot.routines; made.webhooks += row.snapshot.webhooks; made.appEvents += row.snapshot.appEvents;
    if (row.snapshot.routines + row.snapshot.webhooks + row.snapshot.appEvents > 0) withRoutines.add(row.accountId);
  }
  const ran = [...perPerson].filter(([id, p]) => withRoutines.has(id) && p.runs >= 1), ranTwice = ran.filter(([, p]) => p.runs >= 2);

  const BUCKETS: Array<[string, string, number, number]> = [["1_5", "1-5 turns", 1, 5], ["6_20", "6-20", 6, 20], ["21_100", "21-100", 21, 100], ["101_500", "101-500", 101, 500], ["500_", "500+", 501, Infinity]];
  const DAY_BUCKETS: Array<[string, string, number, number]> = [["1", "1 day", 1, 1], ["2_3", "2-3 days", 2, 3], ["4_7", "4-7 days", 4, 7], ["8_15", "8-15 days", 8, 15], ["16_", "16+ days", 16, Infinity]];
  const sortedTurns = active.map(p => p.turns).sort((a, b) => b - a);
  const top = sortedTurns.slice(0, Math.max(1, Math.ceil(sortedTurns.length / 10)));

  const groupDays = new Map<string, number[]>();
  for (const [index, day] of days.entries()) for (const [key, value] of Object.entries(current.get(day) ?? {})) if (key.startsWith("fr_group:")) {
    const trend = groupDays.get(key.slice(9)) ?? days.map(() => 0); trend[index] = value; groupDays.set(key.slice(9), trend);
  }
  const examples = new Map<string, string[]>();
  for (const record of input.frustrations) {
    const f = record.data as UsageFrustration;
    if (!f.summary) continue;
    const list = examples.get(problemKey(f)) ?? [];
    if (list.length < 3) list.push(f.summary);
    examples.set(problemKey(f), list);
  }
  const groups: ProblemGroup[] = [...groupDays].map(([key, trend]) => {
    const [engine = "other", category = "other", touch = "none"] = key.split("|");
    return { key, engine, category, touch, count: sum(trend), previous: previous[`fr_group:${key}`] ?? 0, trend, examples: examples.get(key) ?? [] };
  }).sort((a, b) => b.count - a.count);

  const answer: UsageAnswer = {
    from: days[0]!, to: days.at(-1)!, days, tracked: turns + total("runs") + total("frustrations") + total("digests") > 0,
    totals: { turns, people: active.length, perPersonDay: rate(turns, sum(active.map(p => p.days))), success: rate(turns - failed - cancelled, turns), failRate: rate(failed, turns), cancelRate: rate(cancelled, turns),
      p50Ms: percentile(latency, 0.5), p90Ms: percentile(latency, 0.9), runs: total("runs"), runSuccess: rate(total("runs") - total("run_failed"), total("runs")), frustrations: total("frustrations"), digests: total("digests") },
    previous: { turns: previous.turns ?? 0, people: input.previousPeople, failRate: rate(previous.failed ?? 0, previous.turns ?? 0) },
    series: days.map(day => current.get(day)?.turns ?? 0),
    categories: rows(days, current, previous, "category"), tools, apps, engines, sources: rows(days, current, previous, "from"), places: rows(days, current, previous, "place"),
    failures: failures.slice(0, 30),
    reasons: [...new Set([...current.values()].flatMap(c => Object.keys(c)).filter(key => key.startsWith("reason:")))].map(key => ({ key: key.slice(7), count: total(key), words: REASON_WORDS[key.slice(7) as keyof typeof REASON_WORDS] ?? words(key.slice(7)) })).sort((a, b) => b.count - a.count),
    routines: { made, peopleWithRoutines: withRoutines.size, peopleRan: ran.length, peopleRanTwice: ranTwice.length, runs: total("runs"), failed: total("run_failed"), byTrigger: rows(days, current, previous, "run") },
    people: {
      total: active.length,
      buckets: BUCKETS.map(([key, label, lo, hi]) => ({ key, label, count: active.filter(p => p.turns >= lo && p.turns <= hi).length })),
      activeDays: DAY_BUCKETS.map(([key, label, lo, hi]) => ({ key, label, count: active.filter(p => p.days >= lo && p.days <= hi).length })),
      topShare: sortedTurns.length >= 5 ? rate(sum(top), sum(sortedTurns)) : null,
      medianTurns: sortedTurns.length ? sortedTurns[Math.floor((sortedTurns.length - 1) / 2)]! : null,
    },
    adoption: [
      { id: "accounts", label: "signed up", count: input.adoption.accounts }, { id: "bot", label: "first bot", count: input.adoption.bot },
      { id: "routine", label: "first routine", count: input.adoption.routine }, { id: "connector", label: "first connected app", count: input.adoption.connector },
      { id: "phone", label: "on their phone", count: input.adoption.phone }, { id: "cloud", label: "on a cloud", count: input.adoption.cloud },
    ],
    frustration: { total: total("frustrations"), previous: previous.frustrations ?? 0, groups: groups.slice(0, 20),
      signals: [...new Set([...current.values()].flatMap(c => Object.keys(c)).filter(key => key.startsWith("fr_signal:")))].map(key => ({ key: key.slice(10), count: total(key) })).sort((a, b) => b.count - a.count) },
    themes: themesOf(input.digests.map(record => (record.data as UsageDigest).summary)),
    focus: [],
  };
  answer.focus = focusRules(answer);
  return answer;
}

const TOUCH: Record<string, string> = { browser: "the browser", computer: "the computer", terminal: "the terminal", files: "files", web: "web search", x: "X search", image: "images", data: "data tools", app: "connected apps", mcp: "mcp tools" };
const touchWords = (key: string) => TOUCH[key] ?? key;

/** 3 to 5 plain lines on where to look first, strongest first; fixed rules over the answer, nothing guessed */
export function focusRules(a: UsageAnswer): FocusItem[] {
  const out: FocusItem[] = [];
  const overall = a.totals.failRate ?? 0;
  for (const [rank, app] of a.apps.slice(0, 5).entries()) {
    const failure = a.failures.find(row => row.kind === "app" && row.key === app.key);
    if (app.turns >= 20 && failure && failure.rate >= 0.1) {
      out.push({ id: `app:${app.key}`, target: "apps", weight: 90 - rank * 5 + failure.rate * 50,
        text: `${app.key} is the #${rank + 1} app, but ${pct(failure.rate)} of its turns fail (mostly ${failure.reasonWords}): fix that first.` });
      break;
    }
  }
  const worstEngine = a.failures.filter(row => row.kind === "engine" && row.turns >= 30 && row.rate >= Math.max(0.08, overall * 1.5)).sort((x, y) => y.failed - x.failed)[0];
  if (worstEngine) out.push({ id: `engine:${worstEngine.key}`, target: "failures", weight: 70 + worstEngine.rate * 50,
    text: `${worstEngine.key} fails ${pct(worstEngine.rate)} of turns against ${pct(overall)} overall${worstEngine.reason === "unknown" ? "" : `, mostly because ${worstEngine.reasonWords}`}.` });
  const worstTool = a.failures.filter(row => row.kind === "tool" && row.turns >= 20 && row.rate >= 0.15).sort((x, y) => y.failed - x.failed)[0];
  if (worstTool) out.push({ id: `tool:${worstTool.key}`, target: "tools", weight: 60 + worstTool.rate * 40,
    text: `turns that use ${touchWords(worstTool.key)} fail ${pct(worstTool.rate)} of the time (${worstTool.reasonWords}).` });
  const top = a.frustration.groups[0];
  if (top && top.count >= 3) out.push({ id: `problem:${top.key}`, target: "frustration", weight: 75 + top.count,
    text: `${top.count} chats got frustrated doing ${words(top.category)} with ${touchWords(top.touch)} on ${top.engine}${top.examples[0] ? `: "${top.examples[0]}"` : "."}` });
  const r = a.routines;
  if (r.peopleWithRoutines >= 3) {
    const twice = r.peopleRanTwice / r.peopleWithRoutines;
    if (twice < 0.6) out.push({ id: "routines", target: "routines", weight: 65 + (0.6 - twice) * 50, text: `people make routines, but only ${pct(twice)} of them had one run twice: look at routine reliability.` });
  }
  if (r.runs >= 20 && r.failed / r.runs >= 0.15) out.push({ id: "routine-fails", target: "routines", weight: 60, text: `${pct(r.failed / r.runs)} of routine runs fail: routines are a trust feature, fix this.` });
  // the steps are not nested (a phone can come before a routine), so each is weighed against the people with a bot
  const bots = a.adoption.find(step => step.id === "bot")?.count ?? 0;
  const NEXT: Record<string, string> = { routine: "make a routine", connector: "connect an app", phone: "use it on their phone" };
  const gap = a.adoption.filter(step => step.id in NEXT).map(step => ({ step, share: bots ? step.count / bots : 1 })).sort((x, y) => x.share - y.share)[0];
  if (gap && bots >= 5 && gap.share < 0.5) out.push({ id: "adoption", target: "adoption", weight: 55 + (0.5 - gap.share) * 40,
    text: `only ${pct(gap.share)} of people with a bot ${NEXT[gap.step.id]}: make that easier to find.` });
  const cat = a.categories[0];
  if (cat && a.totals.turns >= 30) {
    const growth = cat.previous ? (cat.turns - cat.previous) / cat.previous : null;
    out.push({ id: `category:${cat.key}`, target: "categories", weight: 40 + (growth ?? 0) * 10,
      text: `${words(cat.key)} is what people use it for most (${pct(cat.share)} of turns)${growth !== null && growth > 0.1 ? `, up ${pct(growth)}` : ""}: lean into it.` });
  }
  if (a.totals.p90Ms !== null && a.totals.p90Ms >= 120_000 && a.totals.turns >= 30) out.push({ id: "latency", target: "engines", weight: 50,
    text: `slow replies: 1 in 10 turns takes ${a.totals.p90Ms >= 300_000 ? "over 5 minutes" : "over 2 minutes"}.` });
  const pain = a.themes.find(theme => theme.pain && theme.count >= 2);
  if (pain) out.push({ id: `theme:${pain.key}`, target: "themes", weight: 50 + pain.count, text: `weekly notes keep mentioning ${pain.label} as a pain (${pain.count} people).` });
  if (a.people.topShare !== null && a.people.topShare >= 0.6) out.push({ id: "power", target: "people", weight: 35, text: `the top 10% of people do ${pct(a.people.topShare)} of all turns: talk to them, they know what's missing.` });
  return out.sort((x, y) => y.weight - x.weight).slice(0, 5);
}
