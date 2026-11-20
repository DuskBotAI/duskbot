// Revenue for the owner's overview: every payment and refund from the billing records, tied back to the visit that
// brought the payer (the last non-direct touch before paying, else their first visit). Pure functions.
import { refundBeforeTax, taxIn } from "./subscriptions.ts";
import { DIMENSIONS, bucketsOf, matches, valuesOf, type Dimension, type Filters, type Identity, type Visit } from "./web.ts";

export interface InvoiceLike { id: string; accountId: string; providerPaymentId: string; subscriptionId: string | null; amountCents: number; taxCents?: number; currency: string; status: "paid" | "failed" | "refunded"; createdAt: number }
export interface SubscriptionLike { accountId: string; status: string; totalCents: number; createdAt: number; currentPeriodStart: number | null; cart: { interval: string }; trialEndsAt?: number; cancelAtPeriodEnd?: boolean; updatedAt?: number }
export interface BillingLike {
  invoices: readonly InvoiceLike[];
  subscriptions: readonly SubscriptionLike[];
  refunds?: ReadonlyArray<{ id: string; paymentId: string; amountCents: number; currency: string }>;
  webhookEvents?: ReadonlyArray<{ at: number; type: string }>;
  /** payment rows carry the tax an older invoice did not keep */
  ledger?: ReadonlyArray<{ type: string; providerPaymentId: string | null; taxCents: number | null }>;
}

export type PaymentKind = "new" | "renewal" | "one_time" | "refund";
/** `amountCents` is before tax (prices are tax exclusive); `taxCents` is the tax paid on top, negative on a refund */
export interface Payment { id: string; accountId: string; at: number; amountCents: number; taxCents: number; currency: string; kind: PaymentKind }

/** paid invoices as positive payments (a refunded one was still paid first) and each refund as a negative one */
export function paymentsOf(state: BillingLike): Payment[] {
  const out: Payment[] = [];
  const firstOf = new Map<string, number>();
  for (const invoice of state.invoices) {
    if (invoice.status === "failed" || !invoice.subscriptionId) continue;
    if (!firstOf.has(invoice.subscriptionId) || firstOf.get(invoice.subscriptionId)! > invoice.createdAt) firstOf.set(invoice.subscriptionId, invoice.createdAt);
  }
  const ledgerTax = new Map((state.ledger ?? []).filter(row => row.type === "payment.succeeded" && row.providerPaymentId && row.taxCents).map(row => [row.providerPaymentId!, row.taxCents!]));
  const taxOf = (invoice: InvoiceLike) => taxIn(invoice.amountCents, invoice.taxCents ?? ledgerTax.get(invoice.providerPaymentId));
  const byPayment = new Map<string, InvoiceLike>();
  for (const invoice of state.invoices) {
    byPayment.set(invoice.providerPaymentId, invoice);
    if (invoice.status === "failed" || invoice.amountCents <= 0) continue;
    const kind: PaymentKind = !invoice.subscriptionId ? "one_time" : firstOf.get(invoice.subscriptionId) === invoice.createdAt ? "new" : "renewal";
    const tax = taxOf(invoice);
    out.push({ id: invoice.id, accountId: invoice.accountId, at: invoice.createdAt, amountCents: invoice.amountCents - tax, taxCents: tax, currency: invoice.currency, kind });
  }
  // a refund record carries no time; the webhook log keeps one per refund in the same order, else it lands on the payment's day
  const refundTimes = (state.webhookEvents ?? []).filter(event => event.type === "refund.succeeded").map(event => event.at);
  for (const [i, refund] of (state.refunds ?? []).entries()) {
    const invoice = byPayment.get(refund.paymentId);
    if (!invoice || refund.amountCents <= 0) continue;
    const before = refundBeforeTax(refund.amountCents, { amountCents: invoice.amountCents - taxOf(invoice), chargedCents: invoice.amountCents });
    out.push({ id: refund.id, accountId: invoice.accountId, at: Math.max(invoice.createdAt, refundTimes[i] ?? invoice.createdAt), amountCents: -before, taxCents: -(refund.amountCents - before), currency: refund.currency, kind: "refund" });
  }
  return out.sort((a, b) => a.at - b.at);
}

