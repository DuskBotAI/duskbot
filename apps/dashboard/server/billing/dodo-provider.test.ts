import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { checkoutName, createDodoProvider } from "./dodo-provider.ts";

let server: Server, baseUrl: string;
let requests: Array<{ method: string; url: string; auth: string | undefined; body: unknown }>;
let reply: unknown, status: number, contentType: string;
const apiKey = "fixture-private-key";
beforeEach(async () => {
  requests = []; reply = {}; status = 200; contentType = "application/json";
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    res.writeHead(status, { "content-type": contentType }); res.end(Buffer.isBuffer(reply) ? reply : JSON.stringify(reply));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture failed.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); });
const provider = () => createDodoProvider({ apiKey, webhookSecret: "whsec_Zml4dHVyZQ==", mode: "test", baseUrl });
const input = { checkoutId: "chk_1", accountId: "a1", email: "owner@example.com", customerId: null, cart: [{ productId: "solo", quantity: 1, addons: [{ addonId: "desktop", quantity: 1 }] }], returnUrl: "https://dashboard.test/billing" };

describe("dodo HTTP provider fixture", () => {
  it("puts a one-use retention discount on a live subscription's next renewals without billing now", async () => {
    reply = { code: "KEEP1234", discount_id: "dsc_1" };
    expect(await provider().applyDiscount({ subscriptionId: "sub/1", productId: "desk", addons: [{ addonId: "cpu", quantity: 2 }], percent: 30, cycles: 3, accountId: "a1" })).toEqual({ code: "KEEP1234" });
    expect(requests[0]).toMatchObject({ method: "POST", url: "/discounts", body: { type: "percentage", amount: 3000, subscription_cycles: 3, usage_limit: 1, per_customer_usage_limit: 1, preserve_on_plan_change: true, metadata: { accountId: "a1", kind: "retention" } } });
    expect(requests[1]).toEqual({ method: "POST", url: "/subscriptions/sub%2F1/change-plan", auth: `Bearer ${apiKey}`, body: { product_id: "desk", quantity: 1, proration_billing_mode: "do_not_bill", effective_at: "next_billing_date", addons: [{ addon_id: "cpu", quantity: 2 }], discount_codes: ["KEEP1234"] } });
    reply = { discount_id: "dsc_2" };
    await expect(provider().applyDiscount({ subscriptionId: "sub", productId: "desk", addons: [], percent: 30, cycles: 3, accountId: "a1" })).rejects.toMatchObject({ code: "refused" });
    expect(requests).toHaveLength(3);
  });
  it("sends checkout auth, metadata and line items", async () => {
    reply = { session_id: "session", checkout_url: "https://test.checkout.dodopayments.com/session/session" };
    expect(await provider().createCheckout(input)).toEqual({ sessionId: "session", url: (reply as { checkout_url: string }).checkout_url });
    expect(requests[0]).toEqual({ method: "POST", url: "/checkouts", auth: `Bearer ${apiKey}`, body: { product_cart: [{ product_id: "solo", quantity: 1, addons: [{ addon_id: "desktop", quantity: 1 }] }], customer: { email: "owner@example.com", name: "Owner" }, return_url: input.returnUrl, metadata: { checkoutId: "chk_1", accountId: "a1" } } });
    await provider().createCheckout({ ...input, customerId: "cus_1" });
    expect(requests[1].body).toMatchObject({ customer: { customer_id: "cus_1" } });
    await provider().createCheckout({ ...input, trialDays: 3 });
    expect(requests[2].body).toMatchObject({ subscription_data: { trial_period_days: 3 } });
  });
  it("fills the checkout's name from the email, and a refused name never stops the checkout", async () => {
    expect(checkoutName(null, "jane.doe+promo@example.com")).toBe("Jane Doe");
    expect(checkoutName("  Marwan  E. ", "x@example.com")).toBe("Marwan E.");
    expect(checkoutName(null, "meena_siddarth72@gmail.com")).toBe("Meena Siddarth");
    expect(checkoutName(null, "12345@example.com")).toBeNull();
    expect(checkoutName(null, "a.b@example.com")).toBeNull();
    reply = { session_id: "s1", checkout_url: "https://test.checkout.dodopayments.com/session/s1" };
    await provider().createCheckout({ ...input, email: "jane.doe@example.com" });
    expect(requests[0].body).toMatchObject({ customer: { email: "jane.doe@example.com", name: "Jane Doe" } });
    // dodo says no to the name: the same checkout goes again without it and opens
    let calls = 0;
    server.removeAllListeners("request");
    server.on("request", async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); calls++;
      requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      const named = Boolean(body.customer?.name);
      res.writeHead(named ? 422 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(named ? { code: "INVALID_REQUEST" } : { session_id: "s2", checkout_url: "https://test.checkout.dodopayments.com/session/s2" }));
    });
    expect(await provider().createCheckout({ ...input, email: "jane.doe@example.com" })).toEqual({ sessionId: "s2", url: "https://test.checkout.dodopayments.com/session/s2" });
    expect(calls).toBe(2);
    expect(requests.at(-1)!.body).toMatchObject({ customer: { email: "jane.doe@example.com" } });
    expect((requests.at(-1)!.body as { customer: Record<string, unknown> }).customer).not.toHaveProperty("name");
  });
  it("opens card-only payment method pages, cancels, changes plans and streams private invoices", async () => {
    const p = provider(); reply = { payment_id: "pay_1", client_secret: "secret", expires_on: "2026-11-14T00:00:00Z", payment_link: "https://test.checkout.dodopayments.com/abc" };
    expect(await p.updatePaymentMethod("sub/1", input.returnUrl)).toEqual({ url: "https://test.checkout.dodopayments.com/abc" });
    expect(requests[0]).toEqual({ method: "POST", url: "/subscriptions/sub%2F1/update-payment-method", auth: `Bearer ${apiKey}`, body: { type: "new", return_url: input.returnUrl } });
    expect(p).not.toHaveProperty("portal");
    reply = {}; await p.cancelAtPeriodEnd("sub/1", true);
    expect(await p.changePlan({ subscriptionId: "sub/1", productId: "new", addons: [{ addonId: "cpu", quantity: 8 }], mode: "keep_cycle" })).toEqual({ paymentUrl: null });
    expect(requests[1]).toMatchObject({ method: "PATCH", url: "/subscriptions/sub%2F1", body: { cancel_at_next_billing_date: true } });
    expect(requests[2]).toEqual(expect.objectContaining({ method: "POST", url: "/subscriptions/sub%2F1/change-plan", body: { product_id: "new", quantity: 1, proration_billing_mode: "prorated_immediately_keep_cycle", on_payment_failure: "prevent_change",
      cancel_scheduled_change_plan: true, addons: [{ addon_id: "cpu", quantity: 8 }] } }));
    expect(await p.invoiceUrl("pay")).toBeNull(); contentType = "application/pdf"; reply = Buffer.from("%PDF-fixture");
    expect(await p.invoicePdf("pay/1")).toEqual({ contentType, body: reply }); expect(requests[3].url).toBe("/invoices/payments/pay%2F1");
  });
  it("sends each change mode as dodo's own, prices it from dodo's preview and reads the plan back", async () => {
    const p = provider(), base = { subscriptionId: "sub_1", productId: "pro", addons: [] };
    contentType = "application/json";
    reply = { immediate_charge: { summary: { total_amount: 2655, tax: 405, currency: "USD" } } };
    expect(await p.previewChange({ ...base, mode: "keep_cycle" })).toEqual({ chargeCents: 2655, taxCents: 405 });
    expect(requests.at(-1)).toMatchObject({ url: "/subscriptions/sub_1/change-plan/preview", body: { proration_billing_mode: "prorated_immediately_keep_cycle" } });
    expect(await p.previewChange({ ...base, mode: "scheduled" })).toEqual({ chargeCents: 0, taxCents: 0 });
    expect(requests.at(-1)!.body).toMatchObject({ proration_billing_mode: "full_immediately", effective_at: "next_billing_date" });
    await p.previewChange({ ...base, mode: "trial" }); expect(requests.at(-1)!.body).toMatchObject({ proration_billing_mode: "do_not_bill" }); expect(requests.at(-1)!.body).not.toHaveProperty("effective_at");
    await p.previewChange({ ...base, mode: "new_cycle" }); expect(requests.at(-1)!.body).toMatchObject({ proration_billing_mode: "prorated_immediately" });
    reply = { immediate_charge: { summary: { total_amount: 100, tax: 0, currency: "EUR" } } };
    await expect(p.previewChange({ ...base, mode: "keep_cycle" })).rejects.toMatchObject({ code: "refused" });
    reply = { payment_link: "https://test.checkout.dodopayments.com/pay_x" };
    expect(await p.changePlan({ ...base, mode: "keep_cycle" })).toEqual({ paymentUrl: "https://test.checkout.dodopayments.com/pay_x" });
    reply = { payment_link: "https://evil.test/pay" }; await expect(p.changePlan({ ...base, mode: "keep_cycle" })).rejects.toMatchObject({ code: "refused" });
    reply = {}; await p.cancelScheduledChange("sub_1"); expect(requests.at(-1)).toMatchObject({ method: "DELETE", url: "/subscriptions/sub_1/change-plan/scheduled" });
    reply = { product_id: "pro", addons: [{ addon_id: "seat", quantity: 2 }], next_billing_date: "2026-12-17T04:37:20Z", status: "active", scheduled_change: { product_id: "plus", addons: [] } };
    expect(await p.subscription("sub_1")).toEqual({ productId: "pro", addons: [{ addonId: "seat", quantity: 2 }], nextBillingAt: Date.parse("2026-12-17T04:37:20Z"), status: "active", scheduled: { productId: "plus", addons: [] } });
    status = 404; expect(await p.invoicePdf("missing")).toBeNull();
  });
  it("refuses a payment method link that is not the mode's checkout page, such as the customer portal", async () => {
    for (const payment_link of ["https://test.customer.dodopayments.com/session/1", "https://checkout.dodopayments.com/a", "http://test.checkout.dodopayments.com/a", "https://test.checkout.dodopayments.com.evil.test/a"]) {
      reply = { payment_link }; await expect(provider().updatePaymentMethod("sub", input.returnUrl)).rejects.toMatchObject({ code: "refused" });
    }
  });
  it("a create-checkout that dodo drops once (5xx) is asked again quietly; a refusal or a second drop is not", async () => {
    let calls = 0, failFirst = 1;
    server.removeAllListeners("request");
    server.on("request", async (req, res) => {
      for await (const _ of req) { /* drain */ }
      calls++;
      const down = calls <= failFirst;
      res.writeHead(down ? 502 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(down ? {} : { session_id: "s3", checkout_url: "https://test.checkout.dodopayments.com/session/s3" }));
    });
    expect(await provider().createCheckout(input)).toEqual({ sessionId: "s3", url: "https://test.checkout.dodopayments.com/session/s3" });
    expect(calls).toBe(2);
    calls = 0; failFirst = 2;
    await expect(provider().createCheckout(input)).rejects.toMatchObject({ code: "unavailable" });
    expect(calls, "only one retry").toBe(2);
  });
  it("refuses cross-mode, credential-bearing and unsafe checkout urls", async () => {
    for (const checkout_url of ["http://test.checkout.dodopayments.com/a", "https://checkout.dodopayments.com/a", "https://test.checkout.dodopayments.com.evil.test/a", "https://user@test.checkout.dodopayments.com/a", "https://test.checkout.dodopayments.com:444/a"]) {
      reply = { session_id: "s", checkout_url }; await expect(provider().createCheckout(input)).rejects.toMatchObject({ code: "refused" });
    }
  });
  it("bounds responses and never leaks credentials or response bodies", async () => {
    status = 500; reply = { error: `private ${apiKey}`, code: `private ${apiKey}` };
    await expect(provider().createCheckout(input)).rejects.toMatchObject({ code: "unavailable", message: "500" });
    status = 422; reply = { code: "SUBSCRIPTION_INACTIVE", message: `private ${apiKey}` };
    await expect(provider().cancelNow("sub")).rejects.toMatchObject({ code: "refused", message: "422 SUBSCRIPTION_INACTIVE" });
    status = 200; reply = { value: "x".repeat(256 * 1024) };
    await expect(provider().createCheckout(input)).rejects.toMatchObject({ code: "refused" });
    contentType = "application/pdf"; reply = Buffer.alloc(5 * 1024 * 1024 + 1);
    await expect(provider().invoicePdf("large")).rejects.toMatchObject({ code: "refused" });
  });
  it("a card page that fails on an on_hold plan hands back the open page dodo already made, else the error", async () => {
    const recent = new Date().toISOString();
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: null });
      const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.url!.endsWith("/update-payment-method")) return send(422, { code: "PREVIOUS_PAYMENT_PENDING" });
      if (req.url!.startsWith("/payments?")) return send(200, { items: [{ payment_id: "pay_old", status: "cancelled", created_at: recent }, { payment_id: "pay_open", status: "requires_payment_method", created_at: recent }] });
      if (req.url === "/payments/pay_open") return send(200, { payment_id: "pay_open", payment_link: "https://test.checkout.dodopayments.com/open" });
      send(404, {});
    });
    expect(await provider().updatePaymentMethod("sub_1", "https://dashboard.test/billing")).toEqual({ url: "https://test.checkout.dodopayments.com/open" });
    expect(requests.map(row => row.url)).toEqual(["/subscriptions/sub_1/update-payment-method", "/payments?subscription_id=sub_1&page_size=10", "/payments/pay_open"]);
    server.removeAllListeners("request");
    server.on("request", (req, res) => { res.writeHead(req.url!.startsWith("/payments?") ? 200 : 422, { "content-type": "application/json" }); res.end(JSON.stringify(req.url!.startsWith("/payments?") ? { items: [] } : { code: "SUBSCRIPTION_INACTIVE" })); });
    await expect(provider().updatePaymentMethod("sub_1", "https://dashboard.test/billing")).rejects.toMatchObject({ code: "refused", message: "422 SUBSCRIPTION_INACTIVE" });
  });
  it("retries a failed renewal only when dodo can and isn't already retrying it", async () => {
    reply = { can_retry: true, reason: null, next_automatic_retry_at: null };
    expect(await provider().retryPayment!("pay_1")).toBe("sent");
    expect(requests.map(row => `${row.method} ${row.url}`)).toEqual(["GET /payments/pay_1/retry", "POST /payments/pay_1/retry"]);
    reply = { can_retry: false, reason: null, next_automatic_retry_at: "2026-11-23T00:00:00Z" }; expect(await provider().retryPayment!("pay_1")).toBe("automatic");
    reply = { can_retry: false, reason: "PREVIOUS_PAYMENT_PENDING", next_automatic_retry_at: null }; expect(await provider().retryPayment!("pay_1")).toBe("later");
    reply = { can_retry: false, reason: "MANUAL_RETRY_LIMIT_REACHED", retry_available_at: "2026-11-23T00:00:00Z" }; expect(await provider().retryPayment!("pay_1")).toBe("later");
    reply = { can_retry: false, reason: "MANUAL_RETRY_LIMIT_REACHED", retry_available_at: null }; expect(await provider().retryPayment!("pay_1")).toBe("refused");
    reply = { can_retry: false, reason: "MANUAL_RETRY_HARD_DECLINE" }; expect(await provider().retryPayment!("pay_1")).toBe("refused");
    expect(requests.filter(row => row.method === "POST")).toHaveLength(1);
  });
  it("reads one page of past records for the backfill and refuses a reply without items", async () => {
    reply = { items: [{ payment_id: "pay_1" }, "junk", null, { payment_id: "pay_2" }] };
    expect(await provider().list!("payments", 3)).toEqual([{ payment_id: "pay_1" }, { payment_id: "pay_2" }]);
    expect(requests[0]).toMatchObject({ method: "GET", url: "/payments?page_size=50&page_number=3", auth: `Bearer ${apiKey}` });
    reply = { data: [] };
    await expect(provider().list!("disputes", 0)).rejects.toMatchObject({ code: "refused" });
  });
});
