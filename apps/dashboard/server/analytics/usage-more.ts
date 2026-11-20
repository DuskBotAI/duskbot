// The deeper product questions behind the usage section: setup, reliability, engagement, bots, apps, routines, money,
// feature discovery and the setups people run. Built from usage rollups, app events and billing records; plain counts.
import { LATENCY_EDGES, REASON_WORDS, type PersonDay, type RoutineSpan, type SnapshotRow } from "./usage.ts";
import type { StoredEvent } from "./sink.ts";
import type { FocusItem } from "./usage-summary.ts";
import { ACCOUNT_SIGN_IN_STEPS } from "../../../../shared/product-signals.ts";
import { cancelledFeedback, type RetentionOutcome } from "../../../../shared/billing-api.ts";

const DAY = 86_400_000;
export interface Count { key: string; count: number }
export interface RateRow { key: string; total: number; good: number; bad: number; rate: number | null; reason?: string }
export interface MoreAnswer {
  setup: { onboarding: Array<{ step: string; reached: number; medianMs: number | null }>; signIn: RateRow[]; account: AccountFunnel; handoff: HandoffStep[] };
  reliability: { firstP50: number | null; firstP90: number | null; engines: Array<{ key: string; turns: number; p50: number | null; p90: number | null; firstP50: number | null }>;
    models: Array<{ key: string; turns: number; p50: number | null; firstP50: number | null; failRate: number | null }>; toolErrors: Array<{ kind: "tool" | "app"; key: string; errors: number; turns: number; rate: number | null }>;
    toolFailures: ToolFailureRow[]; crashes: { count: number; people: number; top: Count[] }; wake: { count: number; p50Ms: number | null; p90Ms: number | null } };
  engagement: { sessionsPerPersonDay: number | null; sessionMedianMs: number | null; hours: number[]; weekdays: number[]; turnsPerChat: number | null; chatsPerPersonDay: number | null;
    attachments: Count[]; attachmentSizes: Count[]; chatsDeleted: number; archivedShare: number | null; settings: Count[] };
  bots: { perPerson: number | null; engines: Count[]; topBotShare: number | null; memory: Count[]; roles: Count[] };
  apps: { connects: RateRow[]; actions: Count[] };
  routines: { every: RateRow[]; runP50: number | null; survival: { eligible: number; survived: number; share: number | null } };
  money: { planViews: number; checkouts: { started: number; paid: number; abandoned: number; rate: number | null }; cancelReasons: Count[]; upgrades: number; downgrades: number };
  discovery: Array<{ feature: string; people: number; share: number | null; medianDays: number | null }>;
  setups: Record<"version" | "os" | "arch" | "locale" | "screen" | "theme" | "skin" | "notifications", Count[]>;
}
/** one failed tool (`browser.navigate`, `computer.click` or a tool kind) and error class: turns it failed in, failed
 *  calls, and people it happened to. `schema_invalid` rows are the model's bad arguments and sort after real breakage */
export interface ToolFailureRow { tool: string; error: string; turns: number; calls: number; people: number }
/** the first run's account sign-in: installs that reached each step, attempts by method, and why attempts failed */
export interface AccountFunnel { steps: Array<{ step: string; reached: number }>; methods: RateRow[]; errors: Count[] }
/** one step of the sign-up handoff from the app's account step to the website and back: people who reached it, and the
 *  median time from `from` (the step before it on the same path) to it */
export interface HandoffStep { step: string; side: "app" | "web"; from: string | null; reached: number; medianMs: number | null }
export interface MoreInput {
  days: string[]; daily: Map<string, Record<string, number>>; people: PersonDay[]; snapshots: SnapshotRow[]; routines: RoutineSpan[]; events: StoredEvent[];
  billing: { checkouts: Array<{ accountId: string; status: string; createdAt: number }>; subscriptions: Array<{ accountId: string; totalCents: number; createdAt: number; status: string }>;
    feedback: Array<{ answer: string; at: number; outcome?: RetentionOutcome }> };
  accounts: ReadonlyArray<{ id: string; createdAt: number }>; from: number; to: number; now: number;
  /** cloud wake times as the slack edge measures them, per desktop kind */
  wake?: { count: number; p50Ms: number | null; p90Ms: number | null };
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const rate = (part: number, whole: number) => whole > 0 ? part / whole : null;
const median = (values: number[]) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)]!; };
const counts = (values: Iterable<string>): Count[] => { const map = new Map<string, number>(); for (const value of values) map.set(value, (map.get(value) ?? 0) + 1); return [...map].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count); };
function bucketQuantile(buckets: number[], q: number): number | null {
  const total = sum(buckets);
  if (!total) return null;
  let seen = 0;
  for (const [index, count] of buckets.entries()) { seen += count; if (seen / total >= q) { const edge = LATENCY_EDGES[index]!; return Number.isFinite(edge) ? edge * 1000 : 900_000; } }
  return null;
}