const monthly = (sub: SubscriptionLike) => sub.cart.interval === "year" ? Math.round(sub.totalCents / 12) : sub.totalCents;
const PAYING = new Set(["active", "payment_problem", "cancelled"]);
/** monthly recurring revenue: today it is every paying subscription; at an earlier moment, those already paid by then
 * that are still paying or ended after it (an ended row's last update is its end; the records keep no other status history) */
const countedAt = (subs: readonly SubscriptionLike[], at: number, now: number) =>
  subs.filter(sub => sub.currentPeriodStart !== null || PAYING.has(sub.status)).filter(sub => sub.createdAt < at
    && (PAYING.has(sub.status) || (at < now && sub.status === "ended" && (sub.updatedAt === undefined || sub.updatedAt > at))));

/** free trials not set to cancel count in full: only cancellations come off */
export const TRIAL_CONVERSION = 1;
/** `full` counts every trial at its price; `expected` drops anything set to cancel or whose charge failed, then counts
 *  `conversion` of the trials left, in whole dollars; `atRisk` is the monthly value of failed charges and `atRiskCount` how many */
export interface MrrForecast { expected: number; paying: number; trials: number; full: number; conversion: number; atRisk: number; atRiskCount: number }
export function mrrForecastAt(subs: readonly SubscriptionLike[], at: number, now: number, conversion = TRIAL_CONVERSION): MrrForecast {
  let paying = 0, trials = 0, full = 0, atRisk = 0, atRiskCount = 0;
  for (const sub of countedAt(subs, at, now)) {
    const value = monthly(sub);
    full += value;
    if (sub.cancelAtPeriodEnd || sub.status === "cancelled") continue;
    if (sub.status === "payment_problem") { atRisk += value; atRiskCount++; continue; }
    if (sub.trialEndsAt === undefined || at >= sub.trialEndsAt) paying += value;
    else trials += value;
  }
  return { expected: Math.round((paying + trials * conversion) / 100) * 100, paying, trials, full, conversion, atRisk, atRiskCount };
}

export interface Touch { first: Visit | null; last: Visit | null }
/** the visits that brought an account: its first, and the last one before `at` that came from somewhere (not direct) */
export function touchOf(visits: readonly Visit[], at: number): Touch {
  const before = visits.filter(visit => visit.start <= at);
  const first = before[0] ?? visits[0] ?? null;
  const last = [...before].reverse().find(visit => visit.channel !== "direct" && visit.channel !== "unknown") ?? null;
  return { first, last };
}

export interface RevenueKpis { net: number; gross: number; refunds: number; payments: number; customers: number; newCustomers: number; renewals: number; mrr: number; mrrForecast: MrrForecast | null }
export interface RecentPayment {
  id: string; at: number; amountCents: number; currency: string; kind: PaymentKind; accountId: string; seed: string; email: string | null;
  source: string; channel: string; firstSource: string | null; campaign: string | null; country: string | null; city: string | null; device: string | null;
  firstSeen: number | null; signedUpAt: number | null;
}

/** the revenue key for a payment with no visit to credit: paid before tracking began, or from an untracked device */
export const NO_VISIT = "no_visit";

export interface RevenueInput {
  payments: readonly Payment[];
  subscriptions: readonly SubscriptionLike[];
  /** visits on the surfaces being looked at, oldest first */
  visits: readonly Visit[];
  identity: Identity;
  accounts: ReadonlyMap<string, { email: string; createdAt: number }>;
  from: number; to: number; now: number;
  filters: Filters;
}

/** the window's revenue: totals for this and the previous window, a series in the chart's buckets, money per card row,
 * and the newest payments with where each payer came from */
