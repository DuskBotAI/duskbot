import type { LocaleKey } from "@/locales";
import type { WebhookAttempt, WebhookTrigger, WebhookTriggerInput } from "../../shared/webhooks";

export type {
  WebhookTrigger,
  WebhookTriggerInput,
  WebhookVerificationSample,
  WebhookAttemptOutcome,
  WebhookAttempt,
  WebhookIngressStatus,
} from "../../shared/webhooks";

export interface WebhookCredential {
  endpointUrl: string;
  secret: string;
  url: string;
}

export function webhookActivationDefaults(
  webhook?: Pick<WebhookTrigger, "enabled" | "verificationPending">,
): Pick<WebhookTriggerInput, "enabled" | "verificationPending"> {
  return {
    enabled: webhook?.enabled ?? true,
    verificationPending: webhook?.verificationPending ?? false,
  };
}

/** Must match the server's DEFAULT_MAX_PENDING_RUNS. */
export const WEBHOOK_DEFAULT_MAX_PENDING_RUNS = 3;
export const WEBHOOK_MAX_PENDING_RUNS_LIMIT = 50;

export function webhookMaxPendingRunsInput(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= 1 && value <= WEBHOOK_MAX_PENDING_RUNS_LIMIT ? value : undefined;
}

export const RECENT_DELIVERIES = 5;

/** One delivery as the webhook's sheet lists it. Built from the outcome and status code alone: a rejected delivery's
 * payload preview and the server's own wording never reach the page, and the secret is never part of an attempt. */
export interface DeliveryLine {
  id: string;
  at: number;
  ok: boolean;
  key: LocaleKey;
  count?: number;
}

function deliveryKey(attempt: Pick<WebhookAttempt, "outcome" | "statusCode" | "reason">): LocaleKey {
  switch (attempt.outcome) {
    case "accepted": return "automations.delivery.accepted";
    case "captured": return "automations.delivery.captured";
    case "duplicate": return "automations.delivery.duplicate";
    case "ignored": return "automations.delivery.ignored";
    default:
      if (attempt.statusCode === 401) return "automations.delivery.secret";
      if (attempt.statusCode === 413) return "automations.delivery.tooLarge";
      if (attempt.statusCode === 400) return /JSON/.test(attempt.reason ?? "") ? "automations.delivery.badJson" : "automations.delivery.unreadable";
      return "automations.delivery.refused";
  }
}

/** The webhook's newest deliveries, accepted and refused, newest first. */
export function recentDeliveries(attempts: readonly WebhookAttempt[], webhookId: string, limit = RECENT_DELIVERIES): DeliveryLine[] {
  return attempts.filter((attempt) => attempt.webhookId === webhookId)
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, limit)
    .map((attempt) => {
      const count = attempt.outcome === "rejected" && attempt.statusCode === 401 ? Number(/\((\d+) requests\)$/.exec(attempt.reason ?? "")?.[1] ?? 1) : 1;
      return { id: attempt.id, at: attempt.receivedAt, ok: attempt.outcome !== "rejected", key: deliveryKey(attempt), ...(count > 1 ? { count } : {}) };
    });
}
