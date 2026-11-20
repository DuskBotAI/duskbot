import type { CheckoutSource, WakeStat } from "../../../../shared/billing-api";
export type { CheckoutSource } from "../../../../shared/billing-api";

// the account and billing shapes the dashboard reads. they follow CLOUD-PLAN.md until shared/account-api.ts and
// shared/billing-api.ts land; then these become re-exports of those files.

export type IdentityProvider = "google" | "apple" | "email";

export interface AccountProfile {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  /** the person's avatar choice (shared/user-avatar.ts), absent for the default */
  avatar?: string;
  createdAt: number;
  /** false until the first-run onboarding is finished or skipped */
  onboarded: boolean;
}

export interface Identity {
  provider: IdentityProvider;
  /** the address or handle it signs in as */
  label: string;
  linkedAt: number;
}

export interface AccountDevice {
  id: string;
  kind: "browser" | "desktop" | "phone";
  label: string;
  platform: string | null;
  location: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  current: boolean;
}

export type { NotificationPrefs } from "../../../../shared/account-api.ts";

/** which sign-in buttons work on this instance; a disabled one is not configured yet */
export interface AuthProviders { providers: Array<{ id: IdentityProvider; enabled: boolean; comingSoon?: boolean }> }

export interface EmailCodeStart { attempt: string; resendAfter: number; expiresIn: number; codeLength: number }

export type BillingInterval = "month" | "year";

export interface MachineSpec { vcpu: number; ramGb: number; diskGb: number }

/** personal is the free, non-commercial use; work needs starter or team */
export type LicenseId = "personal" | "starter" | "team";

export interface LicenseTier {
  id: LicenseId;
  name: string;
  /** usd per month on monthly billing */
  monthly: number;
  includedMembers: number;
  /** usd per month for each member past the included ones; 0 when it cannot grow */
  perExtraMember: number;
  maxMembers: number;
  work: boolean;
  blurb: string;
}

export type DesktopId = "none" | "shared-s" | "shared-m" | "dedicated";

export interface DesktopTier extends MachineSpec {
  id: Exclude<DesktopId, "none">;
  name: string;
  monthly: number;
  /** shared runs on our pool of big hosts in its own sandbox; dedicated is a whole machine */
  placement: "shared" | "dedicated";
  /** null is unlimited */
  botComputers: number | null;
  priority: boolean;
  blurb: string;
  /** dedicated machines can be sized with the custom pricing */
  sizable: boolean;
}

export type BundleId = "free" | "starter" | "pro" | "team";

export interface Bundle {
  id: BundleId;
  name: string;
  /** usd per month on monthly billing; may be less than its parts */
  monthly: number;
  license: LicenseId;
  members: number;
  desktop: DesktopId;
  blurb: string;
  features: string[];
  recommended?: boolean;
}

export interface Region { id: string; name: string; city: string }

export interface Range { min: number; max: number; step: number }

/** prices a dedicated machine sized with the sliders */
export interface CustomPricing {
  base: number;
  perVcpu: number;
  perGbRam: number;
  /** per 20 GB past includedDiskGb, so diskGb.step is 20 */
  per20GbDisk: number;
  includedDiskGb: number;
  vcpu: Range;
  ramGb: Range;
  diskGb: Range;
}

export interface PlanCatalog {
  /** false while paid plans cannot be bought yet */
  checkoutOpen?: boolean;
  bundles: Bundle[];
  licenses: LicenseTier[];
  desktops: DesktopTier[];
  custom: CustomPricing;
  wake?: Partial<Record<Exclude<DesktopId, "none">, WakeStat>>;
  regions: Region[];
  /** where shared desktops can be bought; absent means every region */
  poolRegions?: string[];
  /** 0.2 = yearly billing costs 20% less */
  yearlyDiscount: number;
  /** work use is free until then (an early grace period); null when it is over */
  workFreeUntil: number | null;
  /** a first plan starts with this many free days; absent when there is no trial for this account */
  trialDays?: number;
}

/** what the builder holds and checkout buys: one subscription with a line per part */
export interface Selection {
  license: LicenseId;
  members: number;
  desktop: DesktopId;
  /** a sized dedicated machine; null keeps the tier's own size */
  size: MachineSpec | null;
  region: string;
  interval: BillingInterval;
}