export function moreOf(input: MoreInput): MoreAnswer {
  const total = (key: string) => sum(input.days.map(day => input.daily.get(day)?.[key] ?? 0));
  const keys = (prefix: string) => { const found = new Set<string>(); for (const c of input.daily.values()) for (const key of Object.keys(c)) if (key.startsWith(prefix)) found.add(key.slice(prefix.length)); return [...found]; };
  const buckets = (prefix: string) => LATENCY_EDGES.map((_, i) => total(`${prefix}${i}`));
  const events = input.events, byName = (name: string) => events.filter(event => event.name === name);
  const actionsNamed = (name: string) => events.filter(event => event.name === "app_action" && event.props.name === name);

  const steps = new Map<string, { people: Set<string>; ms: number[] }>();
  for (const event of byName("onboarding_step")) {
    const step = String(event.props.step), row = steps.get(step) ?? { people: new Set(), ms: [] };
    if (event.accountId) row.people.add(event.accountId);
    if (typeof event.props.ms === "number") row.ms.push(event.props.ms);
    steps.set(step, row);
  }
  const done = new Set(byName("onboarding_done").map(event => event.accountId).filter(Boolean) as string[]);
  const onboarding = [...["name", "plan", "app"].map(step => ({ step, reached: steps.get(step)?.people.size ?? 0, medianMs: median(steps.get(step)?.ms ?? []) })), { step: "done", reached: done.size, medianMs: null }];
  const engines = keys("engine:").map(key => ({ key, turns: total(`engine:${key}`), p50: bucketQuantile(buckets(`lat_engine:${key}:`), 0.5), p90: bucketQuantile(buckets(`lat_engine:${key}:`), 0.9),
    firstP50: bucketQuantile(buckets(`first_engine:${key}:`), 0.5) })).sort((a, b) => b.turns - a.turns);
  const models = keys("model:").filter(key => key !== "other" || total("model:other") > 0).map(key => ({ key, turns: total(`model:${key}`), p50: bucketQuantile(buckets(`lat_model:${key}:`), 0.5),
    firstP50: bucketQuantile(buckets(`first_model:${key}:`), 0.5), failRate: rate(total(`model_fail:${key}`), total(`model:${key}`)) })).sort((a, b) => b.turns - a.turns);
  const toolErrors = [
    ...keys("tool_err:").map(key => ({ kind: "tool" as const, key, errors: total(`tool_err:${key}`), turns: total(`tool:${key}`) })),
    ...keys("app_err:").map(key => ({ kind: "app" as const, key, errors: total(`app_err:${key}`), turns: total(`app:${key}`) })),
  ].map(row => ({ ...row, rate: rate(row.errors, row.turns) })).sort((a, b) => b.errors - a.errors);
  const toolFailures = keys("tfail:").map(key => {
    const split = key.lastIndexOf("|");
    return { tool: key.slice(0, split).replace(":", "."), error: key.slice(split + 1), turns: total(`tfail:${key}`), calls: total(`tfail_calls:${key}`),
      people: new Set(input.people.filter(row => (row.fails?.[key] ?? 0) > 0).map(row => row.accountId)).size };
  }).sort((a, b) => Number(a.error === "schema_invalid") - Number(b.error === "schema_invalid") || b.turns - a.turns);
  const errors = byName("app_error");
  const crashes = { count: errors.length, people: new Set(errors.map(event => event.accountId ?? event.ctx?.install).filter(Boolean)).size, top: counts(errors.map(event => `${event.props.kind}:${event.props.code}`)).slice(0, 8) };
  const people = input.people.filter(row => row.turns > 0), personDays = people.length;
  const opens = byName("app_open"), closes = byName("app_close");
  const openDays = new Set(opens.map(event => `${event.accountId ?? event.ctx?.install}|${new Date(event.at).toISOString().slice(0, 10)}`)).size;
  const hours = Array.from({ length: 24 }, () => 0), weekdays = Array.from({ length: 7 }, () => 0);
  const env = actionsNamed("env");
  for (const event of env) { const hour = Number(event.props.hour); if (hour >= 0 && hour < 24) hours[hour]!++; weekdays[new Date(event.at).getUTCDay()]!++; }
  const chatTurns = people.flatMap(row => Object.values(row.chats ?? {}));
  const chatsPerDay = people.map(row => Object.keys(row.chats ?? {}).length).filter(n => n > 0);
  const latest = input.snapshots;
  const chats = sum(latest.map(row => row.snapshot.chats ?? 0)), archived = sum(latest.map(row => row.snapshot.archived ?? 0));

  const perPerson = new Map<string, number>(), botTurns = new Map<string, Map<string, number>>();
  for (const row of latest) perPerson.set(row.accountId, (perPerson.get(row.accountId) ?? 0) + row.snapshot.bots);
  for (const row of people) { const map = botTurns.get(row.accountId) ?? new Map(); for (const [bot, n] of Object.entries(row.bots ?? {})) map.set(bot, (map.get(bot) ?? 0) + n); botTurns.set(row.accountId, map); }
  const topShares = [...botTurns.values()].map(map => { const values = [...map.values()]; return values.length ? Math.max(...values) / sum(values) : null; }).filter((v): v is number => v !== null);
  const engineCounts = new Map<string, number>();
  for (const row of latest) for (const [engine, n] of Object.entries(row.snapshot.botEngines ?? {})) engineCounts.set(engine, (engineCounts.get(engine) ?? 0) + (n ?? 0));
  const MEMORY = ["empty", "under 10 kb", "under 100 kb", "under 1 mb", "under 10 mb", "10 mb or more"];

  const connects = new Map<string, RateRow>();
  for (const event of actionsNamed("connector_connect")) {
    const app = String(event.props.app ?? "other"), row = connects.get(app) ?? { key: app, total: 0, good: 0, bad: 0, rate: null };
    row.total++; if (event.props.result === "connected") row.good++; else row.bad++;
    connects.set(app, row);
  }
  for (const row of connects.values()) row.rate = rate(row.good, row.total);

  const eligible = input.routines.filter(span => span.first <= input.now - 7 * DAY), survived = eligible.filter(span => span.last - span.first >= 7 * DAY);

  const checkouts = input.billing.checkouts.filter(checkout => checkout.createdAt >= input.from && checkout.createdAt < input.to);
  const paid = checkouts.filter(checkout => checkout.status === "completed").length, abandoned = checkouts.filter(checkout => checkout.status === "expired" || (checkout.status === "open" && checkout.createdAt < input.now - DAY)).length;
  let upgrades = 0, downgrades = 0;
  const subsByAccount = new Map<string, typeof input.billing.subscriptions>();
  for (const sub of input.billing.subscriptions) subsByAccount.set(sub.accountId, [...(subsByAccount.get(sub.accountId) ?? []), sub]);
  for (const subs of subsByAccount.values()) {
    const sorted = subs.filter(sub => sub.status !== "pending").sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 1; i < sorted.length; i++) if (sorted[i]!.createdAt >= input.from && sorted[i]!.createdAt < input.to) {
      if (sorted[i]!.totalCents > sorted[i - 1]!.totalCents) upgrades++; else if (sorted[i]!.totalCents < sorted[i - 1]!.totalCents) downgrades++;
    }
  }
  const planViews = events.filter(event => (event.name === "page_view" || event.name === "site_view") && /^\/(?:pricing|billing|plans?)(?:\/|$)/.test(String(event.props.path ?? ""))).length;

  const created = new Map(input.accounts.map(account => [account.id, account.createdAt]));
  const firstUse = new Map<string, Map<string, number>>();
  for (const event of byName("app_feature")) {
    if (!event.accountId) continue;
    const feature = String(event.props.feature), map = firstUse.get(feature) ?? new Map<string, number>();
    if (!map.has(event.accountId) || map.get(event.accountId)! > event.at) map.set(event.accountId, event.at);
    firstUse.set(feature, map);
  }
  const active = new Set(input.people.map(row => row.accountId).concat(opens.map(event => event.accountId).filter((id): id is string => !!id)));
  const discovery = [...firstUse].map(([feature, map]) => ({ feature, people: map.size, share: rate([...map.keys()].filter(id => active.has(id)).length, active.size),
    medianDays: median([...map].flatMap(([id, at]) => created.has(id) ? [Math.max(0, (at - created.get(id)!) / DAY)] : [])) })).sort((a, b) => b.people - a.people);

  const setupsOf = (key: string) => counts(env.map(event => String(event.props[key] ?? "")).filter(Boolean));
  return {
    setup: { onboarding, signIn: signInRows(events), account: accountFunnel(events), handoff: handoffFunnel(events) },
    reliability: { firstP50: bucketQuantile(buckets("first:"), 0.5), firstP90: bucketQuantile(buckets("first:"), 0.9), engines, models: models.slice(0, 15), toolErrors: toolErrors.slice(0, 20), toolFailures: toolFailures.slice(0, 30), crashes,
      wake: input.wake ?? { count: 0, p50Ms: null, p90Ms: null } },
    engagement: { sessionsPerPersonDay: rate(opens.length, openDays), sessionMedianMs: median(closes.map(event => Number(event.props.ms)).filter(ms => ms > 0)), hours, weekdays,
      turnsPerChat: median(chatTurns), chatsPerPersonDay: rate(sum(chatsPerDay), personDays), attachments: keys("sig:attachment:kind:").map(key => ({ key, count: total(`sig:attachment:kind:${key}`) })).sort((a, b) => b.count - a.count),
      attachmentSizes: keys("sig:attachment:size:").map(key => ({ key, count: total(`sig:attachment:size:${key}`) })), chatsDeleted: total("sig:chat_deleted"), archivedShare: rate(archived, chats + archived),
      settings: keys("sig:setting_changed:key:").map(key => ({ key, count: total(`sig:setting_changed:key:${key}`) })).sort((a, b) => b.count - a.count).slice(0, 20) },
    bots: { perPerson: median([...perPerson.values()]), engines: [...engineCounts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count), topBotShare: median(topShares),
      memory: MEMORY.map((label, i) => ({ key: label, count: latest.filter(row => row.snapshot.memory === i).length })).filter(row => row.count), roles: counts(actionsNamed("bot_created").map(event => String(event.props.template ?? event.props.source ?? "blank"))) },
    apps: { connects: [...connects.values()].sort((a, b) => b.total - a.total), actions: keys("action:").map(key => ({ key, count: total(`action:${key}`) })).sort((a, b) => b.count - a.count).slice(0, 30) },
    routines: { every: keys("every:").map(key => { const n = total(`every:${key}`), bad = total(`every_fail:${key}`); return { key, total: n, good: n - bad, bad, rate: rate(n - bad, n) }; }).sort((a, b) => b.total - a.total),
      runP50: bucketQuantile(buckets("run_ms:"), 0.5), survival: { eligible: eligible.length, survived: survived.length, share: rate(survived.length, eligible.length) } },
    money: { planViews, checkouts: { started: checkouts.length, paid, abandoned, rate: rate(paid, checkouts.length) },
      cancelReasons: counts(input.billing.feedback.filter(entry => entry.at >= input.from && entry.at < input.to && cancelledFeedback(entry)).map(entry => entry.answer)), upgrades, downgrades },
    discovery,
    setups: { version: counts(opens.map(event => String(event.props.appVersion ?? "")).filter(Boolean)).slice(0, 8), os: setupsOf("os"), arch: setupsOf("arch"), locale: setupsOf("locale"), screen: setupsOf("screen"),
      theme: setupsOf("theme"), skin: setupsOf("skin"), notifications: setupsOf("notifications") },
  };
}

