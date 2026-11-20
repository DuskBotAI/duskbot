import { describe, expect, it } from "vitest";
import type { StoredCheckout, StoredInvoice, StoredSubscription } from "../billing/store.ts";
import { draft, ledgerId, type LedgerEntry } from "../billing/ledger.ts";
import { monthlyCents, movementOf, paysOf, receivedIn, subscriptionReport, type SubscriptionsInput } from "./subscriptions.ts";

const at = (month: number, day: number) => Date.UTC(2026, month - 1, day, 12);
const now = at(6, 15);
const cart = (interval: "month" | "year") => ({ interval, license: { kind: "none" as const }, desktop: { kind: "shared_s" as const, region: "fsn1" } });
function sub(id: string, accountId: string, totalCents: number, opts: Partial<StoredSubscription> & { interval?: "month" | "year" } = {}): StoredSubscription {
  return { id, accountId, providerSubscriptionId: `d${id}`, checkoutId: `chk_${id}`, cart: cart(opts.interval ?? "month"), totalCents, lines: [], status: "active", licenseId: null, cloudId: null,
    currentPeriodStart: at(6, 1), currentPeriodEnd: at(7, 1), cancelAtPeriodEnd: false, createdAt: at(1, 1), updatedAt: at(1, 1), version: 1, source: null, ...opts };
}
let n = 0;
const invoice = (subscriptionId: string | null, accountId: string, createdAt: number, amountCents: number, status: StoredInvoice["status"] = "paid"): StoredInvoice =>
  ({ id: `inv_${n}`, accountId, providerPaymentId: `pay_${n++}`, subscriptionId, checkoutId: null, amountCents, currency: "USD", status, description: "", createdAt });
const row = (input: Partial<LedgerEntry> & Pick<LedgerEntry, "key" | "type" | "at">): LedgerEntry => ({ ...draft({ via: "fixture", ...input }), id: ledgerId(input.key), recordedAt: input.at });

// A: $20/mo since January. B: $50/mo from March, upgraded to $100 in May. C: $240/yr from February, gone April 20.
// D: $30/mo February to March 20, back in May on a new plan. E: a comp. F: $40/mo from April, down to $10 in June.
function fixture(): SubscriptionsInput {
  n = 0;
  const subscriptions = [
    sub("a", "A", 2000, { currentPeriodEnd: at(6, 20) }), sub("b", "B", 10000), sub("c", "C", 24000, { interval: "year", status: "ended", currentPeriodEnd: at(4, 20), updatedAt: at(4, 20) }),
    sub("d1", "D", 3000, { status: "ended", currentPeriodEnd: at(3, 20), updatedAt: at(3, 20) }), sub("d2", "D", 3000), sub("e", "E", 0, { source: "admin_comp" }), sub("f", "F", 1000),
  ];
  const invoices = [
    invoice("a", "A", at(1, 10), 2000), invoice("a", "A", at(2, 10), 2000), invoice("c", "C", at(2, 1), 24000), invoice("d1", "D", at(2, 15), 3000),
    invoice("d1", "D", at(3, 10), 3000, "failed"), invoice("b", "B", at(3, 5), 5000), invoice("f", "F", at(4, 3), 4000), invoice("f", "F", at(5, 3), 4000, "failed"),
    invoice("f", "F", at(5, 5), 4000), invoice("d2", "D", at(5, 2), 3000), invoice("b", "B", at(5, 10), 5000),
  ];
  const ledger = [
    row({ key: "up:b", type: "subscription.upgraded", at: at(5, 10), accountId: "B", subscriptionId: "b", previousMrrCents: 5000, mrrCents: 10000 }),
    row({ key: "down:f", type: "subscription.downgraded", at: at(6, 2), accountId: "F", subscriptionId: "f", previousMrrCents: 4000, mrrCents: 1000 }),
    row({ key: "end:c", type: "subscription.cancelled", at: at(4, 20), accountId: "C", subscriptionId: "c", mrrCents: 2000 }),
    row({ key: "fail:a", type: "payment.failed", at: at(6, 1), accountId: "A", subscriptionId: "a", providerPaymentId: "pay_a_fail" }),
    row({ key: "dispute:1", type: "dispute.opened", at: at(5, 20), accountId: "B", providerRef: "dsp_1", amountCents: 5000 }),
  ];
  const accounts = new Map([["A", at(1, 9)], ["B", at(3, 1)], ["C", at(2, 1)], ["D", at(2, 14)], ["E", at(4, 1)], ["F", at(4, 3)], ["G", at(6, 1)]].map(([id, createdAt]) => [id as string, { email: `${String(id).toLowerCase()}@example.test`, createdAt: createdAt as number }]));
  const checkouts = [
    { id: "chk_1", kind: "cart", status: "completed", source: "dash_home", createdAt: at(5, 1), openUntil: at(5, 1), subscriptionId: "d2" },
    { id: "chk_2", kind: "cart", status: "expired", source: "dash_home", createdAt: at(5, 2), openUntil: at(5, 2), subscriptionId: null },
    { id: "chk_3", kind: "cart", status: "open", source: "app_card", createdAt: now - 1000, openUntil: now + 1000, subscriptionId: null },
  ] as unknown as StoredCheckout[];
  return { subscriptions, invoices, refunds: [{ id: "ref_1", paymentId: invoices[2]!.providerPaymentId, amountCents: 24000, currency: "USD" }], ledger, checkouts,
    customers: [{ accountId: "A", attribution: { source: "X", channel: "social", campaign: null, referrer: null, country: "US", firstSeen: at(1, 8) } }],
    accounts, activity: new Map([["A", 0], ["B", 9], ["D", 4], ["F", 6]]), planOf: s => s.cart.desktop.kind, planLabel: id => id, now };
}

