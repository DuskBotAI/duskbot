import { randomBytes } from "node:crypto";
import { BillingProviderError } from "./types.ts";
import type { ApplyDiscountInput, BillingProvider, ChangePlanInput, ChangeQuote, CreateCheckoutInput } from "./types.ts";
import { signWebhook, verifyWebhook } from "./webhook-signature.ts";

type RetryAnswer = "sent" | "later" | "automatic" | "refused";
const id = (prefix: string) => `${prefix}${randomBytes(16).toString("base64url")}`;
export function createFakeBillingProvider(options: { secret?: string; now?: () => number } = {}) {
  const secret = options.secret ?? `whsec_${randomBytes(32).toString("base64")}`, now = options.now ?? Date.now;
  const sessions = new Map<string, CreateCheckoutInput>();
  const subscriptions = new Map<string, { input: CreateCheckoutInput; customerId: string; nextBillingAt: number; cancel: boolean; trialEndsAt: number | null;
    scheduled: { cart: CreateCheckoutInput["cart"]; billing?: CreateCheckoutInput["billing"] } | null }>();
  const payments = new Map<string, { amount: number; currency: string }>();
  const completed = new Map<string, ReturnType<typeof signWebhook>[]>();
  const cancelCalls: Array<{ subscriptionId: string; cancel: boolean }> = [], changeCalls: ChangePlanInput[] = [];
  const cancelNowCalls: string[] = [], refundCalls: Array<{ paymentId: string; reason: string }> = [], discountCalls: ApplyDiscountInput[] = [];
  const charges: Array<{ subscriptionId: string; cents: number }> = [], cancelScheduledCalls: string[] = [], retryCalls: string[] = [];
  function sign(eventId: string, body: Buffer | string | object) { return signWebhook(secret, eventId, Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body), now()); }
  function delivery(type: string, data: object) { return sign(id("evt_"), { business_id: "fake_business", type, timestamp: new Date(now()).toISOString(), data }); }
  function next(time: number, interval: "month" | "year") {
    const date = new Date(time), day = date.getUTCDate(); date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + (interval === "year" ? 12 : 1));
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate(); date.setUTCDate(Math.min(day, last)); return date.getTime();
  }
  function previous(time: number, interval: "month" | "year") {
    const date = new Date(time), day = date.getUTCDate(); date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - (interval === "year" ? 12 : 1));
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate(); date.setUTCDate(Math.min(day, last)); return date.getTime();
  }
  /** dodo's arithmetic, without tax: keep_cycle charges the price difference for the time left; new_cycle a full new
   *  cycle less the unused time of this one */
  function quoteChange(input: ChangePlanInput): ChangeQuote {
    const sub = subscriptions.get(input.subscriptionId); if (!sub) throw new BillingProviderError("refused");
    if (input.mode === "trial" || input.mode === "scheduled") return { chargeCents: 0, taxCents: 0 };
    const interval = sub.input.billing?.interval ?? "month", start = previous(sub.nextBillingAt, interval);
    const left = Math.max(0, Math.min(1, (sub.nextBillingAt - now()) / (sub.nextBillingAt - start)));
    const from = sub.input.billing?.amountCents ?? 0, to = input.billing?.amountCents ?? 0;
    const cents = input.mode === "keep_cycle" ? Math.round((to - from) * left) : Math.round(to - from * left);
    return { chargeCents: Math.max(0, cents), taxCents: 0 };
  }
  function subscriptionData(subscriptionId: string) {
    const sub = subscriptions.get(subscriptionId); if (!sub) throw new BillingProviderError("refused");
    return { subscription_id: subscriptionId, customer: { customer_id: sub.customerId }, metadata: { checkoutId: sub.input.checkoutId, accountId: sub.input.accountId },
      product_id: sub.input.cart[0].productId, addons: sub.input.cart[0].addons.map(addon => ({ addon_id: addon.addonId, quantity: addon.quantity })),
      next_billing_date: new Date(sub.nextBillingAt).toISOString(), cancel_at_next_billing_date: sub.cancel, status: "active" };
  }
  function payment(input: CreateCheckoutInput, customerId: string, subscriptionId: string | null, free = false) {
    const paymentId = id("pay_"), amount = free ? 0 : input.billing?.amountCents ?? 0, currency = input.billing?.currency ?? "USD";
    payments.set(paymentId, { amount, currency });
    return delivery("payment.succeeded", { payment_id: paymentId, subscription_id: subscriptionId, customer: { customer_id: customerId }, metadata: { checkoutId: input.checkoutId, accountId: input.accountId }, total_amount: amount, currency });
  }
  const provider = {
    name: "fake" as const, secret, sessions, subscriptions, payments, cancelCalls, changeCalls, cancelNowCalls, refundCalls, discountCalls, charges, cancelScheduledCalls,
    failChangePlan: false as boolean | "refused", failDiscount: false, paymentUrl: null as string | null,
    retryCalls, retryAnswer: "sent" as RetryAnswer,
    async retryPayment(this: { retryAnswer: RetryAnswer }, paymentId: string): Promise<RetryAnswer> { retryCalls.push(paymentId); return this.retryAnswer; },
    async createCheckout(input: CreateCheckoutInput) { const sessionId = id("fake_"); sessions.set(sessionId, structuredClone(input)); return { sessionId, url: `https://test.checkout.dodopayments.com/session/${sessionId}` }; },
    async updatePaymentMethod(subscriptionId: string, _returnUrl: string) { return { url: `https://test.checkout.dodopayments.com/fake_card_${encodeURIComponent(subscriptionId)}` }; },
    verifyWebhook: (headers, body) => verifyWebhook(secret, headers, body, now()),
    async cancelAtPeriodEnd(subscriptionId: string, cancel: boolean) { cancelCalls.push({ subscriptionId, cancel }); const sub = subscriptions.get(subscriptionId); if (sub) sub.cancel = cancel; },
    async cancelNow(subscriptionId: string) { cancelNowCalls.push(subscriptionId); subscriptions.delete(subscriptionId); },
    async setNextBillingDate(subscriptionId: string, at: number) { const sub = subscriptions.get(subscriptionId); if (!sub) throw new BillingProviderError("refused"); sub.nextBillingAt = at; },
    async refundPayment(paymentId: string, reason: string) { if (!payments.has(paymentId)) throw new BillingProviderError("refused"); refundCalls.push({ paymentId, reason }); },
    async previewChange(input: ChangePlanInput): Promise<ChangeQuote> { if (provider.failChangePlan === true) throw new BillingProviderError("unavailable"); return quoteChange(input); },
    async changePlan(input: ChangePlanInput): Promise<{ paymentUrl: string | null }> {
      changeCalls.push(structuredClone(input)); if (provider.failChangePlan) throw new BillingProviderError(provider.failChangePlan === "refused" ? "refused" : "unavailable");
      const sub = subscriptions.get(input.subscriptionId);
      if (!sub) return { paymentUrl: null };
      const cart = [{ productId: input.productId, quantity: 1, addons: structuredClone(input.addons) }];
      sub.scheduled = null;
      if (input.mode === "scheduled") { sub.scheduled = { cart, ...(input.billing ? { billing: structuredClone(input.billing) } : {}) }; return { paymentUrl: null }; }
      const cents = quoteChange(input).chargeCents;
      if (cents > 0) charges.push({ subscriptionId: input.subscriptionId, cents });
      sub.input.cart = cart; if (input.billing) sub.input.billing = structuredClone(input.billing);
      if (input.mode === "new_cycle") sub.nextBillingAt = next(now(), sub.input.billing?.interval ?? "month");
      return { paymentUrl: provider.paymentUrl };
    },
    async cancelScheduledChange(subscriptionId: string) { cancelScheduledCalls.push(subscriptionId); const sub = subscriptions.get(subscriptionId); if (sub) sub.scheduled = null; },
    async subscription(subscriptionId: string) {
      const sub = subscriptions.get(subscriptionId); if (!sub) throw new BillingProviderError("refused");
      return { productId: sub.input.cart[0].productId, addons: structuredClone(sub.input.cart[0].addons), nextBillingAt: sub.nextBillingAt, status: "active",
        scheduled: sub.scheduled ? { productId: sub.scheduled.cart[0].productId, addons: structuredClone(sub.scheduled.cart[0].addons) } : null };
    },
    async applyDiscount(input: ApplyDiscountInput) {
      if (provider.failDiscount) throw new BillingProviderError("unavailable");
      discountCalls.push(structuredClone(input)); return { code: `KEEP${randomBytes(6).toString("hex").toUpperCase()}` };
    },
    async invoiceUrl(paymentId: string) { return `https://test.customer.dodopayments.com/invoices/${encodeURIComponent(paymentId)}`; },
    async invoicePdf(_paymentId: string) { return { contentType: "application/pdf", body: Buffer.from("%PDF-1.4\n%%EOF\n") }; },
    sign,
    complete(sessionId: string) {
      const previous = completed.get(sessionId); if (previous) return previous.map(delivery => sign(delivery.headers["webhook-id"], delivery.body));
      const input = sessions.get(sessionId); if (!input) throw new BillingProviderError("refused");
      const customerId = input.customerId ?? id("cus_"), subscriptionId = id("dsub_");
      const trial = input.trialDays ?? 0, result = [payment(input, customerId, subscriptionId, trial > 0)];
      const interval = input.billing?.interval ?? (input.cart[0].productId.endsWith(":year") ? "year" : "month");
      subscriptions.set(subscriptionId, { input: structuredClone(input), customerId, nextBillingAt: trial ? now() + trial * 86_400_000 : next(now(), interval), cancel: false, trialEndsAt: trial ? now() + trial * 86_400_000 : null, scheduled: null });
      result.push(delivery("subscription.active", subscriptionData(subscriptionId)));
      completed.set(sessionId, result); return result;
    },
    renew(subscriptionId: string) {
      const sub = subscriptions.get(subscriptionId); if (!sub) throw new BillingProviderError("refused");
      if (sub.scheduled) { sub.input.cart = sub.scheduled.cart; if (sub.scheduled.billing) sub.input.billing = sub.scheduled.billing; sub.scheduled = null; }
      sub.trialEndsAt = null;
      sub.nextBillingAt = next(sub.nextBillingAt, sub.input.billing?.interval ?? "month");
      return [payment(sub.input, sub.customerId, subscriptionId), delivery("subscription.renewed", subscriptionData(subscriptionId))];
    },
    fail(subscriptionId: string) { return [delivery("subscription.on_hold", { ...subscriptionData(subscriptionId), status: "on_hold" })]; },
    expire(subscriptionId: string) { return [delivery("subscription.expired", { ...subscriptionData(subscriptionId), status: "expired" })]; },
    refund(paymentId: string) { const payment = payments.get(paymentId); if (!payment) throw new BillingProviderError("refused"); return [delivery("refund.succeeded", { refund_id: id("ref_"), payment_id: paymentId, amount: payment.amount, currency: payment.currency })]; },
  } satisfies BillingProvider & Record<string, unknown>;
  return provider;
}
