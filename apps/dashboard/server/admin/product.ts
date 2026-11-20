import type { StoredEvent } from "../analytics/sink.ts";
import { DAY } from "../analytics/web.ts";
import { pack, unpack, type Digest } from "../analytics/rollup.ts";

export interface FunnelStepIn { id: string; label: string; count: number }
export interface ProductInput { from: number; to: number; events: StoredEvent[]; funnel: FunnelStepIn[] }

interface Count { key: string; count: number; people: number }
export interface FeatureRow { feature: string; people: number; uses: number; adoption: number | null; repeat: number | null; triedOnce: number; lift: number | null }
export interface Improvement { area: "funnel" | "errors" | "rating" | "features" | "onboarding" | "site" | "bots"; title: string; detail: string; weight: number }

/** below this many people a rate is noise, so it is not ranked */
export const MIN_PEOPLE = 3;
const POSITIVE = new Set(["yes", "love", "laugh", "celebrate"]);
const SUBKEYS = ["action", "result", "step", "view", "reason", "emoji", "variant", "source", "plan", "kind"] as const;

const whoOf = (event: StoredEvent) => event.accountId ?? event.ctx?.install ?? event.ctx?.visitor ?? null;
const dayIndex = (at: number) => Math.floor(at / DAY);
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};
const rate = (part: number, whole: number) => whole > 0 ? part / whole : null;
const words = (value: string) => value.replace(/_/g, " ");

type Tally = Map<string, { count: number; people: Set<string> }>;
function count(map: Tally, key: string | null, who: string | null) {
  if (!key) return;
  const row = map.get(key) ?? map.set(key, { count: 0, people: new Set() }).get(key)!;
  row.count++;
  if (who) row.people.add(who);
}
function mergeTally(into: Tally, later: Tally) {
  for (const [key, row] of later) {
    const mine = into.get(key);
    if (!mine) { into.set(key, row); continue; }
    mine.count += row.count;
    for (const who of row.people) mine.people.add(who);
  }
}
const rowsOf = (map: Tally, limit = 20): Count[] => [...map].map(([k, row]) => ({ key: k, count: row.count, people: row.people.size })).sort((a, b) => b.count - a.count || b.people - a.people).slice(0, limit);
function tally(events: StoredEvent[], key: (event: StoredEvent) => string | null, limit = 20): Count[] {
  const map: Tally = new Map();
  for (const event of events) count(map, key(event), whoOf(event));
  return rowsOf(map, limit);
}

/**
 * features ranked by how many people use them, how many come back to them, and whether their users stay;
 * lift is the share of a feature's users active in the window's last week minus the same share for everyone else
 */
export function featureRows(events: StoredEvent[], from: number, to: number): FeatureRow[] {
  const digest = productDigest.empty();
  for (const event of events) productDigest.add(digest, event);
  return featureRowsOf(digest, from, to);
}
function featureRowsOf(digest: ProductDigest, from: number, to: number): FeatureRow[] {
  const lastWeek = Math.max(from, to - 7 * DAY);
  const appPeople = digest.app.size, recent = new Set([...digest.app].filter(([, [, last]]) => last >= lastWeek).map(([who]) => who));
  const early = [...digest.app].filter(([, [first]]) => first < lastWeek).map(([who]) => who);
  const stayed = (list: string[]) => rate(list.filter(who => recent.has(who)).length, list.length);
  return [...digest.uses].map(([feature, per]) => {
    const users = [...per.keys()];
    const usersEarly = early.filter(who => per.has(who)), othersEarly = early.filter(who => !per.has(who));
    const usedStay = usersEarly.length >= MIN_PEOPLE ? stayed(usersEarly) : null, otherStay = othersEarly.length >= MIN_PEOPLE ? stayed(othersEarly) : null;
    const lastDay = (who: string) => Math.max(...per.get(who)!);
    return {
      feature, people: users.length, uses: [...per.values()].reduce((sum, days) => sum + days.size, 0),
      adoption: rate(users.length, appPeople), repeat: rate(users.filter(who => per.get(who)!.size >= 2).length, users.length),
      triedOnce: users.filter(who => per.get(who)!.size === 1 && lastDay(who) < dayIndex(lastWeek)).length,
      lift: usedStay !== null && otherStay !== null ? usedStay - otherStay : null,
    };
  }).sort((a, b) => b.people - a.people || b.uses - a.uses);
}

