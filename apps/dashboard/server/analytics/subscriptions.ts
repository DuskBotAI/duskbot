// Subscription numbers for the owner: MRR and its movements, churn, retention cohorts, LTV, dunning, refunds and
// disputes, checkout conversion, breakdowns, renewals and customers at risk. Pure functions over the billing records.
//
// MRR model: a subscription earns its monthly value (a yearly price / 12, comps 0) from its first payment until it
// ends; a plan change moves the value from the change on. Movements compare each account's MRR at a month's start and
// end, so new + expansion + reactivation - contraction - churned is exactly the month's change in MRR.
import type { Attribution, StoredCheckout, StoredInvoice, StoredSubscription } from "../billing/store.ts";
import type { LedgerEntry } from "../billing/ledger.ts";

export const DAY = 86_400_000;
const MONTHS = 12;

export interface SubscriptionsInput {
  subscriptions: readonly StoredSubscription[];
  invoices: readonly StoredInvoice[];
  refunds: ReadonlyArray<{ id: string; paymentId: string; amountCents: number; currency: string }>;
  ledger: readonly LedgerEntry[];
  checkouts: readonly StoredCheckout[];
  customers: ReadonlyArray<{ accountId: string; email?: string; attribution?: Attribution }>;
  accounts: ReadonlyMap<string, { email: string; createdAt: number; name?: string | null }>;
  /** test or live money for a subscription: the mode it was made in, else the server's; live where absent */
  modeOf?(sub: StoredSubscription): "test" | "live";
  /** active days in the last 14 days, by account */
  activity: ReadonlyMap<string, number>;
  /** a subscription's plan name, and a ledger row's plan id as a name */
  planOf(sub: StoredSubscription): string;
  planLabel(id: string): string;
  now: number;
}

interface Life { sub: StoredSubscription; accountId: string; start: number; end: number | null; segments: Array<{ from: number; mrr: number }>; comp: boolean }
/** `amountCents` is before tax (prices are tax exclusive), `chargedCents` what the buyer paid with tax */
export interface Pay { paymentId: string; accountId: string; subscriptionId: string | null; at: number; amountCents: number; chargedCents: number; netCents: number; taxCents: number; country: string | null }
export interface Refund { id: string; paymentId: string; accountId: string; at: number; amountCents: number }

export const monthStart = (t: number) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
export const addMonths = (t: number, n: number) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1); };
export const monthLabel = (t: number) => new Date(t).toISOString().slice(0, 7);
const isComp = (sub: Pick<StoredSubscription, "source" | "totalCents" | "review">) => sub.review === true || sub.source === "admin_comp" || sub.source === "ops_grant" || sub.totalCents === 0;
export const monthlyCents = (sub: Pick<StoredSubscription, "source" | "totalCents" | "cart" | "review">) => isComp(sub) ? 0 : sub.cart.interval === "year" ? Math.round(sub.totalCents / 12) : sub.totalCents;
/** the account's email, or the one billing kept for it when the account is gone from the directory */
export const emailOf = (input: Pick<SubscriptionsInput, "accounts" | "customers">, id: string | null) =>
  !id ? null : input.accounts.get(id)?.email ?? input.customers.find(row => row.accountId === id)?.email ?? null;
const ratio = (part: number, whole: number) => whole > 0 ? part / whole : null;
const median = (values: number[]) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2); };

/** the tax inside a charge, never more than the charge */
export const taxIn = (chargedCents: number, taxCents: number | null | undefined) => Math.min(chargedCents, Math.max(0, taxCents ?? 0));
/** a refund of a taxed charge, before tax: the same share of the pre-tax amount */
export const refundBeforeTax = (refundCents: number, pay: Pick<Pay, "amountCents" | "chargedCents">) => pay.chargedCents > 0 ? Math.round(refundCents * pay.amountCents / pay.chargedCents) : refundCents;

