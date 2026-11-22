import { join } from "node:path";
import { CANCEL_ANSWERS, RETENTION_OFFERS, RETENTION_OUTCOMES, RETENTION_STEPS } from "../../../../shared/billing-api.ts";
import type { CancelSurvey, Cart, CartLine, LicenseView, RetentionInput, SubscriptionStatus } from "../../../../shared/billing-api.ts";
import type { DesktopPlan, OrderInput } from "../clouds/types.ts";
import { createJsonStore } from "./json-store.ts";
import { validLedgerEntry } from "./ledger.ts";
import type { LedgerEntry } from "./ledger.ts";

export interface PendingChange { cart: Cart; totalCents: number; lines: CartLine[]; products: { productId: string; addons: Array<{ addonId: string; quantity: number }> }; cloudId: string | null;
  /** when it was sent to the provider; absent on older rows */
  at?: number;
  /** the provider started a new billing cycle with it (monthly to yearly) */
  newCycle?: boolean;
  /** its machine restarts into the new size as the change applies, not at its next idle sleep; absent on older rows */
  resizeNow?: boolean }
/** a confirmed change that starts at the next billing date (`at`) */
export type ScheduledChange = PendingChange & { at: number };
export type CloudAction =
  | { kind: "order"; cloudId: string; input: OrderInput }
  | { kind: "change"; cloudId: string; plan: DesktopPlan; now?: boolean }
  | { kind: "activate"; cloudId: string; subscriptionId: string; plan: DesktopPlan }
  /** a new subscription brings back an ended cloud with its data; a fresh cloud when it no longer can */
  | { kind: "revive"; cloudId: string; subscriptionId: string; plan: DesktopPlan }
  | { kind: "payment"; cloudId: string; problem: boolean }
  | { kind: "schedule"; cloudId: string; at: number }
  /** `from`: the desktop runs until then (the paid period's end), and `at` deletes it */
  | { kind: "end"; cloudId: string; at: number; from?: number }
  | { kind: "keep"; cloudId: string };
export interface StoredCheckout {
  /** "credits": a retired pack purchase, still readable in older stores; nothing makes one any more */
  id: string; accountId: string; email: string; kind: "cart" | "credits"; cart: Cart | null; cloudId: string | null;
  providerSubscriptionId?: string;
  /** paying it brings back `cloudId`, an ended cloud of this account, instead of a new one */
  revive?: boolean;
  providerSessionId: string | null; url: string | null; status: "open" | "completed" | "expired"; source: string | null;
  /** the free trial this checkout's page offered */
  trialDays?: number;
  createdAt: number; openUntil: number; subscriptionId: string | null; amountCents: number; lines: CartLine[];
}
export const DUNNING_STEPS = ["first", "day_14", "final"] as const;
export type DunningStep = (typeof DUNNING_STEPS)[number];
/** `trial`: the charge that failed was a trial's first, so its cloud's data goes `fixBy`, 7 days after the trial's end */
export interface PaymentProblem { since: number; fixBy: number; sent: DunningStep[]; trial?: true;
  /** how many of PAYMENT_RETRY_DAYS are done (sent, or given up because the provider never can or retries by itself) */
  retries?: number;
  /** when the last retry was sent */
  retriedAt?: number }