/** an app moment (a card, a dialog, a step) with how it went: its first telling sub-word, like action or result */
function momentsOf(map: ProductDigest["moments"]) {
  return [...map].map(([name, row]) => ({ name, count: row.count, people: row.people.size, outcomes: [...row.outcomes].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, 6) }))
    .sort((a, b) => b.count - a.count).slice(0, 40);
}

function onboarding(events: StoredEvent[], to: number) {
  const steps = ["name", "plan", "app"];
  const per = new Map<string, { last: string; at: number; done: boolean }>();
  const times = new Map<string, number[]>(), reached = new Map<string, Set<string>>();
  for (const event of events) {
    if (!event.accountId) continue;
    // an account made in the desktop app sees the web welcome once, then sets up in the app: pairing it is finishing
    if (event.name === "onboarding_done" || event.name === "app_paired") { const row = per.get(event.accountId); per.set(event.accountId, { last: row?.last ?? "app", at: event.at, done: true }); continue; }
    if (event.name !== "onboarding_step" || typeof event.props.step !== "string") continue;
    const step = event.props.step;
    (reached.get(step) ?? reached.set(step, new Set()).get(step)!).add(event.accountId);
    if (typeof event.props.ms === "number") (times.get(step) ?? times.set(step, []).get(step)!).push(event.props.ms);
    const row = per.get(event.accountId);
    if (!row?.done) per.set(event.accountId, { last: step, at: event.at, done: false });
  }
  const stuck = [...per.values()].filter(row => !row.done && to - row.at > 3_600_000);
  return steps.map(step => ({ step, reached: reached.get(step)?.size ?? 0, medianMsBefore: median(times.get(step) ?? []), leftHere: stuck.filter(row => row.last === step).length }));
}

/** the desktop app's first run (opt-in app_action onboarding_step / onboarding_completed): people who reached each screen,
 * per path (where the bots live), with the median time on the screen before, so drop-off shows per step */
const APP_FIRST_RUN: Record<"all" | "mac" | "cloud", readonly string[]> = {
  all: ["welcome", "place"], mac: ["account", "ai", "bring", "phone", "permissions", "done"], cloud: ["checkout", "ai", "making", "done"],
};
export function appFirstRun(events: StoredEvent[]) {
  const pathOf = new Map<string, string>();
  for (const event of events) {
    const who = whoOf(event);
    if (who && event.name === "app_action" && event.props.name === "onboarding_step" && (event.props.path === "mac" || event.props.path === "cloud")) pathOf.set(who, event.props.path);
  }
  const reached = new Map<string, Set<string>>(), times = new Map<string, number[]>();
  for (const event of events) {
    const who = whoOf(event);
    if (!who || event.name !== "app_action" || event.props.replay === true) continue;
    const name = event.props.name;
    if (name !== "onboarding_step" && name !== "onboarding_completed") continue;
    const step = name === "onboarding_completed" ? "done" : String(event.props.step);
    const path = APP_FIRST_RUN.all.includes(step) ? "all" : typeof event.props.path === "string" ? event.props.path : pathOf.get(who) ?? "mac";
    const key = `${path}:${step}`;
    (reached.get(key) ?? reached.set(key, new Set()).get(key)!).add(who);
    if (typeof event.props.ms === "number") (times.get(key) ?? times.set(key, []).get(key)!).push(event.props.ms);
  }
  return (Object.entries(APP_FIRST_RUN) as Array<[keyof typeof APP_FIRST_RUN, readonly string[]]>).flatMap(([path, steps]) => steps
    .map(step => ({ path, step, reached: reached.get(`${path}:${step}`)?.size ?? 0, medianMsBefore: median(times.get(`${path}:${step}`) ?? []) }))
    .filter(row => row.reached > 0 || row.step !== "phone"));
}

