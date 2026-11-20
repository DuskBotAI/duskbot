import { randomBytes } from "node:crypto";
import { cancelFlowSummary } from "../analytics/cancel-flow.ts";
import type { createAuth } from "../auth/index.ts";
import type { createBilling } from "../billing/index.ts";
import type { Analytics } from "../analytics/index.ts";
import { keepPartial, type StoredEvent } from "../analytics/sink.ts";
import type { StoredWorkspace } from "../store.ts";
import { DAY, DIMENSIONS, ONLINE_MS, SURFACES, breakdownTally, feed, funnel, identityOf, kpisTally, matches, online, retention, seriesTally, valuesOf, visitsFromPaced, visitsOf, type Dimension, type FunnelFacts, type Filters, type People, type Visit } from "../analytics/web.ts";
import { BILLING_EVENTS, QUARTER, accountsDigest, appDigest, appDigestOf, appReport, seenDigest, upsellsDigest, visitsDigest, type AccountsDigest, type UpsellsDigest } from "../analytics/digests.ts";
import { pacer, type Digest } from "../analytics/rollup.ts";
import { choseCloud, wasPaid, workspaceTurns } from "./metrics.ts";
import { accountOfWho, productDigest, productReportOf, resolvePeople } from "./product.ts";
import { paymentsOf, revenueReport } from "../analytics/revenue.ts";
import { aligned, firstSeenOf, newVsReturningTally, peakHoursTally } from "../analytics/insights.ts";
import { billingSteps, firstSourceOf, sessionsOf, spendOf, timeToPayOf, whereOf } from "../analytics/profile.ts";
import type { StoredSubscription } from "../billing/store.ts";
import { billingCardOf, paysOf, receivedIn, refundsOf, subscriptionReport, type SubscriptionsInput } from "../analytics/subscriptions.ts";
import { LEDGER_LABELS } from "../billing/ledger.ts";
import { BILLING_CONFIG } from "../billing/plans.ts";
import { quote } from "../billing/pricing.ts";
import type { Step } from "../analytics/profile.ts";
import { moneyIn, opsEventOf, withoutOps, type MoneyMode } from "./money-mode.ts";
/** the most events one person's page reads (newest kept) */
const PERSON_EVENTS = 20_000;
/** an account's face for the people views: its photo and avatar choice, when it has them */
const face = (account: { avatarUrl?: string; avatar?: string }) => ({ ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}), ...(account.avatar ? { avatar: account.avatar } : {}) });

export class AnalyticsRouteError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const bad = (message = "Invalid request.") => new AnalyticsRouteError(400, "invalid_request", message);

/** a window from the caller: from and to in ms (the page sends its own local midnight), at most 400 days */
export function windowOf(url: URL, now: number): { from: number; to: number } {
  const to = url.searchParams.has("to") ? Number(url.searchParams.get("to")) : now;
  const from = url.searchParams.has("from") ? Number(url.searchParams.get("from")) : to - 30 * DAY;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to || to - from > 400 * DAY || to > now + DAY) throw bad("Invalid date range.");
  return { from, to };
}
export function filtersOf(url: URL): Filters {
  const out: Filters = {};
  for (const dim of DIMENSIONS) {
    const value = url.searchParams.get(`f.${dim}`);
    if (value !== null) { if (value.length > 200) throw bad(); out[dim] = value; }
  }
  return out;
}
const surfaceOf = (url: URL) => {
  const surface = url.searchParams.get("surface") ?? "site";
  if (surface !== "all" && !(SURFACES as readonly string[]).includes(surface)) throw bad("Invalid surface.");
  return surface as (typeof SURFACES)[number] | "all";
};
const webFilters = (url: URL) => {
  const surface = surfaceOf(url), filters = filtersOf(url);
  return { surface, filters, scoped: surface === "site" || surface === "all" ? filters : { surface, ...filters } };
};

export interface UpsellRow { source: string; shown: number; clicked: number; dismissed: number; paid: number }
type UpsellSubscription = Pick<StoredSubscription, "source" | "status" | "currentPeriodStart" | "createdAt">;
/** each upsell surface (its checkout source) by people who saw it, opened it, put it away, and paid through it in the window.
 * the account page reports page_action with the step as action and the source as label; the apps report app_action with the step as name and a source prop */
export function upsellsOf(events: StoredEvent[], subscriptions: UpsellSubscription[], from: number, to: number): UpsellRow[] {
  const seen = upsellsDigest.empty();
  for (const event of events) if (event.at >= from && event.at < to) upsellsDigest.add(seen, event);
  return upsellRows(seen, subscriptions, from, to);
}
function upsellRows(seen: UpsellsDigest, subscriptions: UpsellSubscription[], from: number, to: number): UpsellRow[] {
  const paid = new Map<string, number>();
  for (const sub of subscriptions) if (sub.source && seen.has(sub.source) && wasPaid(sub) && sub.createdAt >= from && sub.createdAt < to) paid.set(sub.source, (paid.get(sub.source) ?? 0) + 1);
  return [...seen].map(([source, row]) => ({ source, shown: row.shown.size, clicked: row.clicked.size, dismissed: row.dismissed.size, paid: paid.get(source) ?? 0 }))
    .sort((a, b) => b.shown - a.shown || a.source.localeCompare(b.source));
}