export interface StoredSubscription {
  id: string; accountId: string; providerSubscriptionId: string | null; checkoutId: string; cart: Cart; totalCents: number; lines: CartLine[];
  status: SubscriptionStatus; licenseId: string | null; cloudId: string | null; currentPeriodStart: number | null; currentPeriodEnd: number | null;
  pendingChange?: PendingChange;
  scheduledChange?: ScheduledChange;
  /** where its checkout started (CHECKOUT_SOURCES), copied from the checkout */
  source?: string | null;
  lastEventAt?: number;
  /** the end of its free trial, the first charge; set when a trial checkout became this subscription */
  trialEndsAt?: number;
  /** App Review's demo plan (POST /v1/billing/ops/review): never counted as revenue */
  review?: true;
  /** a charge failed: its cloud stops at once; since the first failure, the date its data is deleted unless a payment goes
   *  through first (the plan ends then), and the emails sent; dropped when a payment goes through, kept once the plan
   *  ended so retention counts from the failure */
  paymentProblem?: PaymentProblem;
  /** the payment provider's mode when it was made (dodo test or live; the fake provider is test); absent on older rows */
  mode?: BillingMode;
  cancelAtPeriodEnd: boolean; createdAt: number; updatedAt: number; version: number;
}
export interface StoredInvoice {
  id: string; accountId: string; providerPaymentId: string; subscriptionId: string | null; checkoutId: string | null;
  /** what the buyer was charged, tax included (prices are tax exclusive, so tax comes on top) */
  amountCents: number;
  /** the tax inside `amountCents`, as the provider reported it; absent on invoices from before it was kept */
  taxCents?: number;
  currency: string; status: "paid" | "failed" | "refunded"; description: string; createdAt: number;
  /** as on StoredSubscription */
  mode?: BillingMode;
}
export type BillingMode = "test" | "live";
/** where a paying customer first came from, copied from analytics at their first payment so it outlives the raw events */
export interface Attribution { source: string; channel: string; campaign: string | null; referrer: string | null; country: string | null; firstSeen: number | null }
export interface AccountClosure {
  id: string; accountId: string; anonId: string; startedAt: number; completedAt: number | null; destroyDesktopsNow: boolean; steps: string[];
}
/** an emailed team invite: single use, expiring, only the sha256 of its token is kept */
export interface TeamInvite {
  id: string; licenseId: string; email: string; tokenHash: string; invitedBy: string; createdAt: number; expiresAt: number;
  status: "pending" | "accepted" | "cancelled"; closedAt: number | null;
  /** the person opened it while every paid seat was taken; the owner was told once */
  refusedAt: number | null;
}
/** a member who left a team cloud: the cloud is told (POST /api/cloud/team/member-left) until it confirms */
export interface TeamLeave { id: string; cloudId: string; email: string; at: number; doneAt: number | null; tries: number; nextAt: number }
export interface BillingState {
  teamInvites?: TeamInvite[];
  teamLeaves?: TeamLeave[];
  closures?: AccountClosure[];
  providerCancels?: Array<{ id: string; completedAt: number | null }>;
  /** a second subscription for a plan the account already has (a stale checkout page paid late, say): ended at the
   *  provider at once and every payment on it refunded */
  duplicates?: Array<{ id: string; accountId: string; checkoutId: string; cancelledAt: number | null; payments: Array<{ id: string; refundedAt: number | null }> }>;
  cloudActions?: CloudAction[];
  refunds?: Array<{ id: string; paymentId: string; amountCents: number; currency: string }>;
  customers: Array<{ accountId: string; email: string; providerCustomerId: string | null; attribution?: Attribution }>;
  ledger?: LedgerEntry[];
  /** when the owner's backfill last finished, and what it added */
  lastSync?: { at: number; added: number; scanned: number } | null;
  checkouts: StoredCheckout[]; subscriptions: StoredSubscription[]; licenses: LicenseView[]; invoices: StoredInvoice[];
  webhookEvents: Array<{ id: string; at: number; type: string }>;
  feedback: Array<CancelSurvey & { id: string; accountId: string; cloudId: string | null; subscriptionId: string | null; at: number }>;
  /** each step of the dashboard's cancel flow, for the owner's cancel reasons and saves */
  retention?: Array<RetentionInput & { id: string; accountId: string; subscriptionId: string; at: number }>;
  /** the stay-on discount, at most one per account */
  retentionDiscounts?: Array<{ id: string; accountId: string; subscriptionId: string; code: string; percent: number; cycles: number; at: number }>;
}

type Check = (value: unknown) => boolean;
const str: Check = value => typeof value === "string";
const int: Check = value => Number.isSafeInteger(value);
const bool: Check = value => typeof value === "boolean";
const nullable = (check: Check): Check => value => value === null || check(value);
const one = (...values: unknown[]): Check => value => values.includes(value);
const array = (check: Check): Check => value => Array.isArray(value) && value.every(check);
const shape = (fields: Record<string, Check>): Check => value => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.entries(fields).every(([key, check]) => check((value as Record<string, unknown>)[key]));
const optional = (check: Check): Check => value => value === undefined || check(value);
const cart: Check = shape({ interval: one("month", "year"), license: shape({ kind: one("none", "solo", "team"), members: optional(int) }),
  desktop: shape({ kind: one("none", "shared_s", "shared_m", "dedicated"), region: optional(str), spec: optional(shape({ vcpu: int, ramGb: int, diskGb: int })) }) });