/** the app's account_sign_in actions: each step counted once per install (or account), methods by attempt */
function accountFunnel(events: StoredEvent[]): AccountFunnel {
  const steps = new Map<string, Set<string>>(), methods = new Map<string, RateRow>(), errors: string[] = [];
  for (const event of events) {
    if (event.name !== "app_action" || event.props.name !== "account_sign_in") continue;
    const step = String(event.props.step ?? ""), who = event.ctx?.install ?? event.accountId ?? event.id, method = typeof event.props.method === "string" ? event.props.method : null;
    if (!(ACCOUNT_SIGN_IN_STEPS as readonly string[]).includes(step)) continue;
    steps.set(step, (steps.get(step) ?? new Set()).add(who));
    if (step === "error") errors.push(String(event.props.code ?? "other"));
    if (!method) continue;
    const row = methods.get(method) ?? { key: method, total: 0, good: 0, bad: 0, rate: null };
    if (step === "method") row.total++;
    else if (step === "returned") row.good++;
    else if (step === "error") row.bad++;
    methods.set(method, row);
  }
  return {
    steps: ACCOUNT_SIGN_IN_STEPS.map(step => ({ step, reached: steps.get(step)?.size ?? 0 })),
    methods: [...methods.values()].map(row => ({ ...row, total: Math.max(row.total, row.good), rate: rate(row.good, Math.max(row.total, row.good)) })).sort((a, b) => b.total - a.total),
    errors: counts(errors),
  };
}