export interface Subscription {
  id: string;
  bundle: BundleId | null;
  selection: Selection;
  status: "pending" | "active" | "past_due" | "canceled";
  /** what each period charges, after the yearly discount */
  amountUsd: number;
  currentPeriodEnd: number;
  cancelAt: number | null;
  /** a free trial: the first charge is at currentPeriodEnd */
  trialEndsAt?: number;
  /** a smaller plan the owner chose, starting at `at` (the next billing date) */
  scheduled?: { bundle: BundleId | null; selection: Selection; amountUsd: number; at: number };
  /** past_due: its cloud is stopped and its data is deleted then, unless a payment goes through first */
  fixBy?: number;
  /** with fixBy: the trial's first charge failed */
  trialUnpaid?: true;
}

/** what switching to a plan does, before it is confirmed: `today` is charged now (tax included), the new price `next`
 * from `nextAt`. trial: nothing now, the trial keeps its end; now: the time left in the period; scheduled: nothing now,
 * the switch happens at `effectiveAt`; undo: a waiting switch is dropped */
export interface ChangeOffer { timing: "trial" | "now" | "scheduled" | "undo"; todayUsd: number; taxUsd: number; effectiveAt: number; nextUsd: number; nextAt: number | null }

export interface PaymentMethod { brand: string; last4: string; expMonth: number; expYear: number }

export interface Invoice {
  id: string;
  number: string;
  date: number;
  description: string;
  amountUsd: number;
  status: "paid" | "open" | "refunded";
  url: string | null;
}

/** the stay-on discount: `offer` while the account may still take it once, `applied` after */
export interface Retention { offer: { percent: number; cycles: number } | null; applied: { percent: number; cycles: number; at: number } | null }

export interface BillingOverview {
  /** the account's part in a live team plan, if any */
  team?: "owner" | "member" | null;
  subscription: Subscription | null;
  /** no live plan, and the newest one that ended: what Restart plan checks out again */
  ended?: { bundle: BundleId | null; selection: Selection; endedAt: number } | null;
  paymentMethod: PaymentMethod | null;
  invoices: Invoice[];
  retention?: Retention | null;
}

export type CloudStatus = "provisioning" | "running" | "waking" | "sleeping" | "stopped" | "error";

export interface CloudDesktop extends MachineSpec {
  id: string;
  name: string;
  status: CloudStatus;
  tier: Exclude<DesktopId, "none">;
  placement: "shared" | "dedicated";
  region: string;
  /** the workspace its reports arrive under, once it has linked */
  workspaceId: string | null;
  createdAt: number;
  /** while provisioning: 0..1 and what it is doing */
  progress: { step: string; value: number } | null;
  /** reserved by a checkout that has not been paid yet; it reads as provisioning but nothing is being set up */
  awaitingPayment?: boolean;
  error: string | null;
  botComputers: { used: number; limit: number | null };
  uptimeSec: number | null;
  /** when a new plan brought it back with its data after its previous plan ended */
  revivedAt?: number | null;
  /** a managed cloud: the owner can delete its data once the plan has ended */
  provider?: "managed";
  lastBackupAt?: number | null;
  /** an owner-confirmed deletion happens then, unless cancelled */
  deleteScheduledAt?: number | null;
  /** the owner asked to delete its data; the emailed link stays valid for an hour after */
  deleteAskedAt?: number | null;
  /** a managed cloud we stopped on our own to save cost (not its owner): shown as live, and any use wakes it */
  resting?: boolean;
  /** it uploaded so much this month that its connection is slowed, or it is paused, until `until` */
  egressLimit?: { state: "slowed" | "paused"; until: number } | null;
}

export type CheckoutRequest =
  { kind: "plan"; selection: Selection; bundle: BundleId | null; source: CheckoutSource };

/** the provider's hosted checkout; the dashboard opens it and waits for the webhook to land */
export interface CheckoutAnswer { url: string; id: string }

export interface SlackWake { available: boolean; enabled: boolean; state: "off" | "waiting" | "holding" | "waking"; bots: number; buffered: number }
