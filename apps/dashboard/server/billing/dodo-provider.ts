import { BillingProviderError, SYNC_PAGE } from "./types.ts";
import type { BillingProvider } from "./types.ts";
import { verifyWebhook } from "./webhook-signature.ts";

export interface DodoProviderOptions {
  apiKey: string; webhookSecret: string; mode: "test" | "live"; fetch?: typeof fetch; now?: () => number;
  /** loopback http only, for isolated provider fixtures */
  baseUrl?: string;
}
export function createDodoProvider(options: DodoProviderOptions): BillingProvider {
  const base = options.baseUrl ?? `https://${options.mode}.dodopayments.com`;
  if (options.baseUrl) {
    const url = new URL(base);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new BillingProviderError("refused");
  }
  const requestFetch = options.fetch ?? fetch, now = options.now ?? Date.now;
  async function request(path: string, method: string, body?: unknown, pdf = false, timeoutMs = 15_000): Promise<{ contentType: string; body: Buffer } | null> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await requestFetch(`${base.replace(/\/$/, "")}${path}`, { method, redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", accept: pdf ? "application/pdf" : "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (pdf && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) throw new BillingProviderError(response.status >= 500 ? "unavailable" : "refused", `${response.status} ${await errorCode(response)}`.trim());
      const cap = pdf ? 5 * 1024 * 1024 : 256 * 1024;
      if (Number(response.headers.get("content-length")) > cap) { await response.body?.cancel(); throw new BillingProviderError("refused"); }
      const chunks: Uint8Array[] = []; let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            size += chunk.value.length;
            if (size > cap) { await reader.cancel(); throw new BillingProviderError("refused"); }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
      }
      const contentType = response.headers.get("content-type")?.split(";")[0].trim() ?? "application/octet-stream";
      if (pdf && contentType !== "application/pdf") throw new BillingProviderError("refused");
      return { contentType, body: Buffer.concat(chunks) };
    } catch (error) { if (error instanceof BillingProviderError) throw error; throw new BillingProviderError("unavailable", controller.signal.aborted ? "timeout" : "network"); }
    finally { clearTimeout(timer); }
  }
  async function getJson(path: string) {
    const result = await request(path, "GET");
    try {
      const data: unknown = JSON.parse(result!.body.toString("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
      return data as Record<string, unknown>;
    } catch { throw new BillingProviderError("refused"); }
  }
  async function json(path: string, body?: unknown, timeoutMs?: number) {
    const result = await request(path, "POST", body, false, timeoutMs);
    try {
      const data: unknown = JSON.parse(result!.body.toString("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
      return data as Record<string, unknown>;
    } catch { throw new BillingProviderError("refused"); }
  }
  function allowedUrl(value: unknown, host: string) {
    try {
      if (typeof value !== "string") throw new Error();
      const url = new URL(value);
      if (url.protocol !== "https:" || url.hostname !== host || url.port || url.username || url.password) throw new Error();
      return url.href;
    } catch { throw new BillingProviderError("refused"); }
  }
  /** the newest unpaid payment page of a subscription from the last hour, if dodo still has one open */
  async function openPaymentLink(subscriptionId: string, host: string): Promise<string | null> {
    const result = await request(`/payments?subscription_id=${encodeURIComponent(subscriptionId)}&page_size=10`, "GET");
    const data: unknown = JSON.parse(result!.body.toString("utf8"));
    const items = data && typeof data === "object" ? (data as { items?: unknown }).items : null;
    if (!Array.isArray(items)) return null;
    const recent = items.filter((item): item is Record<string, unknown> => !!item && typeof item === "object"
      && !["succeeded", "failed", "cancelled"].includes(String(item.status)) && Date.parse(String(item.created_at)) >= now() - 3_600_000)
      .sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)));
    for (const item of recent) {
      const full = await getJson(`/payments/${encodeURIComponent(String(item.payment_id))}`);
      if (typeof full.payment_link === "string") { try { return allowedUrl(full.payment_link, host); } catch {} }
    }
    return null;
  }
  const prefix = options.mode === "test" ? "test." : "";
  // dodo sends a scheduled change only with full_immediately; prevent_change keeps the old plan until a charge goes through
  const PRORATION = { trial: "do_not_bill", keep_cycle: "prorated_immediately_keep_cycle", new_cycle: "prorated_immediately", scheduled: "full_immediately" } as const;
  const changeBody = (input: Parameters<BillingProvider["changePlan"]>[0]) => ({ product_id: input.productId, quantity: 1, proration_billing_mode: PRORATION[input.mode],
    ...(input.mode === "scheduled" ? { effective_at: "next_billing_date" } : {}), on_payment_failure: "prevent_change", cancel_scheduled_change_plan: true,
    addons: input.addons.map(addon => ({ addon_id: addon.addonId, quantity: addon.quantity })) });
  return {
    name: "dodo",
    async createCheckout(input) {
      const name = input.customerId ? null : checkoutName(input.name, input.email);
      const body = (named: boolean) => ({ product_cart: input.cart.map(line => ({ product_id: line.productId, quantity: line.quantity,
        ...(line.addons.length ? { addons: line.addons.map(addon => ({ addon_id: addon.addonId, quantity: addon.quantity })) } : {}) })),
        customer: input.customerId ? { customer_id: input.customerId } : { email: input.email, ...(named && name ? { name } : {}) }, return_url: input.returnUrl, metadata: { checkoutId: input.checkoutId, accountId: input.accountId },
        ...(input.trialDays ? { subscription_data: { trial_period_days: input.trialDays } } : {}) });
      // the name only saves typing: a checkout dodo refuses with it is asked once more without it
      const open = () => json("/checkouts", body(true)).catch((error: unknown) => {
        if (!name || !(error instanceof BillingProviderError) || error.code !== "refused") throw error;
        return json("/checkouts", body(false));
      });
      // dodo's create-checkout now and then fails with a 5xx or a dropped connection; one quiet retry opens the page
      const result = await open().catch((error: unknown) => {
        if (!(error instanceof BillingProviderError) || error.code !== "unavailable") throw error;
        return open();
      });
      if (typeof result.session_id !== "string" || !result.session_id) throw new BillingProviderError("refused");
      return { sessionId: result.session_id, url: allowedUrl(result.checkout_url, `${prefix}checkout.dodopayments.com`) };
    },
    // on an on_hold subscription dodo charges the dues while it answers, which can take longer than other calls; a call
    // that failed may still have made that payment, and dodo refuses a second one until it settles (2026-11)
    async updatePaymentMethod(subscriptionId, returnUrl) {
      const host = `${prefix}checkout.dodopayments.com`;
      try {
        const result = await json(`/subscriptions/${encodeURIComponent(subscriptionId)}/update-payment-method`, { type: "new", return_url: returnUrl }, 45_000);
        return { url: allowedUrl(result.payment_link, host) };
      } catch (error) {
        const open = await openPaymentLink(subscriptionId, host).catch(() => null);
        if (open) return { url: open };
        throw error;
      }
    },
    async retryPayment(paymentId) {
      const path = `/payments/${encodeURIComponent(paymentId)}/retry`, state = await getJson(path);
      if (typeof state.next_automatic_retry_at === "string") return "automatic";
      if (state.can_retry !== true) {
        const cooling = state.reason !== "MANUAL_RETRY_LIMIT_REACHED" || typeof state.retry_available_at === "string";
        return typeof state.reason === "string" && WAIT_REASONS.has(state.reason) && cooling ? "later" : "refused";
      }
      try { await request(path, "POST"); }
      catch (error) {
        if (error instanceof BillingProviderError && error.code === "refused" && [...WAIT_REASONS].some(reason => error.message.includes(reason))) return "later";
        throw error;
      }
      return "sent";
    },
    verifyWebhook: (headers, body) => verifyWebhook(options.webhookSecret, headers, body, now()),
    async cancelAtPeriodEnd(id, cancel) { await request(`/subscriptions/${encodeURIComponent(id)}`, "PATCH", { cancel_at_next_billing_date: cancel }); },
    async cancelNow(id) { await request(`/subscriptions/${encodeURIComponent(id)}`, "PATCH", { status: "cancelled" }); },
    async setNextBillingDate(id, at) { await request(`/subscriptions/${encodeURIComponent(id)}`, "PATCH", { next_billing_date: new Date(at).toISOString() }); },
    async refundPayment(paymentId, reason) { await request("/refunds", "POST", { payment_id: paymentId, reason }); },
    async previewChange(input) {
      const result = await json(`/subscriptions/${encodeURIComponent(input.subscriptionId)}/change-plan/preview`, changeBody(input));
      const summary = (result.immediate_charge as { summary?: Record<string, unknown> } | undefined)?.summary;
      const total = summary?.total_amount, tax = summary?.tax ?? 0;
      if (!summary || summary.currency !== "USD" || !Number.isSafeInteger(total) || (total as number) < 0 || (tax !== null && !Number.isSafeInteger(tax))) throw new BillingProviderError("refused");
      // a scheduled change's preview prices the coming renewal, not today
      return input.mode === "scheduled" || input.mode === "trial" ? { chargeCents: 0, taxCents: 0 } : { chargeCents: total as number, taxCents: (tax as number | null) ?? 0 };
    },
    async changePlan(input) {
      const result = await request(`/subscriptions/${encodeURIComponent(input.subscriptionId)}/change-plan`, "POST", changeBody(input));
      let link: unknown = null;
      try { link = (JSON.parse(result?.body.toString("utf8") || "{}") as { payment_link?: unknown }).payment_link ?? null; } catch {}
      return { paymentUrl: link === null ? null : allowedUrl(link, `${prefix}checkout.dodopayments.com`) };
    },
    async cancelScheduledChange(id) { await request(`/subscriptions/${encodeURIComponent(id)}/change-plan/scheduled`, "DELETE"); },
    async subscription(id) {
      const result = await request(`/subscriptions/${encodeURIComponent(id)}`, "GET");
      let data: Record<string, unknown>;
      try { data = JSON.parse(result!.body.toString("utf8")) as Record<string, unknown>; if (!data || typeof data !== "object") throw new Error(); } catch { throw new BillingProviderError("refused"); }
      const addons = (value: unknown) => Array.isArray(value) ? value.filter((item): item is { addon_id: string; quantity: number } => !!item && typeof item.addon_id === "string" && Number.isSafeInteger(item.quantity))
        .map(item => ({ addonId: item.addon_id, quantity: item.quantity })) : [];
      const at = typeof data.next_billing_date === "string" ? Date.parse(data.next_billing_date) : NaN;
      const scheduled = data.scheduled_change && typeof data.scheduled_change === "object" ? data.scheduled_change as Record<string, unknown> : null;
      return { productId: typeof data.product_id === "string" ? data.product_id : null, addons: addons(data.addons), nextBillingAt: Number.isFinite(at) ? at : null,
        status: typeof data.status === "string" ? data.status : null,
        scheduled: scheduled ? { productId: typeof scheduled.product_id === "string" ? scheduled.product_id : null, addons: addons(scheduled.addons) } : null };
    },
    // dodo (2026-11) has no discount field on PATCH /subscriptions; change-plan takes discount_codes, so the same
    // product and addons are sent again with the code, unbilled, from the next billing date
    async applyDiscount(input) {
      const discount = await json("/discounts", { type: "percentage", amount: input.percent * 100, subscription_cycles: input.cycles, usage_limit: 1, per_customer_usage_limit: 1,
        preserve_on_plan_change: true, name: "stay on dusk bot", metadata: { accountId: input.accountId, kind: "retention" } });
      if (typeof discount.code !== "string" || !discount.code) throw new BillingProviderError("refused");
      await request(`/subscriptions/${encodeURIComponent(input.subscriptionId)}/change-plan`, "POST", { product_id: input.productId, quantity: 1, proration_billing_mode: "do_not_bill",
        effective_at: "next_billing_date", addons: input.addons.map(addon => ({ addon_id: addon.addonId, quantity: addon.quantity })), discount_codes: [discount.code] });
      return { code: discount.code };
    },
    async invoiceUrl() { return null; },
    invoicePdf: id => request(`/invoices/payments/${encodeURIComponent(id)}`, "GET", undefined, true),
    async list(resource, page) {
      const result = await request(`/${resource}?page_size=${SYNC_PAGE}&page_number=${page}`, "GET");
      try {
        const data: unknown = JSON.parse(result!.body.toString("utf8"));
        const items = data && typeof data === "object" ? (data as { items?: unknown }).items : null;
        if (!Array.isArray(items)) throw new Error();
        return items.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
      } catch { throw new BillingProviderError("refused"); }
    },
  };
}