describe("subscription metrics", () => {
  it("names each account's MRR movement", () => {
    expect(movementOf(0, 500, false)).toEqual({ kind: "new", cents: 500 });
    expect(movementOf(0, 500, true)).toEqual({ kind: "reactivation", cents: 500 });
    expect(movementOf(500, 0, true)).toEqual({ kind: "churned", cents: -500 });
    expect(movementOf(500, 800, true)).toEqual({ kind: "expansion", cents: 300 });
    expect(movementOf(800, 500, true)).toEqual({ kind: "contraction", cents: -300 });
    expect(movementOf(500, 500, true)).toBeNull();
  });
  it("adds up MRR month by month with movements that sum to the change", () => {
    const report = subscriptionReport(fixture());
    const months = Object.fromEntries(report.months.map(m => [m.label, m]));
    expect(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"].map(label => months[label]!.mrr)).toEqual([2000, 7000, 9000, 11000, 19000, 16000]);
    expect(months["2026-03"]).toMatchObject({ new: 5000, churned: -3000, netNew: 2000, startCustomers: 3, churnedCustomers: 1, customerChurn: 1 / 3 });
    expect(months["2026-04"]).toMatchObject({ new: 4000, churned: -2000, netNew: 2000 });
    expect(months["2026-05"]).toMatchObject({ expansion: 5000, reactivation: 3000, reactivatedCustomers: 1, new: 0, nrr: (11000 + 5000) / 11000, grr: 1 });
    expect(months["2026-06"]).toMatchObject({ contraction: -3000, netNew: -3000, grossRevenueChurn: 3000 / 19000 });
    for (const m of report.months) expect(m.new + m.expansion + m.reactivation + m.contraction + m.churned).toBe(m.netNew);
  });
  it("reads the headline from the last three full months: churn, LTV, revenue churn, NRR and GRR", () => {
    const { headline } = subscriptionReport(fixture());
    expect(headline).toMatchObject({ mrr: 16000, arr: 192000, customers: 4, arpu: 4000, netNewMrr: -3000, customerChurn: 2 / 9, ltv: 18000,
      revenueChurn: 5000 / 27000, netRevenueChurn: 0, nrr: 1, grr: 22000 / 27000 });
    expect(headline.previous).toMatchObject({ mrr: 19000, customers: 4 });
  });
  it("leaves comps out of MRR but lists them", () => {
    const report = subscriptionReport(fixture());
    expect(report.status).toMatchObject({ active: 4, comped: 1, churned: 1 });
    expect(report.customers.find(c => c.accountId === "E")).toMatchObject({ status: "comped", mrr: 0 });
  });
  it("builds cohorts by first payment and by sign-up month", () => {
    const report = subscriptionReport(fixture());
    const feb = report.cohorts.payment.find(c => c.label === "2026-02")!;
    expect(feb).toMatchObject({ size: 2, base: 5000 });
    expect(feb.logo.slice(0, 5)).toEqual([1, 0.5, 0, 0.5, 0.5]);
    expect(feb.revenue.slice(0, 4)).toEqual([1, 0.4, 0, 0.6]);
    expect(feb.logo[5]).toBeNull();
    const signups = report.cohorts.signup.find(c => c.label === "2026-06")!;
    expect(signups).toMatchObject({ size: 1, logo: [0, null, null, null, null, null, null, null, null, null, null, null] });
  });
  it("tracks dunning: recovered, lost and still open", () => {
    expect(subscriptionReport(fixture()).dunning).toMatchObject({ failed: 3, recovered: 1, lost: 1, open: 1, rate: 0.5 });
  });
  it("realised LTV is what each customer paid less refunds; refunds and disputes as rates", () => {
    const report = subscriptionReport(fixture());
    expect(report.customers.find(c => c.accountId === "C")).toMatchObject({ ltv: 0, status: "churned", health: "gone" });
    expect(report.customers.find(c => c.accountId === "B")).toMatchObject({ ltv: 10000, mrr: 10000 });
    // the newest payment, not the first; F's failed charge on may 3 does not count
    expect(report.customers.find(c => c.accountId === "B")).toMatchObject({ lastPaidAt: at(5, 10), lastPaidCents: 5000 });
    expect(report.customers.find(c => c.accountId === "F")).toMatchObject({ lastPaidAt: at(5, 5), lastPaidCents: 4000 });
    expect(report.customers.find(c => c.accountId === "E")).toMatchObject({ lastPaidAt: null, lastPaidCents: null });
    expect(report.refunds).toMatchObject({ count: 1, cents: 24000, disputes: 1, disputesOpen: 1 });
    expect(report.refunds.rate).toBeCloseTo(1 / 9);
    expect(report.cash).toMatchObject({ gross: 52000, refunds: 24000, afterTax: 28000 });
  });
  it("counts checkout conversion without the still-open ones, and flags who is at risk", () => {
    const report = subscriptionReport(fixture());
    expect(report.checkout).toMatchObject({ started: 3, paid: 1, abandoned: 1, open: 1, conversion: 0.5 });
    expect(report.risk).toEqual([expect.objectContaining({ accountId: "A", reason: "low_usage", activeDays: 0 })]);
    expect(report.customers.find(c => c.accountId === "A")).toMatchObject({ health: "watch", channel: "social", country: "US" });
    expect(report.upcoming.map(u => u.accountId).sort()).toEqual(["A", "B", "D", "F"]);
    expect(report.breakdown.channel[0]).toMatchObject({ key: "unknown", customers: 3 });
  });
  it("feeds the newest money moments, first payment as new and later ones as renewals", () => {
    const feed = subscriptionReport(fixture()).feed;
    expect(feed[0]).toMatchObject({ kind: "downgrade", accountId: "F", mrrDelta: -3000 });
    expect(feed.find(item => item.accountId === "A" && item.kind === "new")).toBeTruthy();
    expect(feed.filter(item => item.accountId === "A" && item.kind === "renewal")).toHaveLength(1);
    expect(feed.find(item => item.kind === "refund")).toMatchObject({ amountCents: -24000, accountId: "C" });
  });
});

describe("failed charges", () => {
  it("are left out of the headline mrr and customers and shown as at risk", () => {
    const base = fixture();
    const failed = sub("failed", "acct_failed", 3000, { createdAt: at(5, 1), currentPeriodStart: at(5, 1), status: "payment_problem" });
    const paid = invoice("failed", "acct_failed", at(5, 1), 3000);
    const withFailed = { ...base, subscriptions: [...base.subscriptions, failed], invoices: [...base.invoices, paid],
      ledger: [...base.ledger, row({ key: "pay:failed", type: "payment.succeeded", at: at(5, 1), accountId: "acct_failed", subscriptionId: "failed", providerPaymentId: paid.providerPaymentId, amountCents: 3000 })] };
    const before = subscriptionReport(base).headline, after = subscriptionReport(withFailed).headline;
    expect(after).toMatchObject({ mrr: before.mrr, customers: before.customers, arpu: before.arpu, atRisk: { mrr: 3000, customers: 1 } });
    expect(before.atRisk).toEqual({ mrr: 0, customers: 0 });
  });
});

describe("App Review's demo plan", () => {
  it("is never revenue: neither its payments nor its plan count", () => {
    const base = fixture();
    const review = sub("review", "acct_review", 2000, { createdAt: at(5, 1), currentPeriodStart: at(6, 1), review: true });
    const paid = invoice("review", "acct_review", at(6, 2), 2000);
    const withReview = { ...base, subscriptions: [...base.subscriptions, review], invoices: [...base.invoices, paid],
      ledger: [...base.ledger, row({ key: "pay:review", type: "payment.succeeded", at: at(6, 2), accountId: "acct_review", subscriptionId: "review", providerPaymentId: paid.providerPaymentId, amountCents: 2000 })] };
    expect(paysOf(withReview).some(pay => pay.subscriptionId === "review")).toBe(false);
    expect(monthlyCents(review)).toBe(0);
    const before = subscriptionReport(base), after = subscriptionReport(withReview);
    expect(after.headline).toEqual(before.headline);
    expect(after.months).toEqual(before.months);
  });
});

describe("received", () => {
  it("is payments before tax less refunds inside the range, a value per day", () => {
    const from = at(6, 1), day = 86_400_000;
    const pays = [
      { paymentId: "a", accountId: "A", subscriptionId: null, at: from - 1, amountCents: 9999, chargedCents: 9999, netCents: 9999, taxCents: 0, country: null },
      { paymentId: "b", accountId: "B", subscriptionId: null, at: from + 1, amountCents: 2000, chargedCents: 2400, netCents: 2000, taxCents: 400, country: null },
      { paymentId: "c", accountId: "C", subscriptionId: null, at: from + 2 * day, amountCents: 3000, chargedCents: 3000, netCents: 3000, taxCents: 0, country: null },
    ];
    const refunds = [{ id: "r", paymentId: "c", accountId: "C", at: from + 2 * day + 5, amountCents: 1000 }];
    expect(receivedIn(pays, refunds, from, from + 3 * day)).toEqual({ cents: 4000, refundsCents: 1000, payments: 2, starts: [from, from + day, from + 2 * day], series: [2000, 0, 2000] });
  });
});