/** the handoff's steps in the order a person meets them; `from` is the step its time is measured from */
export const HANDOFF_STEPS: ReadonlyArray<{ step: string; side: "app" | "web"; from: string | null }> = [
  { step: "shown", side: "app", from: null },
  { step: "method", side: "app", from: "shown" },
  { step: "handoff", side: "app", from: "method" },
  { step: "landed", side: "web", from: "handoff" },
  { step: "signed_in", side: "app", from: "handoff" },
  { step: "app_place", side: "app", from: "signed_in" },
  { step: "app_done", side: "app", from: "app_place" },
  { step: "name", side: "web", from: "landed" },
  { step: "plan", side: "web", from: "name" },
  { step: "checkout", side: "web", from: "plan" },
  { step: "all_set", side: "web", from: "plan" },
  { step: "sent_back", side: "web", from: "all_set" },
  { step: "back", side: "app", from: "sent_back" },
];
const SIGN_IN_PAGES = new Set(["/sign-in", "/signin", "/signup", "/cloud/desktop"]);

/** which handoff step an event is, if any */
function handoffStepOf(event: StoredEvent): string | null {
  const p = event.props;
  if (event.name === "app_action" && p.name === "account_sign_in") return p.step === "returned" ? "signed_in" : ["shown", "method", "handoff", "back"].includes(String(p.step)) ? String(p.step) : null;
  if (event.name === "app_action" && p.name === "onboarding_step" && p.step === "place") return "app_place";
  if (event.name === "app_action" && p.name === "onboarding_completed") return "app_done";
  if (event.name === "page_view" && SIGN_IN_PAGES.has(String(p.path))) return "landed";
  if (event.name === "onboarding_step") return p.step === "app" ? "all_set" : p.step === "name" || p.step === "plan" ? String(p.step) : null;
  if (event.name === "plan_chosen") return "checkout";
  if (event.name === "app_return") return "sent_back";
  return null;
}

