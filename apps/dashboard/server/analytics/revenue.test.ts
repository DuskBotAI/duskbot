import { describe, expect, it } from "vitest";
import { DAY, identityOf, visitsOf } from "./web.ts";
import type { StoredEvent } from "./sink.ts";
import { NO_VISIT, mrrForecastAt, paymentsOf, revenueReport, TRIAL_CONVERSION, type InvoiceLike, type SubscriptionLike } from "./revenue.ts";

const T = Date.parse("2026-11-01T00:00:00Z");
const view = (visitor: string, session: string, at: number, source: string, channel: string, country = "DE"): StoredEvent =>
  ({ id: `${session}:${at}`, name: "site_view", at, accountId: null, props: { path: "/" }, ctx: { visitor, session, page: "/", source, channel: channel as never, country } }) as StoredEvent;
const identify = (accountId: string, visitor: string): StoredEvent => ({ id: `id:${visitor}`, name: "identify", at: T, accountId, props: { via: "page" }, ctx: { visitor } }) as StoredEvent;
const invoice = (id: string, accountId: string, subscriptionId: string | null, amountCents: number, at: number, status: InvoiceLike["status"] = "paid"): InvoiceLike =>
  ({ id, accountId, providerPaymentId: `pay_${id}`, subscriptionId, amountCents, currency: "USD", status, createdAt: at });

describe("free trials", () => {
  it("counts trials begun in the window, credits them like revenue, and says what is running and how many finished trials paid", () => {
    const events = [view("v1", "s1", T, "X", "social", "US"), view("v2", "s2", T, "direct", "direct", "IN"), identify("acct_a", "v1"), identify("acct_b", "v2")];
    const identity = identityOf(events), visits = visitsOf(events);
    const trial = (accountId: string, createdAt: number, extra: Partial<SubscriptionLike> = {}): SubscriptionLike =>
      ({ accountId, status: "active", totalCents: 2000, createdAt, currentPeriodStart: createdAt, cart: { interval: "month" }, trialEndsAt: createdAt + 3 * DAY, ...extra });
    const now = T + 6 * DAY;
    const subscriptions = [
      trial("acct_a", T + DAY),
      trial("acct_b", T + 2 * DAY, { status: "ended", updatedAt: T + 4 * DAY }),
      trial("acct_c", T + 4 * DAY, { cancelAtPeriodEnd: true }),
      trial("acct_d", T + 5 * DAY),
      trial("acct_e", T - 3 * DAY),
      { accountId: "acct_f", status: "active", totalCents: 2000, createdAt: T + DAY, currentPeriodStart: T + DAY, cart: { interval: "month" } } as SubscriptionLike,
      trial("acct_g", T + DAY, { status: "pending" }),
    ];
    const base = { payments: [], subscriptions, visits, identity, accounts: new Map(), from: T, to: T + 7 * DAY, now };
    const { trials } = revenueReport({ ...base, filters: {} });
    expect(trials.current).toEqual({ started: 4, ended: 2, converted: 1, conversion: 0.5 });
    expect(trials.previous).toMatchObject({ started: 1 });
    expect(trials).toMatchObject({ active: 2, cancelling: 1, mrrAtStake: 2000 });
    expect(trials.series).toEqual([0, 1, 1, 0, 1, 1, 0]);
    expect(trials.cards.channel).toEqual({ social: 1, direct: 1, [NO_VISIT]: 2 });
    expect(trials.byChannel.social).toEqual([0, 1, 0, 0, 0, 0, 0]);
    expect(revenueReport({ ...base, filters: { country: "US" } }).trials.current.started).toBe(1);
  });
});