const goalKey = (event: StoredEvent) => {
  const label = [event.props.label, event.props.section].filter(value => typeof value === "string").join(" in ") || null;
  return `${words(String(event.props.goal))}${label ? `: ${words(label)}` : ""}`;
};
const rageKey = (event: StoredEvent) => `${event.props.label ? words(String(event.props.label)) : "empty space"}${event.props.section ? ` in the ${words(String(event.props.section))} section` : ""} of ${event.ctx?.page ?? "/"}`;
const NOT_CLICKS = new Set(["js_error", "form_start", "form_abandon", "rage_click"]);
function addSite(site: ProductDigest["site"], event: StoredEvent, who: string | null) {
  if (event.name === "site_view" && typeof event.props.path === "string") site.views.set(event.props.path, (site.views.get(event.props.path) ?? 0) + 1);
  if (event.name !== "site_goal" && event.name !== "site_section") return;
  site.latest = Math.max(site.latest, event.at);
  const place = (key: string) => site.places.set(key, Math.max(site.places.get(key) ?? 0, event.at));
  if (event.name === "site_section") {
    const path = String(event.props.path ?? "/");
    place(`${path}#${String(event.props.section)}`); place(`${path}#`);
    if (typeof event.props.section !== "string") return;
    const key = `${path}#${event.props.section}`;
    const row = site.sections.get(key) ?? site.sections.set(key, { path, section: event.props.section, seen: 0, ms: [] }).get(key)!;
    row.seen++;
    if (typeof event.props.ms === "number") row.ms.push(event.props.ms);
    return;
  }
  // a section the site no longer shows (the waitlist page before launch) has nothing left to fix: only the last day's places rank
  const at = `${event.ctx?.page ?? "/"}#${typeof event.props.section === "string" ? event.props.section : ""}`;
  place(at);
  const goal = event.props.goal;
  if (!NOT_CLICKS.has(String(goal))) count(site.clicks, goalKey(event), who);
  if (goal === "rage_click") site.rage.push([at, rageKey(event), who]);
  if (goal === "download_click") count(site.downloads, typeof event.props.value === "string" ? event.props.value : "unknown", who);
  if (goal === "js_error") count(site.errors, event.ctx?.page ?? "unknown page", who);
  if (goal === "form_start") site.forms.started++;
  if (goal === "form_abandon") site.forms.abandoned++;
  if (goal === "waitlist_join") site.forms.joined++;
}
function siteOf(site: ProductDigest["site"]) {
  const current = new Set([...site.places].filter(([, at]) => at > site.latest - DAY).map(([place]) => place));
  const rage: Tally = new Map();
  for (const [place, key, who] of site.rage) if (current.size === 0 || current.has(place)) count(rage, key, who);
  return {
    sections: [...site.sections.values()].map(row => ({ path: row.path, section: row.section, seen: row.seen, share: rate(row.seen, site.views.get(row.path) ?? 0), medianMs: median(row.ms) }))
      .sort((a, b) => a.path.localeCompare(b.path) || b.seen - a.seen).slice(0, 40),
    clicks: rowsOf(site.clicks, 25), rage: rowsOf(rage), downloads: rowsOf(site.downloads), forms: { ...site.forms }, errors: rowsOf(site.errors),
  };
}

/** reactions, ratings and bots made from the few events kept one by one; messages and session lengths from their sums */
function likes(events: StoredEvent[], messages: ProductDigest["messages"], sessions: number[], from: number, to: number) {
  const reactions = events.filter(event => event.name === "app_action" && event.props.name === "reply_reaction" && event.props.on !== false);
  const feedback = events.filter(event => event.name === "app_feedback" && typeof event.props.score === "number");
  const scores = [1, 2, 3, 4, 5].map(score => feedback.filter(event => event.props.score === score).length);
  const byMoment = new Map<string, number[]>();
  for (const event of feedback) (byMoment.get(String(event.props.moment ?? "unknown")) ?? byMoment.set(String(event.props.moment ?? "unknown"), []).get(String(event.props.moment ?? "unknown"))!).push(Number(event.props.score));
  const created = new Map<string, number[]>();
  let deletedSoon = 0, createdCount = 0;
  for (const event of events) {
    if (event.name !== "app_feature") continue;
    const who = whoOf(event);
    if (!who) continue;
    if (event.props.feature === "bot_created") { createdCount++; (created.get(who) ?? created.set(who, []).get(who)!).push(event.at); }
    if (event.props.feature === "bot_deleted") {
      const list = created.get(who) ?? [];
      const index = list.findIndex(at => event.at - at >= 0 && event.at - at < DAY);
      if (index >= 0) { deletedSoon++; list.splice(index, 1); }
    }
  }
  const { sent, replies, senders } = messages;
  return {
    reactions: { positive: reactions.filter(event => POSITIVE.has(String(event.props.emoji))).length, negative: reactions.filter(event => event.props.emoji === "no").length, total: reactions.length },
    feedback: { count: feedback.length, average: feedback.length ? Math.round(feedback.reduce((sum, event) => sum + Number(event.props.score), 0) / feedback.length * 10) / 10 : null, scores,
      byMoment: [...byMoment].map(([moment, list]) => ({ moment, count: list.length, average: Math.round(list.reduce((a, b) => a + b, 0) / list.length * 10) / 10 })).sort((a, b) => a.average - b.average) },
    bots: { created: createdCount, deletedSoon },
    messages: { sent, replies, perPerson: senders.size ? Math.round(sent / senders.size) : null, days: Math.max(1, Math.round((to - from) / DAY)) },
    sessionMedianMs: median(sessions),
  };
}