type Auth = ReturnType<typeof createAuth>;
type Billing = ReturnType<typeof createBilling>;
export interface AnalyticsRoutesOptions { auth: Auth; billing: Billing; analytics: Analytics; workspaces: () => StoredWorkspace[]; now: () => number; actor: (id: string) => string | null }

export function createAnalyticsRoutes(options: AnalyticsRoutesOptions) {
  const { auth, billing, analytics, now } = options;
  /** the event log without the billing events of what the operator gave: a grant is never a payment or a subscription here */
  const sink: typeof analytics.sink = { ...analytics.sink, scan: async (since, until, names) => {
    const events = await analytics.sink.scan(since, until, names);
    if (names && !names.includes("billing") && !names.includes("checkout_paid")) return events;
    const ops = opsEventOf(billing.store.state);
    return keepPartial(events, events.filter(event => !ops(event)));
  } };
  /** the money records the owner sees: with a real provider, the fake provider's checkouts (fake_ sessions) and fixture
   * ledger rows are never real money, whatever put them in the store */
  function moneyState() {
    const state = withoutOps(billing.store.state);
    if (billing.operator.provider !== "dodo") return state;
    const fakeCheckouts = new Set(state.checkouts.filter(row => row.providerSessionId?.startsWith("fake_")).map(row => row.id));
    if (!fakeCheckouts.size && !(state.ledger ?? []).some(row => row.via === "fixture")) return state;
    const fakeSubs = new Set(state.subscriptions.filter(row => fakeCheckouts.has(row.checkoutId)).map(row => row.id));
    const fakePayments = new Set(state.invoices.filter(row => row.checkoutId && fakeCheckouts.has(row.checkoutId)).map(row => row.providerPaymentId));
    return { ...state, checkouts: state.checkouts.filter(row => !fakeCheckouts.has(row.id)), subscriptions: state.subscriptions.filter(row => !fakeSubs.has(row.id)),
      invoices: state.invoices.filter(row => !fakePayments.has(row.providerPaymentId)), refunds: (state.refunds ?? []).filter(row => !fakePayments.has(row.paymentId)),
      ledger: (state.ledger ?? []).filter(row => row.via !== "fixture" && !(row.subscriptionId && fakeSubs.has(row.subscriptionId)) && !(row.providerPaymentId && fakePayments.has(row.providerPaymentId))) };
  }

  function people(): People & { cloudChosen: Map<string, number>; paired: Map<string, number>; replied: Map<string, number> } {
    const { accounts, sessions } = auth.directory();
    const state = moneyState();
    const first = (map: Map<string, number>, id: string, at: number) => { if (!map.has(id) || map.get(id)! > at) map.set(id, at); };
    const signups = new Map(accounts.map(account => [account.id, account.createdAt]));
    const paid = new Map<string, number>(), cloudChosen = new Map<string, number>(), paired = new Map<string, number>(), replied = new Map<string, number>();
    for (const sub of state.subscriptions) if (wasPaid(sub)) first(paid, sub.accountId, sub.createdAt);
    for (const invoice of state.invoices) if (invoice.status === "paid") first(paid, invoice.accountId, invoice.createdAt);
    for (const checkout of state.checkouts) if (choseCloud(checkout)) first(cloudChosen, checkout.accountId, checkout.createdAt);
    for (const session of sessions) if (session.kind !== "web") first(paired, session.accountId, session.createdAt);
    for (const ws of options.workspaces()) if (ws.ownerAccountId && workspaceTurns(ws) > 0) first(replied, ws.ownerAccountId, ws.lastReportAt ?? ws.connectedAt);
    return { signups, paid, cloudChosen, paired, replied };
  }
  const rollups = analytics.rollups;
  rollups?.watch(() => sink.rollupScope?.() ?? null);
  /** a digest of [since, until): from the rollups, or folded from a raw scan without them */
  async function digestOf<P>(digest: Digest<P>, since: number, until: number): Promise<P> {
    const scope = sink.rollupScope?.();
    if (rollups && scope) return rollups.read(scope, digest, since, until);
    const out = digest.empty(), events = await sink.scan(since, until, digest.names), pause = pacer();
    for (let i = 0; i < events.length; i++) { digest.add(out, events[i]!); if ((i & 1023) === 1023) await pause(); }
    return out;
  }
  /** the visits since `from`, who every visitor and install became, and the people; `firsts` also takes each account's first
   *  pairing, bot reply and paid plan choice from its events */
  async function load(from: number, firsts: boolean) {
    const until = now() + 60_000;
    const [sessions, identifies, facts] = await Promise.all([digestOf(visitsDigest, from, until), sink.scan(0, until, ["identify"]), firsts ? digestOf(accountsDigest, from, until) : null]);
    const identity = identityOf(identifies);
    const p = people();
    const first = (map: Map<string, number>, id: string, at: number | null) => { if (at !== null && (!map.has(id) || map.get(id)! > at)) map.set(id, at); };
    if (facts) for (const [id, row] of facts.by) { first(p.paired, id, row.paired); first(p.replied, id, row.replied); first(p.cloudChosen, id, row.chosen); }
    return { sessions, identity, identifies, people: p, facts, until };
  }
  /** what the funnel reads per account; `lastFrom` also reads billing events (raw: the money views drop the operator's own) for each account's newest event */
  async function funnelFactsOf(facts: AccountsDigest, identifies: readonly StoredEvent[], lastFrom: [number, number] | null): Promise<FunnelFacts> {
    const onboarding = new Map<string, Map<string, number>>(), days = new Map<string, Set<number>>(), last = new Map<string, { at: number; name: string; page: string | null }>();
    for (const [id, row] of facts.by) {
      if (row.onboarding.size) onboarding.set(id, row.onboarding);
      if (row.days.size) days.set(id, row.days);
      if (row.last) last.set(id, row.last);
    }
    if (lastFrom) {
      for (const event of await sink.scan(lastFrom[0], lastFrom[1], BILLING_EVENTS)) {
        const prev = event.accountId ? last.get(event.accountId) : undefined;
        if (event.accountId && (!prev || prev.at <= event.at)) last.set(event.accountId, { at: event.at, name: event.name, page: event.ctx?.page ?? null });
      }
      // a window without an identify read every identify after its events
      if (!facts.identifies) for (const event of identifies) if (event.accountId) last.set(event.accountId, { at: event.at, name: event.name, page: event.ctx?.page ?? null });
    }
    return { onboarding, days, last };
  }

  /** the visitors on the site and in an app in the last five minutes */
  async function onlineNow() {
    const time = now();
    return online(await sink.scan(time - ONLINE_MS, time + 60_000), time, analytics.presence.list().map(entry => entry.key));
  }
  /** what every surface's answer for one window reads: the visits, people, crawls and notes */
  async function webBase(from: number, to: number) {
    const span = to - from;
    const [{ identity, people: p, sessions }, live, crawls, notes] = await Promise.all([load(Math.min(from - span, from - 60 * DAY), true), onlineNow(), sink.crawls(from, to), sink.notes(from - span, to)]);
    const all = await visitsFromPaced(sessions, SURFACES, pacer());
    return { from, to, identity, people: p, live, crawls, notes, all };
  }
  type WebBase = Awaited<ReturnType<typeof webBase>>;
  const tzOf = (url: URL) => {
    const tz = url.searchParams.has("tz") ? Number(url.searchParams.get("tz")) : 0;
    if (!Number.isInteger(tz) || tz < -900 || tz > 900) throw bad();
    return tz;
  };

  async function web(url: URL) {
    const { from, to } = windowOf(url, now());
    webFilters(url); tzOf(url);
    return webAnswer(await webBase(from, to), url);
  }
  /** the answers to these questions in order, each window's visits read once and let go before the next window's */
  async function webMany(urls: readonly URL[]) {
    const time = now(), windows = new Map<string, number[]>();
    urls.forEach((url, i) => {
      const { from, to } = windowOf(url, time);
      webFilters(url); tzOf(url);
      const key = `${from}:${to}`;
      (windows.get(key) ?? windows.set(key, []).get(key)!).push(i);
    });
    const out: Array<Awaited<ReturnType<typeof webAnswer>>> = [];
    for (const [key, indexes] of windows) {
      const [from, to] = key.split(":").map(Number) as [number, number];
      const base = await webBase(from, to);
      for (const i of indexes) out[i] = await webAnswer(base, urls[i]!);
    }
    return out;
  }

  async function webAnswer(base: WebBase, url: URL) {
    const { from, to, identity, people: p, all, live, crawls, notes } = base, span = to - from;
    const { surface, filters, scoped } = webFilters(url);
    const pause = pacer();
    const visits = all.filter(visit => surface === "all" || visit.surface === surface);
    const tz = tzOf(url);
    // every number below in one pass over the visits, a piece at a time
    const firstSeen = new Map<string, number>();
    for (let i = 0; i < visits.length; i += 20_000) { firstSeenOf(visits.slice(i, i + 20_000), firstSeen); await pause(); }
    const tallies = { current: kpisTally(identity, p, from, to, scoped), previous: kpisTally(identity, p, from - span, from, scoped),
      cards: DIMENSIONS.map(dim => breakdownTally(identity, p, dim, from, to, scoped)), chart: seriesTally(p, from, to, scoped, identity), before: seriesTally(p, from - span, from, scoped, identity),
      fresh: newVsReturningTally(from, to, scoped, firstSeen), hours: peakHoursTally(from, to, tz, scoped) };
    await feed(visits, [tallies.current, tallies.previous, ...tallies.cards, tallies.chart, tallies.before, tallies.fresh, tallies.hours], pause);
    const current = tallies.current.result();
    await pause();
    const previous = tallies.previous.result();
    const cards: Record<string, ReturnType<typeof tallies.cards[number]["result"]>> = {};
    for (const [i, dim] of DIMENSIONS.entries()) { await pause(); cards[dim] = tallies.cards[i]!.result(); }
    await pause();
    const inWindow = all.filter(visit => visit.start >= from && visit.start < to);
    const surfaces = Object.fromEntries(SURFACES.map(value => [value, new Set(inWindow.filter(visit => visit.surface === value).map(visit => visit.visitor)).size]));
    const allowed = Object.keys(scoped).length ? new Set(visits.filter(visit => visit.start >= from && visit.start < to && matches(visit, scoped)).map(visit => visit.visitor.startsWith("acct_") ? visit.visitor : identity.accountOf.get(visit.visitor))) : null;
    const accounts = new Map(auth.directory().accounts.map(account => [account.id, account]));
    const marks = (["signup", "paid"] as const).flatMap(kind => [...(kind === "signup" ? p.signups : p.paid)].filter(([id, at]) => at >= from && at < to && (!allowed || allowed.has(id)))
      .map(([id, at]) => ({ at, kind, seed: [...(identity.visitorsOf.get(id) ?? [])][0] ?? id, email: accounts.get(id)?.email ?? null, customer: p.paid.has(id) })))
      .sort((a, b) => b.at - a.at || a.seed.localeCompare(b.seed)).slice(0, 60);
    await pause();
    const money = moneyState();
    // the revenue cards credit payments to visits, so only an account's visits matter to them
    const credited: Visit[] = [];
    for (let i = 0; i < visits.length; i++) { const visit = visits[i]!; if (visit.visitor.startsWith("acct_") || identity.accountOf.has(visit.visitor)) credited.push(visit); if ((i & 16383) === 16383) await pause(); }
    const revenue = revenueReport({ payments: paymentsOf(money), subscriptions: money.subscriptions, visits: credited, identity, from, to, now: now(), filters: scoped,
      accounts: new Map([...accounts].map(([id, account]) => [id, { email: account.email, createdAt: account.createdAt }])) });
    const count = (values: string[]) => [...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>())]
      .map(([key, requests]) => ({ key, visitors: requests, signups: 0, paid: 0 })).sort((a, b) => b.visitors - a.visitors).slice(0, 50);
    const chart = tallies.chart.result();
    const insights = { previousVisitors: aligned(tallies.before.result().visitors, chart.starts.length), visitors: tallies.fresh.result(), hours: tallies.hours.result() };
    // payments are live when the server takes live money, sold or not; before the first sale the chart says no sales
    return { from, to, now: now(), filters, current, previous, surfaces, marks, online: live, series: chart, insights, cards, revenue: { ...revenue, live: revenue.live || serverMode() === "live" }, notes,
      tracked: visits.length > 0, crawlers: { total: crawls.length, bot: count(crawls.map(c => c.bot)), page: count(crawls.map(c => c.path)), kind: count(crawls.map(c => c.kind)) } };
  }

  async function webDetails(dim: Dimension, url: URL) {
    const { from, to } = windowOf(url, now()), { surface, filters, scoped } = webFilters(url);
    const { sessions, identity, people: p } = await load(from, false);
    const pause = pacer();
    const visits = (await visitsFromPaced(sessions, SURFACES, pause)).filter(visit => surface === "all" || visit.surface === surface);
    const ranked = breakdownTally(identity, p, dim, from, to, scoped, 500);
    await feed(visits, [ranked], pause);
    const top = ranked.result(), each = new Map(top.map(row => [row.key, kpisTally(identity, p, from, to, { ...scoped, [dim]: row.key })]));
    // a row's own numbers only ever count visits with its value
    await feed(visits, [{ add: visit => { if (visit.start < from || visit.start >= to) return; for (const value of valuesOf(visit, dim)) each.get(value)?.add(visit); }, result: () => null }], pause);
    const rows = top.map(row => { const { conversion, bounce, visitMs, pageviews } = each.get(row.key)!.result(); return { ...row, conversion, bounce, visitMs, pageviews }; });
    return { from, to, dimension: dim, filters, rows };
  }

  async function funnelRoute(url: URL) {
    const { from, to } = windowOf(url, now());
    const mode = url.searchParams.get("mode") === "signups" ? "signups" : "visitors";
    const [{ sessions, identity, identifies, people: p, facts, until }, upsells] = await Promise.all([load(from, true), digestOf(upsellsDigest, from, Math.min(to, now() + 60_000))]);
    const visits = await visitsFromPaced(sessions, ["site"], pacer()), funnelFacts = await funnelFactsOf(facts!, identifies, [from, until]);
    return { from, to, ...funnel({ from, to, now: now(), mode, visits, identity, facts: funnelFacts, people: p, cloudChosen: p.cloudChosen, paired: p.paired, replied: p.replied }),
      upsells: upsellRows(upsells, moneyState().subscriptions, from, to) };
  }

  function personOf(visits: Visit[]) {
    const first = visits[0]!, last = visits.at(-1)!;
    return { visits: visits.length, pageviews: visits.reduce((sum, visit) => sum + visit.pages.length, 0), firstSeen: first.start, lastSeen: last.end,
      source: first.source, channel: first.channel, campaign: first.campaign, device: first.device, os: first.os, browser: first.browser, country: first.country, city: first.city,
      lastPage: last.exit };
  }

  async function journeys(url: URL) {
    const { from, to } = windowOf(url, now());
    const only = url.searchParams.get("only") ?? "all";
    if (!["all", "signups", "customers"].includes(only)) throw bad();
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 100);
    const { sessions, identity, people: p } = await load(from - 90 * DAY, false);
    const visits = await visitsFromPaced(sessions, ["site"], pacer());
    const emails = new Map(auth.directory().accounts.map(account => [account.id, account]));
    const groups = new Map<string, Visit[]>();
    for (const visit of visits) {
      const key = identity.accountOf.get(visit.visitor) ?? visit.visitor;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(visit);
    }
    for (const [account, at] of p.signups) if (at >= from && at < to && !groups.has(account)) groups.set(account, []);
    const rows = [];
    for (const [key, list] of groups) {
      const account = emails.get(key) ?? null;
      const recent = list.some(visit => visit.end >= from && visit.start < to) || (account && account.createdAt >= from && account.createdAt < to);
      if (!recent) continue;
      const summary = list.length ? personOf(list) : null;
      const signedUp = account ? account.createdAt : null, paidAt = account ? p.paid.get(account.id) ?? null : null;
      const firstSeen = summary?.firstSeen ?? signedUp;
      rows.push({ id: key, seed: list[0]?.visitor ?? key, account: account ? { id: account.id, email: account.email, name: account.name, ...face(account) } : null, customer: paidAt !== null,
        signedUpAt: signedUp, paidAt, firstSeen, lastSeen: summary?.lastSeen ?? signedUp, timeToSignupMs: signedUp !== null && firstSeen !== null ? Math.max(0, signedUp - firstSeen) : null,
        visits: summary?.visits ?? 0, pageviews: summary?.pageviews ?? 0, source: summary?.source ?? "unknown", channel: summary?.channel ?? "unknown", campaign: summary?.campaign ?? null,
        device: summary?.device ?? null, os: summary?.os ?? null, browser: summary?.browser ?? null, country: summary?.country ?? null, city: summary?.city ?? null, lastPage: summary?.lastPage ?? null });
    }
    let list = rows;
    if (only === "signups") list = list.filter(row => row.account);
    if (only === "customers") list = list.filter(row => row.customer);
    if (q) list = list.filter(row => row.id.toLowerCase().includes(q) || row.account?.email.includes(q) || (row.account?.name ?? "").toLowerCase().includes(q) || row.source.toLowerCase().includes(q));
    list.sort((a, b) => Number(b.customer) - Number(a.customer) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
    return { from, to, total: list.length, people: list.slice(0, 200) };
  }

  function billingCard(accountId: string) {
    const input = subscriptionInput(new Map());
    const card = billingCardOf(subscriptionReport(input), input, accountId);
    if (!card) return null;
    const sub = billing.store.state.subscriptions.filter(row => row.accountId === accountId && row.status !== "pending").sort((a, b) => b.createdAt - a.createdAt)[0];
    return { ...card, events: card.events.map(event => ({ ...event, label: LEDGER_LABELS[event.type]?.label ?? event.type, emoji: LEDGER_LABELS[event.type]?.emoji ?? "•", plan: event.plan ? planLabel(event.plan) : null })),
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false, currentPeriodEnd: sub?.currentPeriodEnd ?? null };
  }
  async function profile(id: string) {
    const idents = await sink.scan(0, now() + 60_000, ["identify"]);
    const identity = identityOf(idents);
    // an app install that never signed in is `install:<id>`, like the people list names it
    const install = id.startsWith("install:") ? id.slice("install:".length) : null;
    const account = id.startsWith("acct_") ? id : identity.accountOf.get(id) ?? null;
    const visitors = new Set(account ? identity.visitorsOf.get(account) ?? [] : install ? [] : [id]);
    if (!account && !install) visitors.add(id);
    const installs = new Set(account ? identity.installsOf.get(account) ?? [] : install ? [install] : []);
    // one person's events from the indexes, not a scan of everyone's 400 days
    const ops = opsEventOf(billing.store.state);
    const mine = (await sink.person({ accountId: account, visitors: [...visitors], installs: [...installs], since: now() - 400 * DAY, limit: PERSON_EVENTS })).filter(event => !ops(event));
    if (!mine.length && !account) throw new AnalyticsRouteError(404, "not_found", "Not found.");
    const owner = account ? auth.directory().accounts.find(item => item.id === account) ?? null : null;
    const p = people();
    const visits = visitsOf(mine);
    const state = moneyState();
    const payments = account ? paymentsOf(state).filter(payment => payment.accountId === account) : [];
    const checkouts = account ? state.checkouts.filter(checkout => checkout.accountId === account) : [];
    // billing records are the source of truth for money; the paid event only stands in when they are gone
    const kept = (payments.length ? mine.filter(event => event.name !== "checkout_paid") : mine).filter(event => event.name !== "billing");
    const sessions = sessionsOf(kept, [...billingSteps(payments, checkouts), ...(account ? ledgerSteps(account) : [])]);
    const firstSeen = sessions.length ? sessions.at(-1)!.start : owner?.createdAt ?? null;
    const spend = spendOf(payments, account ? p.paid.get(account) ?? null : null);
    const firstSource = firstSourceOf(visitsOf(mine, ["site", "account"]));
    const surface = (event: StoredEvent) => event.name.startsWith("site_") ? "site" : event.name.startsWith("app_") ? "app" : event.name === "page_view" || event.name.startsWith("onboarding") || event.name === "plan_chosen" ? "account" : "server";
    const timeline = mine.filter(event => event.name !== "site_leave" && event.name !== "page_leave").slice(-400).reverse().map(event => ({ at: event.at, name: event.name, surface: surface(event), props: event.props,
      page: event.ctx?.page ?? null, source: event.ctx?.source ?? null, country: event.ctx?.country ?? null, device: event.ctx?.device ?? null, app: event.ctx?.app ?? null }));
    return {
      id, seed: [...visitors][0] ?? id, account: owner ? { id: owner.id, email: owner.email, name: owner.name, createdAt: owner.createdAt, ...face(owner) } : null,
      customer: !!(account && p.paid.has(account)), paidAt: account ? p.paid.get(account) ?? null : null, visitors: visitors.size, installs: installs.size,
      summary: visits.length ? personOf(visits) : null, timeline,
      where: whereOf(mine), firstSource, sessions: sessions.slice(0, 120),
      stats: { firstSeen, visits: sessions.filter(session => session.surface !== "server").length, pageviews: kept.filter(event => event.name === "site_view" || event.name === "page_view").length,
        ...spend, timeToPayMs: timeToPayOf(firstSeen, spend.firstPaidAt) },
      billing: account ? billingCard(account) : null,
    };
  }

  async function realtime(url: URL) {
    const minutes = Number(url.searchParams.get("minutes") ?? "30");
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 480) throw bad();
    const time = now(), since = time - minutes * 60_000;
    const [events, idents] = await Promise.all([sink.scan(since, time + 60_000), sink.scan(0, time + 60_000, ["identify"])]);
    const identity = identityOf(idents);
    const p = people();
    const accounts = new Map(auth.directory().accounts.map(account => [account.id, account]));
    const NOTABLE = new Set(["site_view", "site_goal", "page_view", "signup", "app_paired", "first_bot_reply", "checkout_paid", "app_open"]);
    const geo = new Map<string, { country?: string; city?: string; lat?: number; lon?: number }>();
    for (const event of events) if (event.ctx?.visitor && (event.ctx.country || event.ctx.lat !== undefined)) geo.set(event.ctx.visitor, { country: event.ctx.country, city: event.ctx.city, lat: event.ctx.lat, lon: event.ctx.lon });
    const seedOf = (event: StoredEvent) => event.ctx?.visitor ?? (event.accountId ? [...(identity.visitorsOf.get(event.accountId) ?? [])][0] ?? event.accountId : event.ctx?.install ?? event.id);
    const feed = events.filter(event => NOTABLE.has(event.name)).slice(-300).reverse().map(event => {
      const account = event.accountId ?? (event.ctx?.visitor ? identity.accountOf.get(event.ctx.visitor) ?? null : null);
      const where = event.ctx?.visitor ? geo.get(event.ctx.visitor) : undefined;
      return { id: event.id, at: event.at, name: event.name, seed: seedOf(event), email: account ? accounts.get(account)?.email ?? null : null, customer: !!(account && p.paid.has(account)),
        page: event.ctx?.page ?? (typeof event.props.path === "string" ? event.props.path : null), goal: typeof event.props.goal === "string" ? event.props.goal : null,
        source: event.ctx?.source ?? null, country: where?.country ?? event.ctx?.country ?? null, city: where?.city ?? event.ctx?.city ?? null, lat: where?.lat ?? event.ctx?.lat ?? null, lon: where?.lon ?? event.ctx?.lon ?? null };
    });
    // a trial beginning is a billing record, not an event: it joins the feed in its place
    for (const sub of moneyState().subscriptions) {
      if (sub.trialEndsAt === undefined || sub.status === "pending" || sub.createdAt < since || sub.createdAt > time) continue;
      const visitor = [...(identity.visitorsOf.get(sub.accountId) ?? [])][0], where = visitor ? geo.get(visitor) : undefined;
      feed.push({ id: `trial_${sub.id}`, at: sub.createdAt, name: "trial_started", seed: visitor ?? sub.accountId, email: accounts.get(sub.accountId)?.email ?? null, customer: true,
        page: null, goal: null, source: null, country: where?.country ?? null, city: where?.city ?? null, lat: where?.lat ?? null, lon: where?.lon ?? null });
    }
    feed.sort((a, b) => b.at - a.at);
    const latest = new Map<string, (typeof feed)[number]>();
    for (const item of feed) if (item.at >= time - 5 * 60_000 && (item.name === "site_view" || item.name === "site_goal" || item.name === "page_view") && !latest.has(item.seed)) latest.set(item.seed, item);
    const present = analytics.presence.list(time);
    for (const entry of present.reverse()) {
      if (latest.has(entry.key)) continue;
      const account = entry.owner ? null : identity.accountOf.get(entry.key) ?? null;
      latest.set(entry.key, { id: `here_${entry.key}`, at: entry.at, name: "site_view", seed: entry.key, email: account ? accounts.get(account)?.email ?? null : null,
        customer: !!(account && p.paid.has(account)), page: entry.page, goal: null, source: null, country: entry.country ?? null, city: entry.city ?? null, lat: entry.lat ?? null, lon: entry.lon ?? null });
    }
    return { now: time, minutes, online: online(events, time, present.map(entry => entry.key)), here: [...latest.values()], feed };
  }

  async function retentionRoute() {
    const time = now(), since = time - 30 * DAY;
    const [long, recent, billed] = await Promise.all([digestOf(accountsDigest, time - 120 * DAY, time + 60_000), digestOf(accountsDigest, since, time + 60_000), sink.scan(since, time + 60_000, BILLING_EVENTS)]);
    const p = people();
    const days = new Map([...long.by].filter(([, row]) => row.days.size).map(([id, row]) => [id, row.days]));
    const cohorts = retention(p.signups, days, time);
    const accounts = new Map(auth.directory().accounts.map(account => [account.id, account]));
    const power = new Map<string, { first: number; seen: Set<number>; opens: number; sent: number; replies: number; features: number; lastAt: number }>();
    for (const [id, row] of recent.by) if (row.power) power.set(id, { first: row.power.first, seen: new Set(row.power.seen), opens: row.power.opens, sent: row.power.sent, replies: row.power.replies, features: row.power.features, lastAt: row.power.last });
    for (const event of billed) {
      if (!event.accountId) continue;
      const row = power.get(event.accountId) ?? power.set(event.accountId, { first: event.at, seen: new Set(), opens: 0, sent: 0, replies: 0, features: 0, lastAt: 0 }).get(event.accountId)!;
      row.first = Math.min(row.first, event.at); row.seen.add(Math.floor(event.at / DAY)); row.lastAt = Math.max(row.lastAt, event.at);
    }
    const trialing = new Set(moneyState().subscriptions.filter(sub => sub.status === "active" && sub.trialEndsAt !== undefined && sub.trialEndsAt > time).map(sub => sub.accountId));
    // people in the order they were first seen, so equal rows keep their order
    const users = [...power].sort((a, b) => a[1].first - b[1].first).filter(([id]) => accounts.has(id)).map(([id, row]) => ({ id, email: accounts.get(id)!.email, name: accounts.get(id)!.name, ...face(accounts.get(id)!),
      activeDays: [...row.seen].filter(day => days.get(id)?.has(day)).length, opens: row.opens, sent: row.sent, replies: row.replies, features: row.features, lastAt: row.lastAt, customer: p.paid.has(id), trial: trialing.has(id) }))
      .sort((a, b) => b.activeDays - a.activeDays || b.sent - a.sent).slice(0, 25);
    return { now: time, cohorts, power: users };
  }

  async function app(url: URL) {
    const { from, to } = windowOf(url, now());
    if (from % QUARTER === 0) return appReport(await digestOf(appDigest, from, to), from, to);
    // the reader's midnight is always on a quarter hour; any other start counts its days from raw events
    const exact = appDigestOf(1), digest = exact.empty();
    for (const event of await sink.scan(from, to, exact.names)) exact.add(digest, event);
    return appReport(digest, from, to, 1);
  }

  async function product(url: URL) {
    const { from, to } = windowOf(url, now());
    const [{ sessions, identity, identifies, people: p, facts }, digest] = await Promise.all([load(from, true), digestOf(productDigest, from, Math.min(to, now() + 60_000))]);
    const flow = funnel({ from, to, now: now(), mode: "visitors", visits: await visitsFromPaced(sessions, ["site"], pacer()), identity, facts: await funnelFactsOf(facts!, identifies, null), people: p,
      cloudChosen: p.cloudChosen, paired: p.paired, replied: p.replied });
    return productReportOf(resolvePeople(digest, accountOfWho(identity)), from, to, flow.steps);
  }

  const planLabel = (id: string) => BILLING_CONFIG.bundles.find(bundle => bundle.id === id)?.label.toLowerCase() ?? (id === "custom" ? "custom" : id.replace(/_/g, " "));
  const planOf = (sub: StoredSubscription) => { try { return planLabel(quote(sub.cart, BILLING_CONFIG).bundle ?? "custom"); } catch { return "custom"; } };
  function subscriptionInput(activity: ReadonlyMap<string, number>): SubscriptionsInput {
    const state = moneyState();
    return { subscriptions: state.subscriptions, invoices: state.invoices, refunds: state.refunds ?? [], ledger: state.ledger ?? [], checkouts: state.checkouts, customers: state.customers,
      accounts: new Map(auth.directory().accounts.map(account => [account.id, { email: account.email, createdAt: account.createdAt, name: account.name ?? null }])), activity, planOf, planLabel, now: now(),
      modeOf: sub => sub.mode ?? serverMode() };
  }
  /** the money records this server holds were made in its provider's mode unless stamped otherwise: preview's dodo is test */
  const serverMode = (): MoneyMode => billing.operator.mode ?? "live";
  const scoped = (input: SubscriptionsInput, want: MoneyMode | "all"): SubscriptionsInput => moneyIn(input, want, serverMode());
  function moneyTotals(input: SubscriptionsInput) {
    const report = subscriptionReport(input);
    return { mrr: report.headline.mrr, customers: report.headline.customers, gross: report.cash.gross, payments: report.cash.payments };
  }
  /** each paying customer's first touch, kept on the billing record once known so it outlives the raw events: read from their own
   *  page views (the account's and its visitors', by index), never a scan of everyone's */
  async function attribute(paying: ReadonlySet<string>, identity: ReturnType<typeof identityOf>, since: number) {
    const missing = billing.store.state.customers.filter(row => paying.has(row.accountId) && !row.attribution).map(row => row.accountId);
    await Promise.all(missing.map(async accountId => {
      const visitors = [...(identity.visitorsOf.get(accountId) ?? [])];
      const events = (await sink.person({ accountId, visitors, installs: [], since, limit: PERSON_EVENTS })).filter(event => event.name === "site_view" || event.name === "page_view");
      const mine = new Set([accountId, ...visitors]);
      const visits = visitsOf(events, ["site", "account"]).filter(visit => mine.has(visit.visitor) || identity.accountOf.get(visit.visitor) === accountId);
      const first = firstSourceOf(visits);
      if (!first) return;
      const visit = visits.find(item => item.start === first.at);
      billing.service.setAttribution(accountId, { source: first.source, channel: first.channel, campaign: first.campaign, referrer: first.referrer, country: visit?.country ?? null, firstSeen: first.at });
    }));
  }
  async function revenueData() {
    const time = now(), since = time - 400 * DAY;
    const [recent, seen, identifies] = await Promise.all([digestOf(accountsDigest, time - 14 * DAY, time + 60_000), digestOf(seenDigest, since, time + 60_000), sink.scan(since, time + 60_000, ["identify"])]);
    const activity = new Map([...recent.by].filter(([, row]) => row.days.size).map(([id, row]) => [id, row.days.size]));
    const input = subscriptionInput(activity);
    const pays = paysOf(input), paying = new Set([...pays.map(pay => pay.accountId), ...input.subscriptions.filter(sub => sub.status !== "pending" && !sub.review).map(sub => sub.accountId)]);
    const identity = identityOf(identifies);
    await attribute(paying, identity, since);
    return { input: subscriptionInput(activity), seen, identity };
  }
  /** visitor, signup, trial started and trial converted (of the trials already over): people first seen in the window */
  function revenueFunnel(input: SubscriptionsInput, seen: ReadonlyMap<string, { visitor: string; start: number }>, identity: ReturnType<typeof identityOf>, days: number) {
    const time = now(), from = time - days * DAY;
    const first = new Map<string, number>();
    for (const { visitor, start } of seen.values()) {
      const who = identity.accountOf.get(visitor) ?? visitor;
      if (!first.has(who) || first.get(who)! > start) first.set(who, start);
    }
    for (const [id, account] of input.accounts) if (!first.has(id) || first.get(id)! > account.createdAt) first.set(id, account.createdAt);
    const trials = new Map<string, StoredSubscription>();
    for (const sub of input.subscriptions) if (sub.trialEndsAt !== undefined && sub.status !== "pending" && sub.source !== "ops_grant" && sub.source !== "admin_comp" && !sub.review
      && (!trials.has(sub.accountId) || trials.get(sub.accountId)!.createdAt > sub.createdAt)) trials.set(sub.accountId, sub);
    const people = [...first].filter(([, at]) => at >= from && at < time).map(([id]) => id);
    const signed = people.filter(id => input.accounts.has(id)), started = signed.filter(id => trials.has(id));
    const over = started.filter(id => trials.get(id)!.trialEndsAt! <= time);
    const converted = over.filter(id => { const sub = trials.get(id)!; return sub.status === "active" || sub.status === "payment_problem" || (sub.status === "ended" && sub.updatedAt > sub.trialEndsAt! + 3_600_000); });
    return { days, steps: [{ id: "visit", label: "visited", count: people.length }, { id: "signup", label: "signed up", count: signed.length },
      { id: "trial", label: "started a trial", count: started.length }, { id: "converted", label: "trial converted", count: converted.length, of: over.length }] };
  }
  async function revenue(url: URL) {
    const days = Number(url.searchParams.get("days") ?? "90");
    if (!Number.isInteger(days) || days < 7 || days > 400) throw bad();
    const asked = url.searchParams.get("mode") ?? "live";
    if (asked !== "live" && asked !== "test" && asked !== "all") throw bad();
    const { input: every, seen, identity } = await revenueData();
    const input = scoped(every, asked), state = billing.store.state;
    const pays = paysOf(input), time = now();
    return { ...subscriptionReport(input), funnel: revenueFunnel(input, seen, identity, days), received: receivedIn(pays, refundsOf(input, pays), time + 1 - days * DAY, time + 1), mode: asked, serverMode: serverMode(),
      modes: { live: moneyTotals(scoped(every, "live")), test: moneyTotals(scoped(every, "test")) }, sync: { available: billing.operator.provider === "dodo", last: state.lastSync ?? null },
      cancelFlow: cancelFlowSummary(state.retention ?? [], now() - 90 * DAY, now() + 1) };
  }
  function ledgerSteps(accountId: string): Step[] {
    const skip = new Set(["payment.succeeded", "refund.succeeded", "subscription.renewed", "subscription.active", "checkout.started"]);
    return (moneyState().ledger ?? []).filter(row => row.accountId === accountId && !skip.has(row.type) && LEDGER_LABELS[row.type]).map(row => {
      const delta = row.mrrCents !== null && row.previousMrrCents !== null ? row.mrrCents - row.previousMrrCents : null;
      return { at: row.at, kind: "billing", surface: "server", name: LEDGER_LABELS[row.type]!.label, emoji: LEDGER_LABELS[row.type]!.emoji, path: null,
        detail: row.reason ?? (row.plan ? planLabel(row.plan) : null), amountCents: delta ?? (row.type.startsWith("payment.") || row.type.startsWith("dispute.") ? row.amountCents : null) };
    });
  }

  async function saveNote(actor: string, input: Record<string, unknown>, id?: string) {
    // oxlint-disable-next-line no-control-regex -- control characters are what this strips or refuses
    const text = typeof input.text === "string" ? input.text.replace(/[\u0000-\u001f]/g, " ").trim() : "";
    const at = Number(input.at);
    if (!text || text.length > 140 || !Number.isSafeInteger(at) || at < 0 || at > now() + 365 * DAY) throw bad("A note needs a date and 1 to 140 characters.");
    const existing = id ? (await sink.notes(0, Number.MAX_SAFE_INTEGER)).find(note => note.id === id) : null;
    if (id && !existing) throw new AnalyticsRouteError(404, "not_found", "Not found.");
    const note = { id: id ?? `note_${randomBytes(9).toString("base64url")}`, at, text, by: existing?.by ?? actor, createdAt: existing?.createdAt ?? now() };
    await sink.saveNote(note);
    return note;
  }

  return { revenue, customers: () => subscriptionReport(scoped(subscriptionInput(new Map()), serverMode())).customers, syncRevenue: () => billing.service.syncFromProvider(), web, webMany, onlineNow, webDetails, funnel: funnelRoute, journeys, profile, realtime, retention: retentionRoute, app, product, saveNote, deleteNote: (id: string) => sink.deleteNote(id), isDimension: (value: string): value is Dimension => (DIMENSIONS as readonly string[]).includes(value) };
}
