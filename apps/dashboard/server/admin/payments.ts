// who paid what: every payment, refund and subscription from the billing records, one mode at a time, with the person
// behind it. totals come from the same report the revenue page reads, so the two never disagree.
import type { BillingState, StoredSubscription } from "../billing/store.ts";
import { BILLING_CONFIG } from "../billing/plans.ts";
import { quote } from "../billing/pricing.ts";
import { monthlyCents, subscriptionReport } from "../analytics/subscriptions.ts";
import { moneyIn, withoutOps, type MoneyMode, type MoneyView } from "./money-mode.ts";
import type { PersonIdentity } from "./identity.ts";

export const planLabel = (id: string) => BILLING_CONFIG.bundles.find(bundle => bundle.id === id)?.label.toLowerCase() ?? (id === "custom" ? "custom" : id.replace(/_/g, " "));
export const planOf = (sub: Pick<StoredSubscription, "cart">) => { try { return planLabel(quote(sub.cart, BILLING_CONFIG).bundle ?? "custom"); } catch { return "custom"; } };

export type Money = Pick<BillingState, "customers" | "checkouts" | "subscriptions" | "invoices" | "refunds" | "ledger" | "webhookEvents">;
export type PaymentStatus = "paid" | "refunded" | "partially_refunded" | "failed";
/** `trial` is in the contract for when a plan has one; no plan does today (BILLING_CONFIG trial: null) */
export type SubscriptionStatus = "pending" | "trial" | "active" | "payment_problem" | "cancelling" | "cancelled" | "ended";
export interface DodoIds { paymentId: string | null; subscriptionId: string | null; customerId: string | null }

export interface PaymentRow {
  id: string; at: number; type: "payment" | "refund"; status: PaymentStatus;
  /** what the buyer was charged, tax included; negative on a refund */
  amountCents: number; taxCents: number;
  /** before tax */
  netCents: number;
  refundedCents: number; currency: string; plan: string | null; interval: "month" | "year" | null; mode: MoneyMode; source: string | null;
  dodo: DodoIds; personId: string;
}
export interface SubscriptionRow {
  id: string; personId: string; plan: string; interval: "month" | "year"; status: SubscriptionStatus;
  /** the price per period, before tax */
  amountCents: number; mrrCents: number; currency: string; startedAt: number; currentPeriodEnd: number | null; mode: MoneyMode; source: string | null; dodo: DodoIds;
}
export interface PersonMoney {
  personId: string; paidCents: number; refundedCents: number; netCents: number; payments: number; failed: number; currency: string;
  firstPaidAt: number | null; lastPaidAt: number | null; plan: string | null; status: SubscriptionStatus | null; mrrCents: number;
}
export interface ModeTotals {
  /** before tax, as the revenue page counts it; `chargedCents` is what buyers paid with tax */
  grossCents: number; taxCents: number; chargedCents: number; refundsCents: number;
  /** after tax and refunds: what the revenue page calls after tax */
  netCents: number;
  payments: number; failed: number; refunds: number; customers: number; activeSubscriptions: number; mrrCents: number; currency: string;
}

const subStatus = (sub: StoredSubscription): SubscriptionStatus => sub.status === "active" && sub.cancelAtPeriodEnd ? "cancelling" : sub.status;
const PAYING = new Set<SubscriptionStatus>(["active", "cancelling", "cancelled"]);

/** the records of one mode, without what the operator gave (grants, comps, App Review's cloud are never money) */
export function moneyOf(state: Money, mode: MoneyMode, serverMode: MoneyMode): Money {
  return moneyIn(withoutOps({ ...state, refunds: state.refunds ?? [], ledger: state.ledger ?? [] }), mode, serverMode);
}

