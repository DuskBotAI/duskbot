import type { StoredCheckout, StoredSubscription } from "../billing/store.ts";
import type { StoredWorkspace } from "../store.ts";

export const DAY = 86_400_000;
export const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
/** the UTC days from `days - 1` days ago through today, oldest first */
export function dayRange(now: number, days: number): string[] {
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  return Array.from({ length: days }, (_, i) => dayKey(today - (days - 1 - i) * DAY));
}
export function perDay(days: string[], rows: Iterable<{ day: string; count: number }>): number[] {
  const by = new Map<string, number>();
  for (const row of rows) by.set(row.day, (by.get(row.day) ?? 0) + row.count);
  return days.map(day => by.get(day) ?? 0);
}

/** a failed charge is not paying, though it is retried */
export const PAID_STATUSES = ["active", "cancelled"] as const;
export const isPaying = (sub: Pick<StoredSubscription, "status">) => (PAID_STATUSES as readonly string[]).includes(sub.status);
/** a subscription that was ever paid for (or granted): anything past pending, or ended after a period ran */
export const wasPaid = (sub: Pick<StoredSubscription, "status" | "currentPeriodStart">) => isPaying(sub) || sub.status === "payment_problem" || (sub.status === "ended" && sub.currentPeriodStart !== null);
export const choseCloud = (checkout: Pick<StoredCheckout, "kind" | "cart">) => checkout.kind === "cart" && !!checkout.cart && checkout.cart.desktop.kind !== "none";

export function workspaceTurns(ws: Pick<StoredWorkspace, "report">, sinceDay?: string): number {
  const activity = ws.report?.activity;
  if (!activity) return 0;
  if (!sinceDay) return Math.max(activity.totals.turns, activity.days.reduce((sum, day) => sum + day.turns, 0));
  return activity.days.filter(day => day.date >= sinceDay).reduce((sum, day) => sum + day.turns, 0);
}

export interface FunnelInput {
  since: number;
  siteVisitors: number;
  accounts: ReadonlyArray<{ id: string; createdAt: number }>;
  checkouts: ReadonlyArray<Pick<StoredCheckout, "accountId" | "kind" | "cart">>;
  subscriptions: ReadonlyArray<Pick<StoredSubscription, "accountId" | "status" | "currentPeriodStart">>;
  sessions: ReadonlyArray<{ accountId: string; kind: string }>;
  workspaces: ReadonlyArray<Pick<StoredWorkspace, "ownerAccountId" | "report">>;
  /** accounts with the matching events: onboarding_done, app_paired, first_bot_reply, plan_chosen */
  marked: { onboarded: Set<string>; paired: Set<string>; replied: Set<string>; chosen: Set<string> };
}
/** `count` follows the funnel (a subset of the step before); `total` counts every signup of the window that did it */
export interface FunnelStep { id: string; label: string; count: number; total: number }

/** site visitors, then the signups of the window and how far each got (each step is a subset of the one before) */
export function funnel(input: FunnelInput): FunnelStep[] {
  const cohort = new Set(input.accounts.filter(account => account.createdAt >= input.since).map(account => account.id));
  const within = (ids: Iterable<string | null>) => new Set([...ids].filter((id): id is string => id !== null && cohort.has(id)));
  const chose = within([...input.checkouts.filter(choseCloud).map(c => c.accountId), ...input.marked.chosen]);
  const paid = within(input.subscriptions.filter(wasPaid).map(s => s.accountId));
  const paired = within([...input.sessions.filter(s => s.kind !== "web").map(s => s.accountId), ...input.marked.paired]);
  const replied = within([...input.workspaces.filter(ws => workspaceTurns(ws) > 0).map(ws => ws.ownerAccountId), ...input.marked.replied]);
  const onboarded = within([...input.marked.onboarded, ...chose, ...paid, ...paired]);
  const and = (a: Set<string>, b: Set<string>) => new Set([...a].filter(id => b.has(id)));
  const steps: Array<[string, string, Set<string>]> = [["onboarded", "onboarded", onboarded]];
  steps.push(["cloud", "chose a cloud", and(chose, steps.at(-1)![2])]);
  steps.push(["paid", "paid", and(paid, steps.at(-1)![2])]);
  steps.push(["paired", "paired app", and(paired, steps.at(-1)![2])]);
  steps.push(["replied", "bot replied", and(replied, steps.at(-1)![2])]);
  const totals: Record<string, number> = { onboarded: onboarded.size, cloud: chose.size, paid: paid.size, paired: paired.size, replied: replied.size };
  return [{ id: "site", label: "site visitors", count: input.siteVisitors, total: input.siteVisitors }, { id: "signup", label: "signed up", count: cohort.size, total: cohort.size },
    ...steps.map(([id, label, set]) => ({ id, label, count: set.size, total: totals[id]! }))];
}