export function revenueReport(input: RevenueInput) {
  const { payments, identity, from, to, filters } = input, span = to - from;
  const visitsOf = new Map<string, Visit[]>();
  for (const visit of input.visits) {
    const account = visit.visitor.startsWith("acct_") ? visit.visitor : identity.accountOf.get(visit.visitor);
    if (account) (visitsOf.get(account) ?? visitsOf.set(account, []).get(account)!).push(visit);
  }
  const touches = new Map<string, Touch>();
  const touch = (payment: Payment) => {
    const key = `${payment.accountId}:${payment.at}`;
    if (!touches.has(key)) touches.set(key, touchOf(visitsOf.get(payment.accountId) ?? [], payment.at));
    return touches.get(key)!;
  };
  const credited = (payment: Payment) => { const t = touch(payment); return t.last ?? t.first; };
  const filtered = Object.keys(filters).length > 0;
  const counts = (payment: Payment) => !filtered || (() => { const visit = credited(payment); return !!visit && matches(visit, filters); })();
  const within = (a: number, b: number) => payments.filter(payment => payment.at >= a && payment.at < b && counts(payment));
  const firstPaid = new Map<string, number>();
  for (const payment of payments) if (payment.amountCents > 0 && !firstPaid.has(payment.accountId)) firstPaid.set(payment.accountId, payment.at);
  const kpis = (a: number, b: number, mrrTime: number): RevenueKpis => {
    const list = within(a, b), positive = list.filter(payment => payment.amountCents > 0);
    const customers = new Set(positive.map(payment => payment.accountId));
    const forecast = filtered ? null : mrrForecastAt(input.subscriptions, mrrTime, input.now);
    return {
      net: list.reduce((sum, payment) => sum + payment.amountCents, 0), gross: positive.reduce((sum, payment) => sum + payment.amountCents, 0),
      refunds: -list.filter(payment => payment.kind === "refund").reduce((sum, payment) => sum + payment.amountCents, 0),
      payments: positive.length, customers: customers.size, newCustomers: [...customers].filter(id => { const at = firstPaid.get(id)!; return at >= a && at < b; }).length,
      renewals: positive.filter(payment => payment.kind === "renewal").length, mrr: forecast?.expected ?? 0, mrrForecast: forecast,
    };
  };

  const { size, starts } = bucketsOf(from, to);
  const mrr = filtered ? null : starts.map(start => mrrForecastAt(input.subscriptions, Math.min(start + size, to, input.now), input.now).expected);
  const series = { new: starts.map(() => 0), renewal: starts.map(() => 0), refund: starts.map(() => 0), mrr };
  const byChannel: Record<string, number[]> = {};
  for (const payment of within(from, to)) {
    const i = Math.floor((payment.at - from) / size);
    if (i < 0 || i >= starts.length) continue;
    const channel = credited(payment)?.channel ?? NO_VISIT;
    (byChannel[channel] ??= starts.map(() => 0))[i]! += payment.amountCents;
    if (payment.kind === "refund") series.refund[i]! += payment.amountCents;
    else if (payment.kind === "renewal") series.renewal[i]! += payment.amountCents;
    else series.new[i]! += payment.amountCents;
  }

  const cards = Object.fromEntries(DIMENSIONS.map(dim => [dim, {} as Record<string, number>])) as Record<Dimension, Record<string, number>>;
  for (const payment of within(from, to)) {
    const visit = credited(payment);
    for (const dim of DIMENSIONS) for (const value of visit ? valuesOf(visit, dim) : [NO_VISIT]) cards[dim][value] = (cards[dim][value] ?? 0) + payment.amountCents;
  }

  const recent: RecentPayment[] = within(from, to).reverse().slice(0, 20).map(payment => {
    const t = touch(payment), visit = t.last ?? t.first, account = input.accounts.get(payment.accountId);
    return { id: payment.id, at: payment.at, amountCents: payment.amountCents, currency: payment.currency, kind: payment.kind, accountId: payment.accountId,
      seed: [...(identity.visitorsOf.get(payment.accountId) ?? [])][0] ?? payment.accountId, email: account?.email ?? null,
      source: visit?.source ?? "unknown", channel: visit?.channel ?? "unknown", firstSource: t.first && t.first !== visit ? t.first.source : null, campaign: visit?.campaign ?? null,
      country: visit?.country ?? null, city: visit?.city ?? null, device: visit?.device ?? null, firstSeen: t.first?.start ?? null, signedUpAt: account?.createdAt ?? null };
  });

  // lifetime value by where each customer first came from, over every payment they ever made (filters do not apply)
  const lifetime = new Map<string, { source: string; cents: number }>();
  for (const payment of payments) {
    const entry = lifetime.get(payment.accountId) ?? lifetime.set(payment.accountId, { source: touch(payment).first?.source ?? NO_VISIT, cents: 0 }).get(payment.accountId)!;
    entry.cents += payment.amountCents;
  }
  const bySource = new Map<string, { customers: number; cents: number }>();
  for (const { source, cents } of lifetime.values()) {
    if (cents <= 0) continue;
    const row = bySource.get(source) ?? bySource.set(source, { customers: 0, cents: 0 }).get(source)!;
    row.customers++; row.cents += cents;
  }
  const ltv = [...bySource].map(([source, row]) => ({ source, customers: row.customers, cents: row.cents, perCustomer: Math.round(row.cents / row.customers) }))
    .sort((a, b) => Number(a.source === NO_VISIT) - Number(b.source === NO_VISIT) || b.perCustomer - a.perCustomer).slice(0, 12);

  return { current: kpis(from, to, Math.min(to, input.now)), previous: kpis(from - span, from, from), series, byChannel, ltv, cards, recent, live: payments.length > 0, first: payments.find(payment => payment.amountCents > 0)?.at ?? null,
    trials: trialReport(input, visitsOf) };
}

