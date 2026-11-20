import { describe, expect, it } from "vitest";
import { failedReplyDetail, failedReplyKind } from "./failed-reply";
import type { InstanceInfo } from "@/state/store";
import { failedTurnTool } from "../../shared/failed-turn";
import { ERROR_KIND_OF, errorKind, type FailureKind } from "../../shared/failure-plan";
import { rawDetailIn } from "../../shared/raw-detail";

const claude = { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", snapshot: { state: "available", authenticated: true } } as InstanceInfo;

describe("a failed reply's line", () => {
  it("is one plain sentence per kind, whatever the engine said", () => {
    for (const kind of Object.keys(ERROR_KIND_OF) as FailureKind[]) {
      const line = failedReplyDetail(kind, "Claude", false);
      expect(line, kind).toMatch(/^(?:dusk bot|[A-Z])[^\n]{8,140}\.$/);
      expect(rawDetailIn(line), kind).toBeNull();
    }
  });

  it("says the same sentence for every reason of one kind", () => {
    expect(failedReplyDetail("rate_limit", "GLM", false)).toBe("GLM is busy right now. Try again in a moment.");
    expect(failedReplyDetail("provider_down", "GLM", false)).toBe(failedReplyDetail("overloaded", "GLM", false));
    expect(failedReplyDetail("cli_exit", "GitHub Copilot", false)).toBe("GitHub Copilot didn't reply. Try again.");
    expect(failedReplyDetail("timeout", "GitHub Copilot", false)).toBe(failedReplyDetail("no_answer", "GitHub Copilot", false));
    expect(failedReplyDetail("model_not_found", "DeepSeek", false)).toBe("DeepSeek couldn't answer with this model. Pick another model for this bot.");
    expect(failedReplyDetail("session_lost", "Claude", false)).toBe(failedReplyDetail("context", "Claude", false));
    expect(failedReplyDetail("other", "My server", true)).toBe("Your bot couldn't finish this reply. Try again.");
  });

  it("reads a row with no stored reason by its words, as the server reads it", () => {
    const kind = (cause: string) => errorKind(failedReplyKind(failedTurnTool(cause), claude, true));
    expect(kind("upstream HTTP 429: Too Many Requests")).toBe("busy");
    expect(kind("Request timed out after 120s")).toBe("no_reply");
    expect(kind("You've hit your usage limit")).toBe("usage_limit");
    expect(kind("Interrupted by another dusk bot restart after resuming once; not resumed again.")).toBe("interrupted");
    expect(kind("The model refused this request.")).toBe("other");
  });

  it("reads a refused sign-in on an AI that runs on a pasted key as a key to update", () => {
    const keyed = { ...claude, access: "api", snapshot: { state: "available", authenticated: false } } as InstanceInfo;
    expect(failedReplyKind(failedTurnTool("upstream HTTP 401: unauthorized", { reason: "signed_out", setup: true }), keyed, true)).toBe("key_rejected");
    expect(failedReplyDetail("key_rejected", "OpenRouter", false)).toBe("OpenRouter turned down its API key. Update the key to keep going.");
  });
});