/** the app's account step through the website's sign-in and onboarding and back into the app, as one funnel. One person is
 *  an app install, its account and the website tabs that account signed in on, joined wherever an event names two of them.
 *  Only people who saw the app's account step count. */
export function handoffFunnel(events: readonly StoredEvent[]): HandoffStep[] {
  const parent = new Map<string, string>();
  const root = (key: string): string => { let at = key; while (parent.has(at) && parent.get(at) !== at) at = parent.get(at)!; parent.set(key, at); return at; };
  const keysOf = (event: StoredEvent) => [event.accountId ? `a:${event.accountId}` : null, event.ctx?.install ? `i:${event.ctx.install}` : null,
    !event.ctx?.install && event.ctx?.session ? `s:${event.ctx.session}` : null].filter((key): key is string => key !== null);
  for (const event of events) {
    const keys = keysOf(event);
    for (const key of keys) if (!parent.has(key)) parent.set(key, key);
    for (const key of keys.slice(1)) { const a = root(keys[0]!), b = root(key); if (a !== b) parent.set(b, a); }
  }
  const times = new Map<string, Map<string, number[]>>();
  for (const event of events) {
    const step = handoffStepOf(event), key = keysOf(event)[0];
    if (!step || !key) continue;
    const who = root(key), seen = times.get(who) ?? new Map<string, number[]>();
    seen.set(step, [...(seen.get(step) ?? []), event.at]);
    times.set(who, seen);
  }
  const people = [...times.values()].filter(seen => seen.has("shown"));
  // a step's time runs from the last try of the step before it (a cancelled google sign-in, then email): never from the first
  const since = (seen: Map<string, number[]>, step: string, from: string) => {
    const at = Math.min(...seen.get(step)!), before = seen.get(from)!.filter(time => time <= at);
    return at - (before.length ? Math.max(...before) : Math.min(...seen.get(from)!));
  };
  return HANDOFF_STEPS.map(({ step, side, from }) => {
    const reached = people.filter(seen => seen.has(step));
    const ms = from ? reached.flatMap(seen => seen.has(from) ? [Math.max(0, since(seen, step, from))] : []) : [];
    return { step, side, from, reached: reached.length, medianMs: median(ms) };
  });
}

