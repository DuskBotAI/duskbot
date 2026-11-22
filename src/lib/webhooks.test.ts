import { describe, expect, it } from "vitest";

import { recentDeliveries, webhookActivationDefaults, webhookMaxPendingRunsInput } from "./webhooks.js";
import type { WebhookAttempt } from "../../shared/webhooks";

describe("webhookActivationDefaults", () => {
  it("makes a newly created local webhook executable on its first request", () => {
    expect(webhookActivationDefaults()).toEqual({ enabled: true, verificationPending: false });
  });

  it("preserves the activation state while editing an existing webhook", () => {
    expect(webhookActivationDefaults({ enabled: false, verificationPending: true })).toEqual({
      enabled: false,
      verificationPending: true,
    });
  });
});

describe("webhookMaxPendingRunsInput", () => {
  it("reads blank as the default and a whole number from 1 to 50 as the limit", () => {
    expect(webhookMaxPendingRunsInput("")).toBeNull();
    expect(webhookMaxPendingRunsInput("  ")).toBeNull();
    expect(webhookMaxPendingRunsInput("1")).toBe(1);
    expect(webhookMaxPendingRunsInput(" 12 ")).toBe(12);
    expect(webhookMaxPendingRunsInput("50")).toBe(50);
  });
  it("refuses anything the server would reject", () => {
    for (const text of ["0", "51", "2.5", "-3", "ten", "1e2"]) expect(webhookMaxPendingRunsInput(text)).toBeUndefined();
  });
});

describe("recentDeliveries", () => {
  const at = (id: string, receivedAt: number, extra: Partial<WebhookAttempt>): WebhookAttempt => ({ id, webhookId: "h", receivedAt, outcome: "accepted", statusCode: 202, ...extra });
  it("keeps this webhook's five newest, newest first, each said by its outcome and code alone", () => {
    const attempts = [
      at("1", 1, {}), at("2", 2, { outcome: "rejected", statusCode: 401, reason: "Invalid webhook URL or secret (3 requests)" }),
      at("3", 3, { outcome: "rejected", statusCode: 400, reason: "Could not read webhook body" }), at("4", 4, { outcome: "duplicate" }),
      at("5", 5, { outcome: "ignored" }), at("6", 6, { outcome: "rejected", statusCode: 500, reason: "internal detail", preview: "body" }),
      { ...at("x", 9, {}), webhookId: "other" },
    ];
    expect(recentDeliveries(attempts, "h")).toEqual([
      { id: "6", at: 6, ok: false, key: "automations.delivery.refused" },
      { id: "5", at: 5, ok: true, key: "automations.delivery.ignored" },
      { id: "4", at: 4, ok: true, key: "automations.delivery.duplicate" },
      { id: "3", at: 3, ok: false, key: "automations.delivery.unreadable" },
      { id: "2", at: 2, ok: false, key: "automations.delivery.secret", count: 3 },
    ]);
  });
});