describe("revenue", () => {
  it("drops everything set to cancel, then expects paying mrr plus the trial conversion share, and keeps the full-price figure", () => {
    const sub = (accountId: string, totalCents: number, extra: Partial<SubscriptionLike> = {}): SubscriptionLike =>
      ({ accountId, status: "active", totalCents, createdAt: T - DAY, currentPeriodStart: T - DAY, cart: { interval: "month" }, ...extra });
    const now = T + DAY, trialEnd = T + 7 * DAY;
    const subs = [
      sub("acct_paid", 2000),
      sub("acct_yearly", 24000, { cart: { interval: "year" } }),
      sub("acct_trial", 9900, { trialEndsAt: trialEnd }),
      sub("acct_trial2", 5000, { trialEndsAt: trialEnd }),
      sub("acct_trial_cancel", 9900, { trialEndsAt: trialEnd, cancelAtPeriodEnd: true }),
      sub("acct_trial_cancelled", 4900, { trialEndsAt: trialEnd, status: "cancelled" }),
      sub("acct_converted", 3000, { trialEndsAt: T }),
      sub("acct_gone", 9900, { status: "ended" }),
      sub("acct_paid_cancel", 2000, { cancelAtPeriodEnd: true }),
    ];
    expect(TRIAL_CONVERSION).toBe(1);
    expect(mrrForecastAt(subs, now, now)).toEqual({ paying: 2000 + 2000 + 3000, trials: 14900, full: 7000 + 14900 + 14800 + 2000, expected: 21900, conversion: 1, atRisk: 0, atRiskCount: 0 });
    const failed = mrrForecastAt([...subs, sub("acct_failed", 2000, { status: "payment_problem", trialEndsAt: T })], now, now);
    expect(failed, "a failed charge is at risk, not paying").toMatchObject({ paying: 2000 + 2000 + 3000, expected: 21900, atRisk: 2000, atRiskCount: 1 });
    // once the trials run out they count as paying in full; anything set to cancel is gone, paying or not
    expect(mrrForecastAt(subs.filter(row => row.status === "active"), trialEnd, trialEnd).expected).toBe(7000 + 14900);
    expect(mrrForecastAt(subs, now, now, 1).expected).toBe(7000 + 14900);
  });

  it("counts an ended subscription only before it ended, so a window ending a moment ago is not inflated by gone trials", () => {
    const sub = (accountId: string, totalCents: number, extra: Partial<SubscriptionLike> = {}): SubscriptionLike =>
      ({ accountId, status: "active", totalCents, createdAt: T, currentPeriodStart: T, cart: { interval: "month" }, trialEndsAt: T + 3 * DAY, ...extra });
    const now = T + DAY;
    const subs = [sub("acct_paid", 2000, { trialEndsAt: undefined }), sub("acct_trial", 5000), sub("acct_gone", 5000, { status: "ended", updatedAt: T + DAY / 2 })];
    expect(mrrForecastAt(subs, now - 60_000, now).expected).toBe(2000 + 5000);
    expect(mrrForecastAt(subs, T + DAY / 4, now).expected).toBe(2000 + 10000);
    expect(mrrForecastAt([sub("acct_odd", 1234, { trialEndsAt: undefined })], now, now).expected).toBe(1200);
  });

  it("charts expected mrr per bucket, the last one at the window's end, and none when filtered", () => {
    const sub = (accountId: string, createdAt: number): SubscriptionLike => ({ accountId, status: "active", totalCents: 2000, createdAt, currentPeriodStart: createdAt, cart: { interval: "month" } });
    const input = { payments: [], subscriptions: [sub("acct_a", T + DAY / 2), sub("acct_b", T + 2 * DAY + 1)], visits: [], identity: identityOf([]), accounts: new Map(), from: T, to: T + 3 * DAY - 1000, now: T + 3 * DAY, filters: {} };
    const report = revenueReport(input);
    expect(report.series.mrr).toEqual([2000, 2000, 4000]);
    expect(report.current.mrr).toBe(4000);
    expect(revenueReport({ ...input, filters: { country: "DE" } }).series.mrr).toBeNull();
  });

  it("splits new, renewal, one-time and refunds, with the refund on its webhook's day", () => {
    const payments = paymentsOf({
      invoices: [invoice("a", "acct_a", "sub_a", 2900, T), invoice("b", "acct_a", "sub_a", 2900, T + 30 * DAY), invoice("c", "acct_b", null, 1000, T + DAY), invoice("d", "acct_c", "sub_c", 900, T, "failed")],
      subscriptions: [], refunds: [{ id: "ref_1", paymentId: "pay_c", amountCents: 1000, currency: "USD" }], webhookEvents: [{ at: T + 3 * DAY, type: "refund.succeeded" }],
    });
    expect(payments.map(p => [p.id, p.kind, p.amountCents, p.at])).toEqual([
      ["a", "new", 2900, T], ["c", "one_time", 1000, T + DAY], ["ref_1", "refund", -1000, T + 3 * DAY], ["b", "renewal", 2900, T + 30 * DAY],
    ]);
  });

  it("credits the last non-direct touch before paying, falls back to the first visit, and honours filters", () => {
    const events = [view("v1", "s1", T, "X", "social", "US"), view("v1", "s2", T + DAY, "direct", "direct"), view("v2", "s3", T, "direct", "direct", "IN"), identify("acct_a", "v1"), identify("acct_b", "v2")];
    const identity = identityOf(events), visits = visitsOf(events);
    const payments = paymentsOf({ invoices: [invoice("a", "acct_a", "sub_a", 2900, T + 2 * DAY), invoice("b", "acct_b", null, 1000, T + 2 * DAY)], subscriptions: [] });
    const accounts = new Map([["acct_a", { email: "a@example.test", createdAt: T + 1000 }]]);
    const base = { payments, subscriptions: [], visits, identity, accounts, from: T, to: T + 7 * DAY, now: T + 7 * DAY };
    const report = revenueReport({ ...base, filters: {} });
    expect(report.current).toMatchObject({ net: 3900, gross: 3900, payments: 2, customers: 2, newCustomers: 2 });
    expect(report.cards.channel).toEqual({ social: 2900, direct: 1000 });
    expect(report.cards.country).toEqual({ US: 2900, IN: 1000 });
    expect(report.series.new[2]).toBe(3900);
    expect(report.recent.find(row => row.accountId === "acct_b")).toMatchObject({ source: "direct", country: "IN", email: null });
    expect(report.recent.find(row => row.accountId === "acct_a")).toMatchObject({ source: "X", channel: "social", email: "a@example.test", firstSeen: T });
    expect(revenueReport({ ...base, filters: { channel: "social" } }).current.net).toBe(2900);
    expect(revenueReport({ ...base, from: T + 7 * DAY, to: T + 14 * DAY, now: T + 14 * DAY, filters: {} }).previous.net).toBe(3900);
  });

  it("splits money by channel over time, values each first source by its customers, and names payments with no visit plainly", () => {
    const events = [view("v1", "s1", T, "X", "social"), view("v2", "s2", T, "Google", "search"), identify("acct_a", "v1"), identify("acct_b", "v2")];
    const payments = paymentsOf({ invoices: [invoice("a", "acct_a", "sub_a", 2000, T + DAY), invoice("a2", "acct_a", "sub_a", 2000, T + 3 * DAY), invoice("b", "acct_b", null, 1000, T + DAY), invoice("c", "acct_c", null, 500, T + 2 * DAY)], subscriptions: [] });
    const report = revenueReport({ payments, subscriptions: [], visits: visitsOf(events), identity: identityOf(events), accounts: new Map(), from: T, to: T + 7 * DAY, now: T + 7 * DAY, filters: {} });
    expect(report.byChannel.social).toEqual([0, 2000, 0, 2000, 0, 0, 0]);
    expect(report.byChannel.search![1]).toBe(1000);
    expect(report.byChannel[NO_VISIT]![2]).toBe(500);
    expect(report.cards.channel[NO_VISIT]).toBe(500);
    expect(report.ltv).toEqual([
      { source: "X", customers: 1, cents: 4000, perCustomer: 4000 }, { source: "Google", customers: 1, cents: 1000, perCustomer: 1000 }, { source: NO_VISIT, customers: 1, cents: 500, perCustomer: 500 },
    ]);
  });
});