/** engine sign-ins from the workspace signal records: started, succeeded, failed and why */
function signInRows(events: StoredEvent[]): RateRow[] {
  const rows = new Map<string, RateRow & { reasons: Map<string, number> }>();
  for (const event of events.filter(item => item.name === "engine_sign_in")) {
    const engine = String(event.props.engine), row = rows.get(engine) ?? { key: engine, total: 0, good: 0, bad: 0, rate: null, reasons: new Map() };
    const outcome = String(event.props.outcome);
    if (outcome === "started") row.total++;
    else if (outcome === "succeeded") row.good++;
    else { row.bad++; const reason = String(event.props.reason ?? outcome); row.reasons.set(reason, (row.reasons.get(reason) ?? 0) + 1); }
    rows.set(engine, row);
  }
  return [...rows.values()].map(({ reasons, ...row }) => {
    const attempts = Math.max(row.total, row.good + row.bad);
    return { ...row, total: attempts, rate: rate(row.good, attempts), ...(reasons.size ? { reason: [...reasons].sort((a, b) => b[1] - a[1])[0]![0] } : {}) };
  }).sort((a, b) => b.total - a.total);
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const seconds = (ms: number) => ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
/** focus lines from the deeper answer, weighed on the same scale as the usage section's own */
export function moreFocus(m: MoreAnswer): FocusItem[] {
  const out: FocusItem[] = [];
  const signIn = m.setup.signIn.filter(row => row.total >= 5 && row.rate !== null && row.rate < 0.7).sort((a, b) => (a.rate ?? 1) - (b.rate ?? 1))[0];
  if (signIn) out.push({ id: `signin:${signIn.key}`, target: "setup", weight: 80 + (0.7 - signIn.rate!) * 40, text: `only ${pct(signIn.rate!)} of ${signIn.key} sign-ins finish${signIn.reason ? ` (mostly ${REASON_WORDS[signIn.reason as keyof typeof REASON_WORDS] ?? signIn.reason.replace(/_/g, " ")})` : ""}: people can't even start there.` });
  const c = m.money.checkouts;
  if (c.started >= 5 && c.rate !== null && c.rate < 0.5) out.push({ id: "checkout", target: "money", weight: 70 + (0.5 - c.rate) * 40, text: `${pct(1 - c.rate)} of checkouts are left unpaid (${c.abandoned} of ${c.started}): look at the checkout step.` });
  const s = m.routines.survival;
  if (s.eligible >= 5 && s.share !== null && s.share < 0.5) out.push({ id: "survival", target: "routines", weight: 60 + (0.5 - s.share) * 40, text: `only ${pct(s.share)} of routines are still running a week after their first run.` });
  if (m.reliability.firstP50 !== null && m.reliability.firstP50 >= 20_000) out.push({ id: "first-token", target: "reliability", weight: 55, text: `the first reply takes ${seconds(m.reliability.firstP50)} for half of turns: people wait before seeing anything.` });
  const toolError = m.reliability.toolErrors.find(row => row.turns >= 20 && row.rate !== null && row.rate >= 0.15);
  if (toolError) out.push({ id: `toolerr:${toolError.key}`, target: "reliability", weight: 58 + toolError.rate! * 30, text: `${toolError.kind === "tool" && toolError.key === "app" ? "connected app" : toolError.key.replace(/_/g, " ")} calls error in ${pct(toolError.rate!)} of the turns that use it.` });
  const connect = m.apps.connects.find(row => row.total >= 5 && row.rate !== null && row.rate < 0.6);
  if (connect) out.push({ id: `connect:${connect.key}`, target: "apps", weight: 62 + (0.6 - connect.rate!) * 40, text: `connecting ${connect.key} works ${pct(connect.rate!)} of the time: fix the connect flow.` });
  const hidden = m.discovery.find(row => ["routine_created", "app_connected", "phone_paired", "voice_used"].includes(row.feature) && row.share !== null && row.share < 0.15);
  if (hidden) out.push({ id: `discovery:${hidden.feature}`, target: "discovery", weight: 45, text: `only ${pct(hidden.share!)} of active people have tried ${hidden.feature.replace(/_/g, " ")}: make it easier to find.` });
  return out;
}