const versionOf = (event: StoredEvent) => (event.ctx as { app?: { version?: unknown } } | undefined)?.app?.version;
const newer = (a: string, b: string) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); return false; };
/** the newest app version opened so far, then this event's if it is newer */
const newest = (latest: string | null, v: unknown) => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) && (!latest || newer(v, latest)) ? v : latest;
/** `latest` is the newest app anyone opened in the window; with the newest each error was seen on, an error the current app no
 * longer throws is history, not a fix */
function errors(events: StoredEvent[], latest: string | null) {
  const errorEvents = events.filter(event => event.name === "app_error");
  const appErrors = tally(errorEvents, event => `${event.props.kind ?? "unknown"}: ${event.props.code ?? "unknown"}`);
  const lastOn = new Map<string, string>();
  for (const event of errorEvents) {
    const v = versionOf(event), key = `${event.props.kind ?? "unknown"}: ${event.props.code ?? "unknown"}`, seen = lastOn.get(key);
    if (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) && (!seen || newer(v, seen))) lastOn.set(key, v);
  }
  const app = appErrors.map(row => ({ ...row, lastVersion: lastOn.get(row.key) ?? null, latestVersion: latest }));
  const pairing = tally(events.filter(event => event.name === "app_pair_failed"), event => String(event.props.reason ?? "unknown"));
  return { app, pairing };
}