/** the name dodo's checkout shows filled in: the account's own, else a guess from the email ("jane.doe+x@" is "Jane Doe");
 *  nothing when neither reads as a name */
export function checkoutName(own: string | null | undefined, email: string): string | null {
  const clean = (value: string) => value.replace(/[\p{C}<>"]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60);
  const given = own ? clean(own) : "";
  if (/\p{L}/u.test(given)) return given;
  const local = (email.split("@")[0] ?? "").split("+")[0]!;
  const words = local.split(/[._\-\s]+/).map(word => word.replace(/[^\p{L}]/gu, "")).filter(word => word.length > 1);
  const guess = clean(words.map(word => word[0]!.toUpperCase() + word.slice(1).toLowerCase()).join(" "));
  return guess.length >= 2 ? guess : null;
}

/** dodo's manual retry refusals that clear on their own: a payment still in flight, an open card page, the cooldown */
const WAIT_REASONS = new Set(["MANUAL_RETRY_IN_FLIGHT", "PREVIOUS_PAYMENT_PENDING", "MANUAL_RETRY_LIMIT_REACHED"]);
/** the `code` of a refused call's JSON body, for the log; never the body itself */
async function errorCode(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 4096), code = (JSON.parse(text) as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z0-9_]{2,64}$/.test(code) ? code : "";
  } catch { return ""; }
}