export function totalsOf(state: Money, accounts: ReadonlyMap<string, { email: string; createdAt: number; name?: string | null }>, mode: MoneyMode, now: number): ModeTotals {
  const report = subscriptionReport({ subscriptions: state.subscriptions, invoices: state.invoices, refunds: state.refunds ?? [], ledger: state.ledger ?? [], checkouts: state.checkouts,
    customers: state.customers, accounts, activity: new Map(), planOf, planLabel, now, modeOf: () => mode });
  return { grossCents: report.cash.gross, taxCents: report.cash.tax, chargedCents: report.cash.gross + report.cash.tax, refundsCents: report.cash.refunds, netCents: report.cash.afterTax, payments: report.cash.payments,
    failed: state.invoices.filter(row => row.status === "failed").length, refunds: report.refunds.count, customers: report.headline.customers,
    activeSubscriptions: state.subscriptions.filter(sub => PAYING.has(subStatus(sub))).length, mrrCents: report.headline.mrr, currency: report.currency };
}

export function ledgerOf(state: Money, mode: MoneyMode): { payments: PaymentRow[]; subscriptions: SubscriptionRow[]; people: PersonMoney[] } {
  const subs = new Map(state.subscriptions.map(sub => [sub.id, sub]));
  const customer = new Map(state.customers.map(row => [row.accountId, row.providerCustomerId]));
  const refunded = new Map<string, number>();
  for (const refund of state.refunds ?? []) refunded.set(refund.paymentId, (refunded.get(refund.paymentId) ?? 0) + refund.amountCents);
  const refundAt = (state.webhookEvents ?? []).filter(event => event.type === "refund.succeeded").map(event => event.at);
  const ledgerTax = new Map((state.ledger ?? []).filter(row => row.type === "payment.succeeded" && row.providerPaymentId && row.taxCents).map(row => [row.providerPaymentId!, row.taxCents!]));
  const payments: PaymentRow[] = [];
  const byPayment = new Map<string, PaymentRow>();
  for (const invoice of state.invoices) {
    const sub = invoice.subscriptionId ? subs.get(invoice.subscriptionId) : undefined;
    const back = refunded.get(invoice.providerPaymentId) ?? 0, tax = invoice.taxCents ?? ledgerTax.get(invoice.providerPaymentId) ?? 0;
    const status: PaymentStatus = invoice.status === "failed" ? "failed" : (back > 0 && back >= invoice.amountCents) || invoice.status === "refunded" ? "refunded" : back > 0 ? "partially_refunded" : "paid";
    const row: PaymentRow = { id: invoice.id, at: invoice.createdAt, type: "payment", status, amountCents: invoice.amountCents, taxCents: tax, netCents: invoice.amountCents - tax,
      refundedCents: invoice.status === "failed" ? 0 : back, currency: invoice.currency, plan: sub ? planOf(sub) : null, interval: sub?.cart.interval ?? null, mode, source: sub?.source ?? null,
      dodo: { paymentId: invoice.providerPaymentId, subscriptionId: sub?.providerSubscriptionId ?? null, customerId: customer.get(invoice.accountId) ?? null }, personId: invoice.accountId };
    payments.push(row);
    byPayment.set(invoice.providerPaymentId, row);
  }
  for (const [i, refund] of (state.refunds ?? []).entries()) {
    const paid = byPayment.get(refund.paymentId);
    if (!paid) continue;
    payments.push({ ...paid, id: refund.id, at: Math.max(paid.at, refundAt[i] ?? paid.at), type: "refund", status: "refunded", amountCents: -refund.amountCents, taxCents: 0, netCents: -refund.amountCents,
      refundedCents: refund.amountCents, currency: refund.currency });
  }
  payments.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const subscriptions: SubscriptionRow[] = state.subscriptions.map(sub => ({ id: sub.id, personId: sub.accountId, plan: planOf(sub), interval: sub.cart.interval, status: subStatus(sub),
    amountCents: sub.totalCents, mrrCents: PAYING.has(subStatus(sub)) ? monthlyCents(sub) : 0, currency: "USD", startedAt: sub.currentPeriodStart ?? sub.createdAt, currentPeriodEnd: sub.currentPeriodEnd,
    mode, source: sub.source ?? null, dodo: { paymentId: null, subscriptionId: sub.providerSubscriptionId, customerId: customer.get(sub.accountId) ?? null } }))
    .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
  const people = new Map<string, PersonMoney>();
  const personOf = (id: string) => people.get(id) ?? people.set(id, { personId: id, paidCents: 0, refundedCents: 0, netCents: 0, payments: 0, failed: 0, currency: "USD", firstPaidAt: null,
    lastPaidAt: null, plan: null, status: null, mrrCents: 0 }).get(id)!;
  for (const row of payments) {
    const person = personOf(row.personId);
    if (row.type === "refund") { person.refundedCents += -row.amountCents; continue; }
    if (row.status === "failed") { person.failed++; continue; }
    person.paidCents += row.amountCents; person.payments++; person.currency = row.currency;
    person.firstPaidAt = person.firstPaidAt === null ? row.at : Math.min(person.firstPaidAt, row.at);
    person.lastPaidAt = Math.max(person.lastPaidAt ?? 0, row.at);
  }
  for (const sub of subscriptions) {
    const person = personOf(sub.personId);
    person.mrrCents += sub.mrrCents;
    // the newest subscription names the person's plan and status
    if (person.plan === null) { person.plan = sub.plan; person.status = sub.status; }
  }
  for (const person of people.values()) person.netCents = person.paidCents - person.refundedCents;
  return { payments, subscriptions, people: [...people.values()].sort((a, b) => b.netCents - a.netCents || (b.lastPaidAt ?? 0) - (a.lastPaidAt ?? 0)) };
}

