export type MoneyMode = "test" | "live";
export interface MoneyTotals { mrr: number; customers: number; gross: number; payments: number }
export interface MonthRow {
  start: number; label: string; startMrr: number; mrr: number; startCustomers: number; customers: number;
  new: number; expansion: number; reactivation: number; contraction: number; churned: number; netNew: number;
  newCustomers: number; reactivatedCustomers: number; churnedCustomers: number;
  customerChurn: number | null; grossRevenueChurn: number | null; netRevenueChurn: number | null; nrr: number | null; grr: number | null;
  arpu: number | null; ltv: number | null;
  gross: number; refunds: number; net: number; afterTax: number;
}
export interface CohortRow { start: number; label: string; size: number; base: number; logo: Array<number | null>; revenue: Array<number | null> }
export type Health = "good" | "watch" | "risk" | "gone";
export type CustomerStatus = "active" | "past_due" | "on_hold" | "cancelling" | "churned" | "comped";
export interface CustomerRow {
  accountId: string; email: string | null; plan: string; interval: "month" | "year" | null; status: CustomerStatus;
  /** their real name when the account has one; test or live money (absent from an older service) */
  name?: string | null; mode?: MoneyMode;
  mrr: number; ltv: number; payments: number; failed: number; refunds: number; firstPaidAt: number | null; renewsAt: number | null; churnedAt: number | null;
  /** their newest payment, before tax */
  lastPaidAt: number | null; lastPaidCents: number | null;
  source: string; channel: string; country: string | null; activeDays: number | null; health: Health;
}
export type FeedKind = "new" | "renewal" | "payment" | "failed" | "refund" | "dispute" | "dispute_closed" | "cancel_scheduled" | "kept" | "churned" | "upgrade" | "downgrade" | "recovered" | "abandoned";
export interface FeedItem { id: string; at: number; kind: FeedKind; accountId: string | null; email: string | null; amountCents: number | null; mrrDelta: number | null; plan: string | null; detail: string | null }
export interface RiskRow { accountId: string; email: string | null; plan: string; mrr: number; reason: "payment_failed" | "cancel_scheduled" | "low_usage"; renewsAt: number | null; activeDays: number | null }
export interface BreakdownRow { key: string; mrr: number; customers: number; revenue: number }
export interface Upcoming { accountId: string; email: string | null; plan: string; interval: "month" | "year" | null; amountCents: number; mrr: number; at: number; activeDays: number | null }
export interface RevenueFunnelStep { id: string; label: string; count: number; of?: number }

export interface Headline {
  mrr: number; arr: number; netNewMrr: number; customers: number; arpu: number | null; customerChurn: number | null;
  /** failed charges: left out of mrr and customers; absent from an older service */
  atRisk?: { mrr: number; customers: number };
  revenueChurn: number | null; netRevenueChurn: number | null; nrr: number | null; grr: number | null; ltv: number | null; ltvRealised: number | null;
  previous: { mrr: number; netNewMrr: number; customers: number; arpu: number | null; customerChurn: number | null; ltv: number | null };
}

/** money taken in the page's range: payments before tax less refunds, before processor fees; a value per day */
export interface Received { cents: number; refundsCents: number; payments: number; starts: number[]; series: number[] }

export interface SubscriptionReport {
  now: number; currency: string; headline: Headline; months: MonthRow[];
  /** absent from an older service */
  received?: Received;
  status: { active: number; trialing: number; pastDue: number; onHold: number; cancelScheduled: number; comped: number; churned: number };
  cohorts: { payment: CohortRow[]; signup: CohortRow[] };
  dunning: { failed: number; recovered: number; lost: number; open: number; rate: number | null; recoveredMrr: number; months: Array<{ start: number; failed: number; recovered: number }> };
  refunds: { count: number; cents: number; rate: number | null; count30: number; cents30: number; rate30: number | null; disputes: number; disputesOpen: number; disputeRate: number | null };
  cash: { gross: number; refunds: number; tax: number; afterTax: number; payments: number; settled: number };
  timeToPay: { median: number | null; buckets: Array<{ label: string; count: number }> };
  checkout: { started: number; paid: number; abandoned: number; open: number; conversion: number | null; detectedAbandoned: number; recovered: number;
    bySource: Array<{ source: string; started: number; paid: number; abandoned: number }> };
  breakdown: Record<"plan" | "interval" | "country" | "channel" | "source" | "cohort", BreakdownRow[]>;
  upcoming: Upcoming[]; risk: RiskRow[]; feed: FeedItem[]; customers: CustomerRow[];
  funnel: { days: number; steps: RevenueFunnelStep[] };
  sync: { available: boolean; last: { at: number; added: number; scanned: number } | null };
  /** the dashboard's cancel flow over the last 90 days; absent from an older service */
  /** which money these numbers count (live by default), the mode this server takes payments in, and both totals apart; absent from an older service */
  mode?: MoneyMode | "all"; serverMode?: MoneyMode; modes?: Record<MoneyMode, MoneyTotals>;
  cancelFlow?: { started: number; saved: number; cancelled: number; discounts: number; reasons: Array<{ reason: string; started: number; saved: number; cancelled: number }> };
}
export interface PersonBilling {
  customer: CustomerRow | null;
  invoices: Array<{ id: string; at: number; amountCents: number; currency: string; status: "paid" | "failed" | "refunded"; description: string | null }>;
  events: Array<{ id: string; at: number; type: string; label: string; emoji: string; amountCents: number | null; mrrCents: number | null; previousMrrCents: number | null; plan: string | null; reason: string | null }>;
  cancelAtPeriodEnd: boolean; currentPeriodEnd: number | null;
}
export interface InfraCustomer {
  accountId: string; email: string | null; plan: string; status: string; mrr: number; feeCents: number;
  computeCents: number; diskCents: number; costCents: number; projectedCents: number; awakeHours: number; marginCents: number; margin: number | null;
  /** internet upload this month, and whether the egress guard slowed or paused one of its clouds */
  egressGb: number; egressState: "slowed" | "paused" | null;
}
export interface InfraReport {
  now: number; collected: boolean; month: string; days: number; elapsed: number;
  totals: { mrr: number; feeCents: number; computeCents: number; diskCents: number; costCents: number; projectedCents: number; marginCents: number; margin: number | null; unbilledCents: number; clouds: number };
  customers: InfraCustomer[]; worst: InfraCustomer[];
  awake: Array<{ label: string; clouds: number }>;
  assumptions: { dodo: { rate: number; fixedCents: number }; diskCentsPerGiBMonth: number; diskUpperBound: boolean };
}