/** the few things most worth fixing, each with the number behind it; weight orders them and is roughly "share of people affected" */
export function improvements(input: { funnel: FunnelStepIn[]; features: FeatureRow[]; feedback: ReturnType<typeof likes>["feedback"]; bots: ReturnType<typeof likes>["bots"];
  onboarding: ReturnType<typeof onboarding>; site: ReturnType<typeof siteOf>; errors: ReturnType<typeof errors>; appPeople: number }): Improvement[] {
  const out: Improvement[] = [];
  let worst: { prev: FunnelStepIn; step: FunnelStepIn; lost: number } | null = null;
  for (let i = 1; i < input.funnel.length; i++) {
    const prev = input.funnel[i - 1]!, step = input.funnel[i]!;
    if (prev.count < MIN_PEOPLE) continue;
    const lost = 1 - step.count / prev.count;
    if (!worst || lost > worst.lost) worst = { prev, step, lost };
  }
  if (worst && worst.lost > 0) out.push({ area: "funnel", title: `${Math.round(worst.lost * 100)}% stop before "${worst.step.label}"`, detail: `${worst.prev.count - worst.step.count} of ${worst.prev.count} who ${worst.prev.label} never got to the next step. the biggest drop in the funnel.`, weight: worst.lost });
  const isOld = (row: { lastVersion?: string | null; latestVersion?: string | null }) => Boolean(row.lastVersion && row.latestVersion && newer(row.latestVersion, row.lastVersion));
  const topError = [...input.errors.app, ...input.site.errors.map(row => ({ ...row, key: `site error on ${row.key}`, lastVersion: null, latestVersion: null }))]
    .sort((a, b) => Number(isOld(a)) - Number(isOld(b)) || b.people - a.people || b.count - a.count)[0];
  if (topError) {
    const { lastVersion, latestVersion } = topError;
    const old = isOld(topError);
    out.push({ area: "errors", title: `"${topError.key}" is the most common error`,
      detail: `${topError.count} times, ${topError.people} ${topError.people === 1 ? "person" : "people"}.${old ? ` last seen on ${lastVersion}, none on ${latestVersion}.` : lastVersion ? ` still seen on ${lastVersion}.` : ""}`,
      weight: (Math.min(1, topError.people / Math.max(1, input.appPeople)) + 0.2) * (old ? 0.25 : 1) });
  }
  const lowest = input.feedback.byMoment.find(row => row.count >= MIN_PEOPLE);
  if (lowest && lowest.average < 4) out.push({ area: "rating", title: `people rate "${words(lowest.moment)}" ${lowest.average} out of 5`, detail: `the lowest rated moment, from ${lowest.count} answers.`, weight: (5 - lowest.average) / 4 });
  const dropped = input.features.filter(row => row.people >= MIN_PEOPLE).map(row => ({ row, share: row.triedOnce / row.people })).sort((a, b) => b.share - a.share)[0];
  if (dropped && dropped.share >= 0.3) out.push({ area: "features", title: `${Math.round(dropped.share * 100)}% try "${words(dropped.row.feature)}" once and never again`, detail: `${dropped.row.triedOnce} of ${dropped.row.people} people used it on one day only.`, weight: dropped.share * 0.8 });
  const stuck = [...input.onboarding].sort((a, b) => b.leftHere - a.leftHere)[0];
  if (stuck && stuck.leftHere > 0) out.push({ area: "onboarding", title: `onboarding loses people at "${stuck.step}"`, detail: `${stuck.leftHere} ${stuck.leftHere === 1 ? "account stopped" : "accounts stopped"} there and did not finish.`, weight: Math.min(1, stuck.leftHere / Math.max(1, stuck.reached)) * 0.9 });
  const forms = input.site.forms;
  if (forms.started >= MIN_PEOPLE && forms.abandoned / forms.started >= 0.3) out.push({ area: "site", title: `${Math.round(forms.abandoned / forms.started * 100)}% start the waitlist form and leave`, detail: `${forms.abandoned} of ${forms.started} form starts were abandoned.`, weight: forms.abandoned / forms.started * 0.8 });
  const rage = input.site.rage[0];
  if (rage && rage.people >= 2) out.push({ area: "site", title: `rage clicks on "${rage.key}"`, detail: `${rage.count} bursts from ${rage.people} people. something there looks clickable and is not, or is slow.`, weight: 0.4 });
  if (input.bots.created >= 5 && input.bots.deletedSoon / input.bots.created >= 0.2) out.push({ area: "bots", title: `${Math.round(input.bots.deletedSoon / input.bots.created * 100)}% of new bots are deleted within a day`, detail: `${input.bots.deletedSoon} of ${input.bots.created} bots made in the window.`, weight: input.bots.deletedSoon / input.bots.created * 0.7 });
  return out.sort((a, b) => b.weight - a.weight);
}

/** the events the report reads one by one: few, unlike the clicks, sections and messages it only counts */
const KEPT_ACTIONS = new Set(["onboarding_step", "onboarding_completed", "reply_reaction"]);
const kept = (event: StoredEvent) => event.name === "onboarding_step" || event.name === "onboarding_done" || event.name === "app_paired" || event.name === "app_feedback"
  || event.name === "app_error" || event.name === "app_pair_failed" || (event.name === "app_action" && KEPT_ACTIONS.has(String(event.props.name)))
  || (event.name === "app_feature" && (event.props.feature === "bot_created" || event.props.feature === "bot_deleted"));
const slim = (event: StoredEvent): StoredEvent => {
  const ctx = event.ctx, version = ctx?.app?.version;
  return { id: event.id, name: event.name, at: event.at, accountId: event.accountId, props: event.props,
    ...(ctx ? { ctx: { ...(ctx.install ? { install: ctx.install } : {}), ...(ctx.visitor ? { visitor: ctx.visitor } : {}), ...(version ? { app: { version } } : {}) } } : {}) };
};

