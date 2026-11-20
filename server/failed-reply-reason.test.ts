import { describe, expect, it } from "vitest";
import { failedReplyReason } from "./failed-reply-reason.ts";
import { serverLine } from "./server-lines.ts";

describe("failed reply reason", () => {
  it("reads the free backup's no-reply and free-limit lines as no AI connected", () => {
    expect(failedReplyReason(serverLine(undefined, "server.freeModel.noReply"), {})).toBe("no_ai");
    expect(failedReplyReason(serverLine(undefined, "server.freeModel.limit"), {})).toBe("no_ai");
    expect(failedReplyReason("API Error: 529 Overloaded", {})).toBe("overloaded");
  });

  it("names a missing model, a refused request, a long chat, an outage and an engine that quit", () => {
    expect(failedReplyReason("upstream HTTP 404: No endpoints found for deepseek/deepseek-r1:free.", {})).toBe("model_not_found");
    expect(failedReplyReason("upstream HTTP 400: Invalid 'messages[3].content' (invalid_request_error)", {})).toBe("bad_request");
    expect(failedReplyReason("upstream HTTP 400: This model's maximum context length is 131072 tokens.", {})).toBe("context");
    expect(failedReplyReason("upstream HTTP 500: Internal Server Error", {})).toBe("provider_down");
    expect(failedReplyReason("GitHub Copilot exited 1 before the prompt result", {})).toBe("cli_exit");
    expect(failedReplyReason("codex exited null (signal SIGKILL) before turn/completed", {})).toBe("cli_exit");
    expect(failedReplyReason("Codex ran out of room in the model's context window.", { errorCode: "contextWindowExceeded" })).toBe("context");
  });

  it("does not offer a sign-in for a cli that isn't installed", () => {
    expect(failedReplyReason("`copilot` isn't installed, or isn't on this app's PATH", { setup: true })).toBe("cli_missing");
    expect(failedReplyReason("OpenCode has no usable models. Add an OpenCode key in Settings → API keys.", { setup: true })).toBe("signed_out");
  });

  it("names a chat whose AI session is gone even after its rebuild, so the card offers a new chat", () => {
    expect(failedReplyReason("No conversation found with session ID: e8b9f01e-97e3-4be6-a55c-be988595628a", {})).toBe("session_lost");
  });

  it("leaves a failure it can't place to the app", () => {
    expect(failedReplyReason("something odd", {})).toBeUndefined();
  });
});