export interface PaymentsAnswer {
  mode: MoneyView; serverMode: MoneyMode; data: string;
  totals: { live: ModeTotals; test: ModeTotals };
  people: Array<PersonMoney & { person: PersonIdentity; mode: MoneyMode }>;
  subscriptions: Array<SubscriptionRow & { person: PersonIdentity }>;
  payments: Array<PaymentRow & { person: PersonIdentity }>;
  next: string | null;
}

/** the payments page: both modes' totals, then the asked mode's rows (live by default), newest first, `before` an opaque cursor */
export function paymentsAnswer(input: {
  state: Money; serverMode: MoneyMode; mode: MoneyView; data: string; now: number;
  accounts: ReadonlyMap<string, { email: string; createdAt: number; name?: string | null }>;
  identity(accountId: string): PersonIdentity; q: string; status: string | null; before: string | null; limit: number;
}): PaymentsAnswer {
  const modes: MoneyMode[] = input.mode === "all" ? ["live", "test"] : [input.mode];
  const per = Object.fromEntries((["live", "test"] as const).map(mode => [mode, moneyOf(input.state, mode, input.serverMode)])) as Record<MoneyMode, Money>;
  const ledgers = modes.map(mode => ledgerOf(per[mode], mode));
  const q = input.q.trim().toLowerCase();
  const who = (personId: string) => input.identity(personId);
  const found = (personId: string, extra: Array<string | null>) => !q || [personId, who(personId).name, who(personId).email, ...extra].some(value => value?.toLowerCase().includes(q));
  const payments = ledgers.flatMap(ledger => ledger.payments).filter(row => (!input.status || row.status === input.status) && found(row.personId, [row.dodo.paymentId, row.dodo.subscriptionId, row.dodo.customerId]))
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const [beforeAt, beforeId] = input.before ? [Number(input.before.split(":")[0]), input.before.split(":").slice(1).join(":")] : [Infinity, ""];
  const page = payments.filter(row => row.at < beforeAt || (row.at === beforeAt && row.id.localeCompare(beforeId) > 0)).slice(0, input.limit + 1);
  const more = page.length > input.limit, rows = page.slice(0, input.limit);
  return {
    mode: input.mode, serverMode: input.serverMode, data: input.data,
    totals: { live: totalsOf(per.live, input.accounts, "live", input.now), test: totalsOf(per.test, input.accounts, "test", input.now) },
    people: ledgers.flatMap((ledger, i) => ledger.people.map(row => ({ ...row, mode: modes[i]!, person: who(row.personId) }))).filter(row => found(row.personId, [])),
    subscriptions: ledgers.flatMap(ledger => ledger.subscriptions).filter(row => found(row.personId, [row.dodo.subscriptionId, row.dodo.customerId])).map(row => ({ ...row, person: who(row.personId) })),
    payments: rows.map(row => ({ ...row, person: who(row.personId) })),
    next: more ? `${rows.at(-1)!.at}:${rows.at(-1)!.id}` : null,
  };
}