export interface ProductDigest {
  /** the events read one by one (kept) */
  events: StoredEvent[];
  /** each person's first and last app event */
  app: Map<string, [number, number]>;
  /** each feature's users and the UTC days they used it */
  uses: Map<string, Map<string, Set<number>>>;
  moments: Map<string, { count: number; people: Set<string>; outcomes: Map<string, number> }>;
  messages: { sent: number; replies: number; senders: Set<string> };
  sessions: number[];
  latestVersion: string | null;
  site: {
    views: Map<string, number>; sections: Map<string, { path: string; section: string; seen: number; ms: number[] }>;
    /** the newest goal or section seen, and the newest time each place (page#section) was */
    latest: number; places: Map<string, number>;
    clicks: Tally; rage: Array<[string, string, string | null]>; downloads: Tally; errors: Tally; forms: { started: number; abandoned: number; joined: number };
  };
  page: { actions: Tally; choices: Tally; downloads: Tally };
}
const PRODUCT_NAMES = ["app_open", "app_close", "app_screen", "app_feature", "app_messages", "app_error", "app_pair_failed", "app_action", "app_feedback", "onboarding_step", "onboarding_done",
  "app_paired", "site_view", "site_goal", "site_section", "page_action"];
const pageKey = (event: StoredEvent) => [event.props.action, event.props.label, event.props.value].filter(value => typeof value === "string").map(value => words(String(value))).join(": ") + (event.props.path ? ` (${event.props.path})` : "");
export const productDigest: Digest<ProductDigest> = {
  kind: "product", version: 1, names: PRODUCT_NAMES,
  empty: () => ({ events: [], app: new Map(), uses: new Map(), moments: new Map(), messages: { sent: 0, replies: 0, senders: new Set() }, sessions: [], latestVersion: null,
    site: { views: new Map(), sections: new Map(), latest: 0, places: new Map(), clicks: new Map(), rage: [], downloads: new Map(), errors: new Map(), forms: { started: 0, abandoned: 0, joined: 0 } },
    page: { actions: new Map(), choices: new Map(), downloads: new Map() } }),
  add(into, event) {
    const who = whoOf(event);
    if (kept(event)) into.events.push(slim(event));
    if (who && event.name.startsWith("app_")) {
      const span = into.app.get(who);
      if (!span) into.app.set(who, [event.at, event.at]); else { span[0] = Math.min(span[0], event.at); span[1] = Math.max(span[1], event.at); }
      if (event.name === "app_feature" && typeof event.props.feature === "string") {
        const per = into.uses.get(event.props.feature) ?? into.uses.set(event.props.feature, new Map()).get(event.props.feature)!;
        (per.get(who) ?? per.set(who, new Set()).get(who)!).add(dayIndex(event.at));
      }
    }
    if (event.name === "app_action" && typeof event.props.name === "string") {
      const row = into.moments.get(event.props.name) ?? into.moments.set(event.props.name, { count: 0, people: new Set(), outcomes: new Map() }).get(event.props.name)!;
      row.count++;
      if (who) row.people.add(who);
      const sub = SUBKEYS.map(key => event.props[key]).find(value => typeof value === "string");
      if (typeof sub === "string") row.outcomes.set(sub, (row.outcomes.get(sub) ?? 0) + 1);
    }
    if (event.name === "app_messages") {
      into.messages.sent += Number(event.props.sent) || 0; into.messages.replies += Number(event.props.replies) || 0;
      if (who && Number(event.props.sent) > 0) into.messages.senders.add(who);
    }
    if (event.name === "app_close" && typeof event.props.ms === "number") into.sessions.push(Number(event.props.ms));
    if (event.name === "app_open") into.latestVersion = newest(into.latestVersion, versionOf(event));
    addSite(into.site, event, who);
    if (event.name === "page_action") {
      count(into.page.actions, pageKey(event), who);
      if (event.props.action === "choose") count(into.page.choices, `${words(String(event.props.label ?? ""))}: ${words(String(event.props.value ?? ""))}`, who);
      if (event.props.action === "download") count(into.page.downloads, String(event.props.value ?? "unknown"), who);
    }
  },
  merge(into, later) {
    into.events.push(...later.events);
    for (const [who, [first, last]] of later.app) {
      const span = into.app.get(who);
      if (!span) into.app.set(who, [first, last]); else { span[0] = Math.min(span[0], first); span[1] = Math.max(span[1], last); }
    }
    for (const [feature, per] of later.uses) {
      const mine = into.uses.get(feature);
      if (!mine) { into.uses.set(feature, per); continue; }
      for (const [who, days] of per) { const have = mine.get(who); if (have) for (const day of days) have.add(day); else mine.set(who, days); }
    }
    for (const [name, row] of later.moments) {
      const mine = into.moments.get(name);
      if (!mine) { into.moments.set(name, row); continue; }
      mine.count += row.count;
      for (const who of row.people) mine.people.add(who);
      for (const [key, n] of row.outcomes) mine.outcomes.set(key, (mine.outcomes.get(key) ?? 0) + n);
    }
    into.messages.sent += later.messages.sent; into.messages.replies += later.messages.replies;
    for (const who of later.messages.senders) into.messages.senders.add(who);
    into.sessions.push(...later.sessions);
    into.latestVersion = newest(into.latestVersion, later.latestVersion);
    const site = into.site, next = later.site;
    for (const [path, n] of next.views) site.views.set(path, (site.views.get(path) ?? 0) + n);
    for (const [key, row] of next.sections) {
      const mine = site.sections.get(key);
      if (!mine) { site.sections.set(key, row); continue; }
      mine.seen += row.seen; mine.ms.push(...row.ms);
    }
    site.latest = Math.max(site.latest, next.latest);
    for (const [place, at] of next.places) site.places.set(place, Math.max(site.places.get(place) ?? 0, at));
    mergeTally(site.clicks, next.clicks); site.rage.push(...next.rage); mergeTally(site.downloads, next.downloads); mergeTally(site.errors, next.errors);
    site.forms.started += next.forms.started; site.forms.abandoned += next.forms.abandoned; site.forms.joined += next.forms.joined;
    mergeTally(into.page.actions, later.page.actions); mergeTally(into.page.choices, later.page.choices); mergeTally(into.page.downloads, later.page.downloads);
  },
  encode: pack,
  decode: json => unpack(json) as ProductDigest,
};