const line = shape({ kind: one("license", "members", "desktop", "discount"), label: str, amountCents: int });
const plan = shape({ kind: one("shared_s", "shared_m", "dedicated"), placement: one("pool", "dedicated"), spec: shape({ vcpu: int, ramGb: int, diskGb: int }), botComputers: nullable(int) });
const change = shape({ cart, totalCents: int, lines: array(line), products: shape({ productId: str, addons: array(shape({ addonId: str, quantity: int })) }), cloudId: nullable(str), at: optional(int), newCycle: optional(bool), resizeNow: optional(bool) });
const valid = shape({
  teamInvites: optional(array(shape({ id: str, licenseId: str, email: str, tokenHash: str, invitedBy: str, createdAt: int, expiresAt: int, status: one("pending", "accepted", "cancelled"), closedAt: nullable(int), refusedAt: nullable(int) }))),
  teamLeaves: optional(array(shape({ id: str, cloudId: str, email: str, at: int, doneAt: nullable(int), tries: int, nextAt: int }))),
  closures: optional(array(shape({ id: str, accountId: str, anonId: str, startedAt: int, completedAt: nullable(int), destroyDesktopsNow: bool, steps: array(str) }))),
  providerCancels: optional(array(shape({ id: str, completedAt: nullable(int) }))),
  duplicates: optional(array(shape({ id: str, accountId: str, checkoutId: str, cancelledAt: nullable(int), payments: array(shape({ id: str, refundedAt: nullable(int) })) }))),
  cloudActions: optional(array(value => {
    if (!value || typeof value !== "object") return false;
    const action = value as CloudAction;
    return str(action.cloudId) && (action.kind === "order" && shape({ accountId: str, name: str, region: str })(action.input) && plan(action.input)
      || action.kind === "change" && plan(action.plan) || action.kind === "keep" || action.kind === "payment" && bool(action.problem)
      || (action.kind === "schedule" || action.kind === "end") && int(action.at)
      || (action.kind === "activate" || action.kind === "revive") && str(action.subscriptionId) && plan(action.plan));
  })),
  refunds: optional(array(shape({ id: str, paymentId: str, amountCents: int, currency: str }))),
  customers: array(shape({ accountId: str, email: str, providerCustomerId: nullable(str), attribution: optional(shape({ source: str, channel: str, campaign: nullable(str), referrer: nullable(str), country: nullable(str), firstSeen: nullable(int) })) })),
  ledger: optional(array(validLedgerEntry)),
  lastSync: optional(nullable(shape({ at: int, added: int, scanned: int }))),
  checkouts: array(shape({ id: str, accountId: str, email: str, kind: one("cart", "credits"), cart: nullable(cart), cloudId: nullable(str), providerSubscriptionId: optional(str), revive: optional(bool), providerSessionId: nullable(str), url: nullable(str), status: one("open", "completed", "expired"), source: nullable(str), createdAt: int, openUntil: int, subscriptionId: nullable(str), amountCents: int, lines: array(line) })),
  subscriptions: array(shape({ id: str, accountId: str, providerSubscriptionId: nullable(str), checkoutId: str, cart, totalCents: int, lines: array(line), status: one("pending", "active", "payment_problem", "cancelled", "ended"), mode: optional(one("test", "live")), lastEventAt: optional(int), paymentProblem: optional(shape({ since: int, fixBy: int, sent: array(one(...DUNNING_STEPS)), trial: optional(one(true)), retries: optional(int), retriedAt: optional(int) })), source: optional(nullable(str)), pendingChange: optional(change), scheduledChange: optional(value => change(value) && int((value as { at: unknown }).at)), licenseId: nullable(str), cloudId: nullable(str), currentPeriodStart: nullable(int), currentPeriodEnd: nullable(int), cancelAtPeriodEnd: bool, createdAt: int, updatedAt: int, version: int })),
  licenses: array(shape({ id: str, ownerAccountId: str, kind: one("solo", "team"), seats: int, members: array(shape({ email: str, accountId: nullable(str), role: one("owner", "member"), addedAt: int })), priority: bool, subscriptionId: nullable(str), status: one("active", "grace", "expired"), validUntil: nullable(int) })),
  invoices: array(shape({ id: str, accountId: str, providerPaymentId: str, subscriptionId: nullable(str), checkoutId: nullable(str), amountCents: int, taxCents: optional(int), currency: str, status: one("paid", "failed", "refunded"), mode: optional(one("test", "live")), description: str, createdAt: int })),
  webhookEvents: array(shape({ id: str, at: int, type: str })),
  retention: optional(array(shape({ id: str, accountId: str, subscriptionId: str, reason: one(...CANCEL_ANSWERS), step: one(...RETENTION_STEPS), outcome: one(...RETENTION_OUTCOMES), at: int }))),
  retentionDiscounts: optional(array(shape({ id: str, accountId: str, subscriptionId: str, code: str, percent: int, cycles: int, at: int }))),
  feedback: array(shape({ id: str, accountId: str, cloudId: nullable(str), subscriptionId: nullable(str), answer: one(...CANCEL_ANSWERS), expected: optional(str), improve: optional(str), offer: optional(one(...RETENTION_OFFERS)), outcome: optional(one(...RETENTION_OUTCOMES)), at: int })),
});
function validState(value: unknown): value is BillingState {
  if (!valid(value)) return false;
  const state = value as BillingState;
  const unique = (values: string[]) => new Set(values).size === values.length;
  return Object.entries(state).filter(([key]) => key !== "cloudActions" && key !== "lastSync").every(([key, rows]) => unique(rows.map((row: { id?: string; accountId?: string }) => key === "customers" ? row.accountId! : row.id!)))
    && unique(state.invoices.map(row => row.providerPaymentId))
    && unique(state.subscriptions.flatMap(row => row.providerSubscriptionId ? [row.providerSubscriptionId] : []));
}
export function createBillingStore(dataDir: string) {
  return createJsonStore<BillingState>(join(dataDir, "billing.json"), () => ({ teamInvites: [], teamLeaves: [], closures: [], providerCancels: [], customers: [], checkouts: [], subscriptions: [], licenses: [], invoices: [], webhookEvents: [], feedback: [] }), validState);
}
export type BillingStore = ReturnType<typeof createBillingStore>;