export interface TrialKpis {
  /** trials that began in the window */
  started: number;
  /** of those, the ones whose trial is over, and of those the ones that went on to pay */
  ended: number; converted: number; conversion: number | null;
}
export interface TrialReport {
  current: TrialKpis; previous: TrialKpis;
  /** right now, whatever the window: trials running, those set to end, and the monthly value of the running ones not set to end */
  active: number; cancelling: number; mrrAtStake: number;
  /** trials begun per chart bucket */
  series: number[];
  /** trials begun per chart bucket, per channel that brought them */
  byChannel: Record<string, number[]>;
  /** trials begun per card row, credited like revenue: the last non-direct visit before the trial began, else the first */
  cards: Record<Dimension, Record<string, number>>;
}
const isTrial = (sub: SubscriptionLike) => sub.trialEndsAt !== undefined && sub.status !== "pending";
/** a trial that is over went on to pay when its plan still runs (or ran past the trial's end) */
const convertedTrial = (sub: SubscriptionLike, now: number) => sub.trialEndsAt! <= now && ((PAYING.has(sub.status) && sub.status !== "cancelled") || (sub.status === "ended" && (sub.updatedAt ?? 0) > sub.trialEndsAt! + 3_600_000));
/** the free trials of the window: how many began, how many of the finished ones paid, what is running now, and where they came from */
export function trialReport(input: RevenueInput, visitsOf: ReadonlyMap<string, Visit[]>): TrialReport {
  const { from, to, now, filters } = input, span = to - from, filtered = Object.keys(filters).length > 0;
  const trials = input.subscriptions.filter(isTrial);
  const credited = (sub: SubscriptionLike) => { const t = touchOf(visitsOf.get(sub.accountId) ?? [], sub.createdAt); return t.last ?? t.first; };
  const counts = (sub: SubscriptionLike) => !filtered || (() => { const visit = credited(sub); return !!visit && matches(visit, filters); })();
  const within = (a: number, b: number) => trials.filter(sub => sub.createdAt >= a && sub.createdAt < b && counts(sub));
  const kpis = (a: number, b: number): TrialKpis => {
    const list = within(a, b), ended = list.filter(sub => sub.trialEndsAt! <= now), converted = ended.filter(sub => convertedTrial(sub, now)).length;
    return { started: list.length, ended: ended.length, converted, conversion: ended.length ? converted / ended.length : null };
  };
  const running = trials.filter(sub => sub.trialEndsAt! > now && (sub.status === "active" || sub.status === "payment_problem") && counts(sub));
  const { size, starts } = bucketsOf(from, to);
  const series = starts.map(() => 0);
  const cards = Object.fromEntries(DIMENSIONS.map(dim => [dim, {} as Record<string, number>])) as Record<Dimension, Record<string, number>>;
  const byChannel: Record<string, number[]> = {};
  for (const sub of within(from, to)) {
    const i = Math.floor((sub.createdAt - from) / size), visit = credited(sub);
    if (i >= 0 && i < series.length) { series[i]!++; (byChannel[visit?.channel ?? NO_VISIT] ??= starts.map(() => 0))[i]!++; }
    for (const dim of DIMENSIONS) for (const value of visit ? valuesOf(visit, dim) : [NO_VISIT]) cards[dim][value] = (cards[dim][value] ?? 0) + 1;
  }
  return { current: kpis(from, to), previous: kpis(from - span, from), active: running.length, cancelling: running.filter(sub => sub.cancelAtPeriodEnd).length,
    mrrAtStake: running.filter(sub => !sub.cancelAtPeriodEnd).reduce((sum, sub) => sum + monthly(sub), 0), series, byChannel, cards };
}