/** every money-in moment: paid invoices, then ledger payments the invoices do not know (read back by the backfill) */
export function paysOf(input: Pick<SubscriptionsInput, "invoices" | "ledger"> & Partial<Pick<SubscriptionsInput, "subscriptions">>): Pay[] {
  // App Review's demo plan is paid with a test card where it is paid at all: never revenue
  const review = new Set((input.subscriptions ?? []).filter(sub => sub.review).map(sub => sub.id));
  const ledgerOf = new Map(input.ledger.filter(row => row.type === "payment.succeeded" && row.providerPaymentId && !(row.subscriptionId && review.has(row.subscriptionId))).map(row => [row.providerPaymentId!, row]));
  const out: Pay[] = [];
  for (const invoice of input.invoices) {
    if (invoice.status === "failed" || invoice.amountCents <= 0 || invoice.subscriptionId && review.has(invoice.subscriptionId)) continue;
    const row = ledgerOf.get(invoice.providerPaymentId);
    const tax = taxIn(invoice.amountCents, invoice.taxCents ?? row?.taxCents);
    out.push({ paymentId: invoice.providerPaymentId, accountId: invoice.accountId, subscriptionId: invoice.subscriptionId, at: invoice.createdAt, amountCents: invoice.amountCents - tax,
      chargedCents: invoice.amountCents, netCents: row?.netCents ?? invoice.amountCents - tax, taxCents: tax, country: row?.country ?? null });
  }
  const known = new Set(input.invoices.map(invoice => invoice.providerPaymentId));
  for (const row of ledgerOf.values()) {
    if (known.has(row.providerPaymentId!) || !row.accountId || !row.amountCents) continue;
    const tax = taxIn(row.amountCents, row.taxCents);
    out.push({ paymentId: row.providerPaymentId!, accountId: row.accountId, subscriptionId: row.subscriptionId, at: row.at, amountCents: row.amountCents - tax, chargedCents: row.amountCents,
      netCents: row.netCents ?? row.amountCents - tax, taxCents: tax, country: row.country });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** money taken in [from, to): payments before tax less refunds, before the processor's fees (no billing record holds them);
 *  `series` is per `size` bucket from `from` */
export interface Received { cents: number; refundsCents: number; payments: number; starts: number[]; series: number[] }
export function receivedIn(pays: readonly Pay[], refunds: readonly Refund[], from: number, to: number, size = DAY): Received {
  const starts: number[] = [];
  for (let at = from; at < to; at += size) starts.push(at);
  const series = starts.map(() => 0);
  const add = (at: number, cents: number) => { if (at >= from && at < to) series[Math.floor((at - from) / size)]! += cents; };
  let payments = 0, refundsCents = 0;
  for (const pay of pays) if (pay.at >= from && pay.at < to) { payments++; add(pay.at, pay.amountCents); }
  for (const refund of refunds) if (refund.at >= from && refund.at < to) { refundsCents += refund.amountCents; add(refund.at, -refund.amountCents); }
  return { cents: series.reduce((sum, value) => sum + value, 0), refundsCents, payments, starts, series };
}

export function refundsOf(input: Pick<SubscriptionsInput, "refunds" | "ledger">, pays: readonly Pay[]): Refund[] {
  const byPayment = new Map(pays.map(pay => [pay.paymentId, pay]));
  const times = new Map(input.ledger.filter(row => row.type === "refund.succeeded" && row.providerRef).map(row => [row.providerRef!, row]));
  const out: Refund[] = [];
  for (const refund of input.refunds) {
    const pay = byPayment.get(refund.paymentId);
    if (!pay || refund.amountCents <= 0) continue;
    out.push({ id: refund.id, paymentId: refund.paymentId, accountId: pay.accountId, at: times.get(refund.id)?.at ?? pay.at, amountCents: refundBeforeTax(refund.amountCents, pay) });
  }
  const known = new Set(input.refunds.map(refund => refund.id));
  for (const [id, row] of times) if (!known.has(id) && row.amountCents) {
    const pay = row.providerPaymentId ? byPayment.get(row.providerPaymentId) : undefined;
    if (pay) out.push({ id, paymentId: pay.paymentId, accountId: pay.accountId, at: row.at, amountCents: refundBeforeTax(row.amountCents, pay) });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** when each subscription earned MRR, and how much from when */
export function livesOf(input: Pick<SubscriptionsInput, "subscriptions" | "ledger">, pays: readonly Pay[], now: number): Life[] {
  const firstPay = new Map<string, number>();
  for (const pay of pays) if (pay.subscriptionId && !firstPay.has(pay.subscriptionId)) firstPay.set(pay.subscriptionId, pay.at);
  const rows = new Map<string, LedgerEntry[]>();
  for (const row of input.ledger) if (row.subscriptionId) (rows.get(row.subscriptionId) ?? rows.set(row.subscriptionId, []).get(row.subscriptionId)!).push(row);
  const lives: Life[] = [];
  for (const sub of input.subscriptions) {
    if (sub.status === "pending" || sub.review) continue;
    const mine = (rows.get(sub.id) ?? []).sort((a, b) => a.at - b.at);
    const start = firstPay.get(sub.id) ?? mine.find(row => row.type === "subscription.active")?.at ?? (sub.currentPeriodStart !== null ? Math.min(sub.createdAt, sub.currentPeriodStart) : null);
    if (start === null) continue;
    const endRow = mine.find(row => row.type === "subscription.cancelled" || row.type === "subscription.expired");
    let end: number | null = null;
    if (sub.status === "ended") end = endRow?.at ?? (sub.currentPeriodEnd !== null ? Math.min(sub.currentPeriodEnd, sub.updatedAt) : sub.updatedAt);
    else if (sub.status === "cancelled" && sub.currentPeriodEnd !== null && sub.currentPeriodEnd <= now) end = sub.currentPeriodEnd;
    const changes = mine.filter(row => (row.type === "subscription.upgraded" || row.type === "subscription.downgraded") && row.mrrCents !== null);
    const comp = isComp(sub);
    const current = monthlyCents(sub);
    const segments = [{ from: start, mrr: comp ? 0 : changes[0]?.previousMrrCents ?? current }];
    for (const change of changes) segments.push({ from: Math.max(start, change.at), mrr: comp ? 0 : change.mrrCents! });
    lives.push({ sub, accountId: sub.accountId, start, end: end === null ? null : Math.max(start, end), segments, comp });
  }
  return lives;
}

const valueAt = (life: Life, t: number) => {
  if (t < life.start || (life.end !== null && t >= life.end)) return 0;
  let value = 0;
  for (const segment of life.segments) if (segment.from <= t) value = segment.mrr;
  return value;
};
export function accountMrr(lives: readonly Life[], t: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const life of lives) { const value = valueAt(life, t); if (value > 0) out.set(life.accountId, (out.get(life.accountId) ?? 0) + value); }
  return out;
}
const sum = (map: ReadonlyMap<string, number>) => [...map.values()].reduce((a, b) => a + b, 0);

export interface MonthRow {
  start: number; label: string; startMrr: number; mrr: number; startCustomers: number; customers: number;
  new: number; expansion: number; reactivation: number; contraction: number; churned: number; netNew: number;
  newCustomers: number; reactivatedCustomers: number; churnedCustomers: number;
  customerChurn: number | null; grossRevenueChurn: number | null; netRevenueChurn: number | null; nrr: number | null; grr: number | null;
  arpu: number | null; ltv: number | null;
  /** cash in the month: charged, refunded, and after refunds and tax */
  gross: number; refunds: number; net: number; afterTax: number;
}

/** an account's MRR movement between two moments; `seenBefore` says whether it ever paid before `from` */
export function movementOf(before: number, after: number, seenBefore: boolean) {
  if (before === after) return null;
  if (before === 0) return { kind: seenBefore ? "reactivation" as const : "new" as const, cents: after };
  if (after === 0) return { kind: "churned" as const, cents: -before };
  return after > before ? { kind: "expansion" as const, cents: after - before } : { kind: "contraction" as const, cents: after - before };
}

export function monthsOf(lives: readonly Life[], pays: readonly Pay[], refunds: readonly Refund[], now: number, count = MONTHS): MonthRow[] {
  const firstStart = new Map<string, number>();
  for (const life of lives) if (!life.comp && (!firstStart.has(life.accountId) || firstStart.get(life.accountId)! > life.start)) firstStart.set(life.accountId, life.start);
  const current = monthStart(now);
  const rows: MonthRow[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = addMonths(current, -i), end = Math.min(addMonths(start, 1), now + 1);
    const a = accountMrr(lives, start - 1), b = accountMrr(lives, end - 1);
    const row: MonthRow = { start, label: monthLabel(start), startMrr: sum(a), mrr: sum(b), startCustomers: a.size, customers: b.size,
      new: 0, expansion: 0, reactivation: 0, contraction: 0, churned: 0, netNew: 0, newCustomers: 0, reactivatedCustomers: 0, churnedCustomers: 0,
      customerChurn: null, grossRevenueChurn: null, netRevenueChurn: null, nrr: null, grr: null, arpu: null, ltv: null, gross: 0, refunds: 0, net: 0, afterTax: 0 };
    for (const account of new Set([...a.keys(), ...b.keys()])) {
      const move = movementOf(a.get(account) ?? 0, b.get(account) ?? 0, (firstStart.get(account) ?? Infinity) < start);
      if (!move) continue;
      row[move.kind] += move.cents;
      if (move.kind === "new") row.newCustomers++;
      if (move.kind === "reactivation") row.reactivatedCustomers++;
      if (move.kind === "churned") row.churnedCustomers++;
    }
    row.netNew = row.mrr - row.startMrr;
    const lost = -(row.churned + row.contraction);
    row.customerChurn = ratio(row.churnedCustomers, row.startCustomers);
    row.grossRevenueChurn = ratio(lost, row.startMrr);
    row.netRevenueChurn = ratio(lost - row.expansion, row.startMrr);
    row.nrr = ratio(row.startMrr + row.expansion + row.contraction + row.churned, row.startMrr);
    row.grr = ratio(row.startMrr + row.contraction + row.churned, row.startMrr);
    row.arpu = row.customers ? Math.round(row.mrr / row.customers) : null;
    for (const pay of pays) if (pay.at >= start && pay.at < end) { row.gross += pay.amountCents; row.afterTax += pay.netCents; }
    for (const refund of refunds) if (refund.at >= start && refund.at < end) row.refunds += refund.amountCents;
    row.net = row.gross - row.refunds; row.afterTax -= row.refunds;
    rows.push(row);
  }
  // LTV per month: that month's ARPU over the trailing three months' customer churn
  for (const [i, row] of rows.entries()) {
    const window = rows.slice(Math.max(0, i - 2), i + 1), churn = ratio(window.reduce((s, r) => s + r.churnedCustomers, 0), window.reduce((s, r) => s + r.startCustomers, 0));
    row.ltv = row.arpu !== null && churn ? Math.round(row.arpu / churn) : null;
  }
  return rows;
}

export interface CohortRow { start: number; label: string; size: number; base: number; logo: Array<number | null>; revenue: Array<number | null> }
/** paying customers grouped by the month they first paid: the share still paying and MRR kept against month 0, month by month */
export function paymentCohorts(lives: readonly Life[], now: number, count = MONTHS): CohortRow[] {
  const first = new Map<string, number>();
  for (const life of lives) if (!life.comp && (!first.has(life.accountId) || first.get(life.accountId)! > life.start)) first.set(life.accountId, life.start);
  const current = monthStart(now), out: CohortRow[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = addMonths(current, -i), members = [...first].filter(([, at]) => at >= start && at < addMonths(start, 1)).map(([id]) => id);
    const point = (k: number) => Math.min(addMonths(start, k + 1), now + 1) - 1;
    const base = members.reduce((s, id) => s + (accountMrr(lives, point(0)).get(id) ?? 0), 0);
    const logo: Array<number | null> = [], revenue: Array<number | null> = [];
    for (let k = 0; k < count; k++) {
      if (addMonths(start, k) > now || !members.length) { logo.push(null); revenue.push(null); continue; }
      const at = accountMrr(lives, point(k));
      logo.push(members.filter(id => (at.get(id) ?? 0) > 0).length / members.length);
      revenue.push(base > 0 ? members.reduce((s, id) => s + (at.get(id) ?? 0), 0) / base : null);
    }
    out.push({ start, label: monthLabel(start), size: members.length, base, logo, revenue });
  }
  return out;
}
/** signups grouped by their sign-up month: the share paying and the MRR they bring, month by month */
export function signupCohorts(lives: readonly Life[], accounts: ReadonlyMap<string, { createdAt: number }>, now: number, count = MONTHS): CohortRow[] {
  const current = monthStart(now), out: CohortRow[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = addMonths(current, -i), members = [...accounts].filter(([, a]) => a.createdAt >= start && a.createdAt < addMonths(start, 1)).map(([id]) => id);
    const logo: Array<number | null> = [], revenue: Array<number | null> = [];
    for (let k = 0; k < count; k++) {
      if (addMonths(start, k) > now || !members.length) { logo.push(null); revenue.push(null); continue; }
      const at = accountMrr(lives, Math.min(addMonths(start, k + 1), now + 1) - 1);
      logo.push(members.filter(id => (at.get(id) ?? 0) > 0).length / members.length);
      revenue.push(members.reduce((s, id) => s + (at.get(id) ?? 0), 0));
    }
    out.push({ start, label: monthLabel(start), size: members.length, base: 0, logo, revenue });
  }
  return out;
}

export interface Dunning { failed: number; recovered: number; lost: number; open: number; rate: number | null; recoveredMrr: number; months: Array<{ start: number; failed: number; recovered: number }> }
/** failed-payment episodes per subscription: recovered by a later payment within 30 days, lost when the plan ended or 30 days passed */
export function dunningOf(input: Pick<SubscriptionsInput, "invoices" | "ledger">, lives: readonly Life[], pays: readonly Pay[], now: number): Dunning {
  const failures = new Map<string, number[]>();
  const add = (key: string | null, at: number) => { if (key) (failures.get(key) ?? failures.set(key, []).get(key)!).push(at); };
  for (const invoice of input.invoices) if (invoice.status === "failed") add(invoice.subscriptionId, invoice.createdAt);
  for (const row of input.ledger) if (row.type === "payment.failed" || row.type === "subscription.on_hold" || row.type === "subscription.failed") add(row.subscriptionId, row.at);
  const lifeOf = new Map(lives.map(life => [life.sub.id, life]));
  const out: Dunning = { failed: 0, recovered: 0, lost: 0, open: 0, rate: null, recoveredMrr: 0, months: [] };
  const months = new Map<number, { failed: number; recovered: number }>();
  for (const [subId, times] of failures) {
    times.sort((a, b) => a - b);
    let episode = -Infinity;
    for (const at of times) {
      if (at - episode < 30 * DAY) continue;
      episode = at;
      out.failed++;
      const month = months.get(monthStart(at)) ?? months.set(monthStart(at), { failed: 0, recovered: 0 }).get(monthStart(at))!;
      month.failed++;
      const life = lifeOf.get(subId);
      const back = pays.some(pay => pay.subscriptionId === subId && pay.at > at && pay.at - at <= 30 * DAY)
        || input.ledger.some(row => row.subscriptionId === subId && row.type === "subscription.recovered" && row.at >= at && row.at - at <= 30 * DAY);
      if (back) { out.recovered++; month.recovered++; out.recoveredMrr += life ? valueAt(life, Math.min(now, at + 30 * DAY)) || monthlyCents(life.sub) : 0; }
      else if ((life?.end !== null && life?.end !== undefined && life.end <= now) || now - at > 30 * DAY) out.lost++;
      else out.open++;
    }
  }
  out.rate = ratio(out.recovered, out.recovered + out.lost);
  out.months = [...months].sort((a, b) => a[0] - b[0]).map(([start, row]) => ({ start, ...row }));
  return out;
}

export type Health = "good" | "watch" | "risk" | "gone";
export interface CustomerRow {
  accountId: string; email: string | null; name: string | null; mode: "test" | "live"; plan: string; interval: "month" | "year" | null;
  status: "active" | "past_due" | "on_hold" | "cancelling" | "churned" | "comped";
  mrr: number; ltv: number; payments: number; failed: number; refunds: number; firstPaidAt: number | null; renewsAt: number | null; churnedAt: number | null;
  /** their newest payment, before tax */
  lastPaidAt: number | null; lastPaidCents: number | null;
  source: string; channel: string; country: string | null; activeDays: number | null; health: Health;
}
export interface FeedItem {
  id: string; at: number; kind: "new" | "renewal" | "payment" | "failed" | "refund" | "dispute" | "dispute_closed" | "cancel_scheduled" | "kept" | "churned" | "upgrade" | "downgrade" | "recovered" | "abandoned";
  accountId: string | null; email: string | null; amountCents: number | null; mrrDelta: number | null; plan: string | null; detail: string | null;
}

export interface RiskRow { accountId: string; email: string | null; plan: string; mrr: number; reason: "payment_failed" | "cancel_scheduled" | "low_usage"; renewsAt: number | null; activeDays: number | null }

/** everything the owner's revenue page shows */
export function subscriptionReport(input: SubscriptionsInput) {
  const { now } = input;
  const pays = paysOf(input), refunds = refundsOf(input, pays), lives = livesOf(input, pays, now);
  const months = monthsOf(lives, pays, refunds, now);
  const thisMonth = months.at(-1)!, lastMonth = months.at(-2)!;
  const failing = (life: Life) => life.sub.status === "payment_problem";
  const mrrNow = accountMrr(lives.filter(life => !failing(life)), now), atRiskNow = accountMrr(lives.filter(failing), now);
  const mrr = sum(mrrNow), customers = mrrNow.size;
  const complete = months.slice(-4, -1);
  const churnedSum = complete.reduce((s, r) => s + r.churnedCustomers, 0), startSum = complete.reduce((s, r) => s + r.startCustomers, 0);
  const customerChurn = ratio(churnedSum, startSum);
  const lostSum = complete.reduce((s, r) => s - r.churned - r.contraction, 0), startMrr = complete.reduce((s, r) => s + r.startMrr, 0), expansion = complete.reduce((s, r) => s + r.expansion, 0);
  const arpu = customers ? Math.round(mrr / customers) : null;
  const label = (plan: string | null) => plan ? input.planLabel(plan) : "custom";

  const paidBy = new Map<string, number>(), refundedBy = new Map<string, number>(), paymentsBy = new Map<string, number>(), firstPaid = new Map<string, number>(), countryBy = new Map<string, string>();
  const lastPaid = new Map<string, Pay>();
  for (const pay of pays) {
    if ((lastPaid.get(pay.accountId)?.at ?? -Infinity) <= pay.at) lastPaid.set(pay.accountId, pay);
    paidBy.set(pay.accountId, (paidBy.get(pay.accountId) ?? 0) + pay.amountCents); paymentsBy.set(pay.accountId, (paymentsBy.get(pay.accountId) ?? 0) + 1);
    if (!firstPaid.has(pay.accountId)) firstPaid.set(pay.accountId, pay.at);
    if (pay.country) countryBy.set(pay.accountId, pay.country);
  }
  for (const refund of refunds) refundedBy.set(refund.accountId, (refundedBy.get(refund.accountId) ?? 0) + refund.amountCents);
  for (const life of lives) if (!life.comp && !firstPaid.has(life.accountId)) firstPaid.set(life.accountId, life.start);
  const failedBy = new Map<string, number>();
  for (const invoice of input.invoices) if (invoice.status === "failed") failedBy.set(invoice.accountId, (failedBy.get(invoice.accountId) ?? 0) + 1);
  for (const row of input.ledger) if (row.type === "payment.failed" && row.accountId && !input.invoices.some(i => i.providerPaymentId === row.providerPaymentId)) failedBy.set(row.accountId, (failedBy.get(row.accountId) ?? 0) + 1);
  const attribution = new Map(input.customers.filter(row => row.attribution).map(row => [row.accountId, row.attribution!]));
  const onHold = new Set<string>();
  for (const row of input.ledger) if (row.subscriptionId && row.type === "subscription.on_hold") onHold.add(row.subscriptionId);
  for (const row of input.ledger) if (row.subscriptionId && (row.type === "subscription.recovered" || row.type === "subscription.renewed")) {
    const held = input.ledger.find(other => other.subscriptionId === row.subscriptionId && other.type === "subscription.on_hold" && other.at <= row.at);
    if (held) onHold.delete(row.subscriptionId);
  }

  // one row per account that ever paid: its newest live subscription speaks for it
  const byAccount = new Map<string, Life[]>();
  for (const life of lives) (byAccount.get(life.accountId) ?? byAccount.set(life.accountId, []).get(life.accountId)!).push(life);
  const rows: CustomerRow[] = [];
  for (const [accountId, list] of byAccount) {
    const live = list.filter(life => life.end === null || life.end > now).sort((a, b) => b.start - a.start);
    const main = live.find(life => !life.comp) ?? live[0] ?? [...list].sort((a, b) => (b.end ?? 0) - (a.end ?? 0))[0]!;
    const sub = main.sub, touch = attribution.get(accountId), days = input.activity.get(accountId) ?? null;
    const status: CustomerRow["status"] = !live.length ? "churned" : main.comp ? "comped" : sub.status === "payment_problem" ? (onHold.has(sub.id) ? "on_hold" : "past_due") : sub.cancelAtPeriodEnd ? "cancelling" : "active";
    const renewsAt = live.length && !sub.cancelAtPeriodEnd && sub.status !== "ended" ? sub.currentPeriodEnd : null;
    const health: Health = status === "churned" ? "gone" : status === "past_due" || status === "on_hold" || status === "cancelling" ? "risk"
      : status !== "comped" && days !== null && days <= 1 ? "watch" : "good";
    rows.push({ accountId, email: emailOf(input, accountId), name: input.accounts.get(accountId)?.name ?? null, mode: input.modeOf?.(sub) ?? sub.mode ?? "live", plan: input.planOf(sub), interval: sub.cart.interval, status, mrr: mrrNow.get(accountId) ?? 0,
      ltv: (paidBy.get(accountId) ?? 0) - (refundedBy.get(accountId) ?? 0), payments: paymentsBy.get(accountId) ?? 0, failed: failedBy.get(accountId) ?? 0,
      refunds: refundedBy.get(accountId) ?? 0, firstPaidAt: firstPaid.get(accountId) ?? null, renewsAt, churnedAt: live.length ? null : Math.max(...list.map(life => life.end ?? 0)),
      lastPaidAt: lastPaid.get(accountId)?.at ?? null, lastPaidCents: lastPaid.get(accountId)?.amountCents ?? null,
      source: touch?.source ?? "unknown", channel: touch?.channel ?? "unknown", country: touch?.country ?? countryBy.get(accountId) ?? null, activeDays: days, health });
  }
  rows.sort((a, b) => b.mrr - a.mrr || b.ltv - a.ltv);

  const status = { active: 0, trialing: 0, pastDue: 0, onHold: 0, cancelScheduled: 0, comped: 0, churned: 0 };
  for (const row of rows) {
    if (row.status === "active") status.active++;
    else if (row.status === "past_due") status.pastDue++;
    else if (row.status === "on_hold") status.onHold++;
    else if (row.status === "cancelling") status.cancelScheduled++;
    else if (row.status === "comped") status.comped++;
    else status.churned++;
  }

  const breakdown = (keyOf: (row: CustomerRow) => string) => {
    const map = new Map<string, { key: string; mrr: number; customers: number; revenue: number }>();
    for (const row of rows) {
      const key = keyOf(row), entry = map.get(key) ?? map.set(key, { key, mrr: 0, customers: 0, revenue: 0 }).get(key)!;
      entry.mrr += row.mrr; entry.revenue += row.ltv; if (row.mrr > 0) entry.customers++;
    }
    return [...map.values()].sort((a, b) => b.mrr - a.mrr || b.revenue - a.revenue);
  };

  const recent = now - 30 * DAY, paid30 = pays.filter(pay => pay.at >= recent), refunds30 = refunds.filter(refund => refund.at >= recent);
  const disputes = input.ledger.filter(row => row.type === "dispute.opened");
  const closed = new Set(input.ledger.filter(row => /^dispute\.(won|lost|accepted|cancelled|expired)$/.test(row.type)).map(row => row.providerRef));

  const waits = rows.filter(row => row.firstPaidAt !== null && input.accounts.has(row.accountId)).map(row => Math.max(0, row.firstPaidAt! - input.accounts.get(row.accountId)!.createdAt));
  const buckets = [["under an hour", 3_600_000], ["same day", DAY], ["first week", 7 * DAY], ["first month", 30 * DAY], ["later", Infinity]] as const;

  const carts = input.checkouts.filter(row => row.kind === "cart" && row.source !== "ops_grant" && row.source !== "admin_comp" && row.createdAt >= now - 90 * DAY);
  const paidCheckout = (row: StoredCheckout) => row.status === "completed" || (!!row.subscriptionId && input.subscriptions.some(sub => sub.id === row.subscriptionId && sub.status !== "pending"));
  const sources = new Map<string, { source: string; started: number; paid: number; abandoned: number }>();
  let open = 0, abandoned = 0, paidCount = 0;
  for (const row of carts) {
    const entry = sources.get(row.source ?? "unknown") ?? sources.set(row.source ?? "unknown", { source: row.source ?? "unknown", started: 0, paid: 0, abandoned: 0 }).get(row.source ?? "unknown")!;
    entry.started++;
    if (paidCheckout(row)) { entry.paid++; paidCount++; }
    else if (row.status === "open" && row.openUntil > now) open++;
    else { entry.abandoned++; abandoned++; }
  }

  const upcoming = lives.filter(life => !life.comp && (life.end === null || life.end > now) && life.sub.status === "active" && !life.sub.cancelAtPeriodEnd
    && life.sub.currentPeriodEnd !== null && life.sub.currentPeriodEnd >= now && life.sub.currentPeriodEnd < now + 30 * DAY)
    .sort((a, b) => a.sub.currentPeriodEnd! - b.sub.currentPeriodEnd!)
    .map(life => ({ accountId: life.accountId, email: emailOf(input, life.accountId), plan: input.planOf(life.sub), interval: life.sub.cart.interval, amountCents: life.sub.totalCents,
      mrr: valueAt(life, now), at: life.sub.currentPeriodEnd!, activeDays: input.activity.get(life.accountId) ?? null }));

  const risk: RiskRow[] = [];
  for (const row of rows) {
    if (row.status === "past_due" || row.status === "on_hold") risk.push({ accountId: row.accountId, email: row.email, plan: row.plan, mrr: row.mrr, reason: "payment_failed", renewsAt: row.renewsAt, activeDays: row.activeDays });
    else if (row.status === "cancelling") risk.push({ accountId: row.accountId, email: row.email, plan: row.plan, mrr: row.mrr, reason: "cancel_scheduled", renewsAt: null, activeDays: row.activeDays });
    else if (row.status === "active" && row.activeDays !== null && row.activeDays <= 1 && row.renewsAt !== null && row.renewsAt < now + 14 * DAY) {
      risk.push({ accountId: row.accountId, email: row.email, plan: row.plan, mrr: row.mrr, reason: "low_usage", renewsAt: row.renewsAt, activeDays: row.activeDays });
    }
  }

  return {
    now, currency: "USD",
    headline: {
      mrr, arr: mrr * 12, netNewMrr: thisMonth.netNew, customers, arpu, customerChurn, atRisk: { mrr: sum(atRiskNow), customers: atRiskNow.size },
      revenueChurn: ratio(lostSum, startMrr), netRevenueChurn: ratio(lostSum - expansion, startMrr),
      nrr: ratio(startMrr - lostSum + expansion, startMrr), grr: ratio(startMrr - lostSum, startMrr),
      ltv: arpu !== null && customerChurn ? Math.round(arpu / customerChurn) : null,
      ltvRealised: rows.length ? Math.round(rows.reduce((s, row) => s + row.ltv, 0) / rows.length) : null,
      previous: { mrr: lastMonth.mrr, netNewMrr: lastMonth.netNew, customers: lastMonth.customers, arpu: lastMonth.arpu, customerChurn: months.at(-5) ? ratio(months.slice(-5, -2).reduce((s, r) => s + r.churnedCustomers, 0), months.slice(-5, -2).reduce((s, r) => s + r.startCustomers, 0)) : null, ltv: lastMonth.ltv },
    },
    months, status,
    cohorts: { payment: paymentCohorts(lives, now), signup: signupCohorts(lives, input.accounts, now) },
    dunning: dunningOf(input, lives, pays, now),
    refunds: {
      count: refunds.length, cents: refunds.reduce((s, r) => s + r.amountCents, 0), rate: ratio(refunds.length, pays.length),
      count30: refunds30.length, cents30: refunds30.reduce((s, r) => s + r.amountCents, 0), rate30: ratio(refunds30.length, paid30.length),
      disputes: disputes.length, disputesOpen: disputes.filter(row => !closed.has(row.providerRef)).length, disputeRate: ratio(disputes.length, pays.length),
    },
    cash: {
      gross: pays.reduce((s, p) => s + p.amountCents, 0), refunds: refunds.reduce((s, r) => s + r.amountCents, 0), tax: pays.reduce((s, p) => s + p.taxCents, 0),
      afterTax: pays.reduce((s, p) => s + p.netCents, 0) - refunds.reduce((s, r) => s + r.amountCents, 0), payments: pays.length,
      /** how many payments carried the provider's settlement figures; the rest count at their charged amount */
      settled: pays.filter(p => p.netCents !== p.amountCents || p.taxCents > 0).length,
    },
    timeToPay: { median: median(waits), buckets: buckets.map(([label, max], i) => ({ label, count: waits.filter(ms => ms < max && (i === 0 || ms >= buckets[i - 1]![1])).length })) },
    checkout: { started: carts.length, paid: paidCount, abandoned, open, conversion: ratio(paidCount, carts.length - open),
      detectedAbandoned: input.ledger.filter(row => row.type === "abandoned_checkout.detected").length, recovered: input.ledger.filter(row => row.type === "abandoned_checkout.recovered").length,
      bySource: [...sources.values()].sort((a, b) => b.started - a.started) },
    breakdown: {
      plan: breakdown(row => row.plan), interval: breakdown(row => row.interval ?? "one time"), country: breakdown(row => row.country ?? "unknown"),
      channel: breakdown(row => row.channel), source: breakdown(row => row.source), cohort: breakdown(row => row.firstPaidAt ? monthLabel(row.firstPaidAt) : "unknown"),
    },
    upcoming, risk: risk.sort((a, b) => b.mrr - a.mrr),
    feed: feedOf(input, pays, refunds, label),
    customers: rows,
  };
}
export type SubscriptionReport = ReturnType<typeof subscriptionReport>;

/** the newest money moments: payments (new, renewal), failures, refunds, disputes, cancellations and plan changes */
export function feedOf(input: SubscriptionsInput, pays: readonly Pay[], refunds: readonly Refund[], label: (plan: string | null) => string, limit = 80): FeedItem[] {
  const email = (id: string | null) => emailOf(input, id);
  const firstOfAccount = new Map<string, string>(), seenSub = new Set<string>();
  const items: FeedItem[] = [];
  for (const pay of pays) {
    if (!firstOfAccount.has(pay.accountId)) firstOfAccount.set(pay.accountId, pay.paymentId);
    const first = firstOfAccount.get(pay.accountId) === pay.paymentId, renewal = !!pay.subscriptionId && seenSub.has(pay.subscriptionId);
    if (pay.subscriptionId) seenSub.add(pay.subscriptionId);
    const sub = input.subscriptions.find(row => row.id === pay.subscriptionId);
    items.push({ id: `pay:${pay.paymentId}`, at: pay.at, kind: first ? "new" : renewal ? "renewal" : "payment", accountId: pay.accountId, email: email(pay.accountId), amountCents: pay.amountCents,
      mrrDelta: null, plan: sub ? input.planOf(sub) : null, detail: pay.country });
  }
  for (const refund of refunds) items.push({ id: `ref:${refund.id}`, at: refund.at, kind: "refund", accountId: refund.accountId, email: email(refund.accountId), amountCents: -refund.amountCents, mrrDelta: null, plan: null, detail: null });
  const KINDS: Record<string, FeedItem["kind"]> = { "payment.failed": "failed", "subscription.on_hold": "failed", "subscription.failed": "failed", "dispute.opened": "dispute",
    "dispute.won": "dispute_closed", "dispute.lost": "dispute_closed", "subscription.cancel_scheduled": "cancel_scheduled", "subscription.cancel_undone": "kept", "subscription.cancelled": "churned",
    "subscription.expired": "churned", "subscription.upgraded": "upgrade", "subscription.downgraded": "downgrade", "subscription.recovered": "recovered", "abandoned_checkout.detected": "abandoned" };
  const failedPayments = new Set(input.invoices.filter(i => i.status === "failed").map(i => i.providerPaymentId));
  // a row's own plan is what it was called when written; its subscription, when still known, names it today
  const planOfRow = (row: LedgerEntry) => {
    const sub = row.subscriptionId ? input.subscriptions.find(item => item.id === row.subscriptionId) : undefined;
    return sub && !row.type.startsWith("subscription.upgraded") && !row.type.startsWith("subscription.downgraded") ? input.planOf(sub) : row.plan ? label(row.plan) : null;
  };
  for (const row of input.ledger) {
    const kind = KINDS[row.type];
    if (!kind) continue;
    items.push({ id: row.id, at: row.at, kind, accountId: row.accountId, email: email(row.accountId), amountCents: row.amountCents === null ? null : row.amountCents - taxIn(row.amountCents, row.taxCents),
      mrrDelta: row.mrrCents !== null && row.previousMrrCents !== null ? row.mrrCents - row.previousMrrCents : kind === "churned" && row.mrrCents !== null ? -row.mrrCents : null,
      plan: planOfRow(row), detail: row.reason ?? (kind === "dispute_closed" ? row.type.slice(8) : null) });
  }
  for (const invoice of input.invoices) if (invoice.status === "failed" && !input.ledger.some(row => row.providerPaymentId === invoice.providerPaymentId && row.type === "payment.failed") && failedPayments.has(invoice.providerPaymentId)) {
    items.push({ id: `fail:${invoice.id}`, at: invoice.createdAt, kind: "failed", accountId: invoice.accountId, email: email(invoice.accountId), amountCents: invoice.amountCents - taxIn(invoice.amountCents, invoice.taxCents), mrrDelta: null, plan: null, detail: null });
  }
  return items.sort((a, b) => b.at - a.at).slice(0, limit);
}

/** one person's billing at a glance, for their profile */
export function billingCardOf(report: SubscriptionReport, input: SubscriptionsInput, accountId: string) {
  const row = report.customers.find(item => item.accountId === accountId) ?? null;
  const invoices = input.invoices.filter(invoice => invoice.accountId === accountId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 12)
    .map(invoice => ({ id: invoice.id, at: invoice.createdAt, amountCents: invoice.amountCents, currency: invoice.currency, status: invoice.status, description: invoice.description }));
  const events = input.ledger.filter(entry => entry.accountId === accountId).sort((a, b) => b.at - a.at).slice(0, 100)
    .map(entry => ({ id: entry.id, at: entry.at, type: entry.type, amountCents: entry.amountCents, mrrCents: entry.mrrCents, previousMrrCents: entry.previousMrrCents, plan: entry.plan, reason: entry.reason }));
  return row || invoices.length || events.length ? { customer: row, invoices, events } : null;
}

/** MRR right now and at any moment, from the billing records alone */
export function mrrAtTime(input: Pick<SubscriptionsInput, "subscriptions" | "invoices" | "ledger">, at: number) {
  return sum(accountMrr(livesOf(input, paysOf(input), at), at));
}
/** yesterday's money for the owner's daily digest */
export function moneyDigestOf(input: Pick<SubscriptionsInput, "subscriptions" | "invoices" | "ledger" | "accounts">, from: number, to: number) {
  const pays = paysOf(input), first = new Map<string, Pay>();
  for (const pay of pays) if (!first.has(pay.accountId)) first.set(pay.accountId, pay);
  const within = (row: { at: number }) => row.at >= from && row.at < to;
  const rows = input.ledger.filter(within);
  const failed = new Set(rows.filter(row => row.type === "payment.failed" || row.type === "subscription.on_hold" || row.type === "subscription.failed").map(row => row.subscriptionId ?? row.id));
  return {
    newCustomers: [...first.values()].filter(within).map(pay => ({ email: input.accounts.get(pay.accountId)?.email ?? null, cents: pay.amountCents })),
    mrr: mrrAtTime(input, to - 1), netNew: mrrAtTime(input, to - 1) - mrrAtTime(input, from - 1), failed: failed.size,
    recovered: rows.filter(row => row.type === "subscription.recovered").length, churned: rows.filter(row => row.type === "subscription.cancelled" || row.type === "subscription.expired").length,
    refunds: rows.filter(row => row.type === "refund.succeeded").length,
  };
}