export function productReport(input: ProductInput) {
  const digest = productDigest.empty();
  for (const event of input.events) if (event.at >= input.from && event.at < input.to) productDigest.add(digest, event);
  return productReportOf(digest, input.from, input.to, input.funnel);
}
/** the digest with each install or visitor counted as the account it signed in to, so one person before and after sign-in is one */
export function resolvePeople(digest: ProductDigest, accountOf: (who: string) => string | null): ProductDigest {
  const as = (who: string) => accountOf(who) ?? who;
  const app = new Map<string, [number, number]>();
  for (const [who, [first, last]] of digest.app) {
    const id = as(who), had = app.get(id);
    app.set(id, had ? [Math.min(had[0], first), Math.max(had[1], last)] : [first, last]);
  }
  const uses = new Map<string, Map<string, Set<number>>>();
  for (const [feature, per] of digest.uses) {
    const out = new Map<string, Set<number>>();
    for (const [who, days] of per) { const id = as(who), had = out.get(id); if (had) for (const day of days) had.add(day); else out.set(id, new Set(days)); }
    uses.set(feature, out);
  }
  const moments = new Map([...digest.moments].map(([name, row]) => [name, { ...row, people: new Set([...row.people].map(as)) }]));
  return { ...digest, app, uses, moments, messages: { ...digest.messages, senders: new Set([...digest.messages.senders].map(as)) } };
}
/** an account for an install id or visitor id, from the identify events */
export const accountOfWho = (identity: { accountOf: ReadonlyMap<string, string> }) => (who: string) => identity.accountOf.get(`install:${who}`) ?? identity.accountOf.get(who) ?? null;

/** the product report of [from, to) from its digest */
export function productReportOf(digest: ProductDigest, from: number, to: number, funnel: FunnelStepIn[]) {
  const events = digest.events;
  const features = featureRowsOf(digest, from, to);
  const appPeople = digest.app.size;
  const liked = likes(events, digest.messages, digest.sessions, from, to), board = onboarding(events, to), web = siteOf(digest.site), errs = errors(events, digest.latestVersion);
  return {
    from, to, appPeople, features, moments: momentsOf(digest.moments), likes: liked, onboarding: board, appFirstRun: appFirstRun(events), site: web, errors: errs,
    account: { actions: rowsOf(digest.page.actions, 25), choices: rowsOf(digest.page.choices), downloads: rowsOf(digest.page.downloads) },
    improve: improvements({ funnel, features, feedback: liked.feedback, bots: liked.bots, onboarding: board, site: web, errors: errs, appPeople }),
  };
}
export type ProductReport = ReturnType<typeof productReport>;
