import { describe, expect, it } from "vitest";

import { DECLINED_BEFORE, outboundSendKey, type SendRow } from "../../shared/declined-sends.ts";
import { declinedInternalSend, internalSend } from "./declined-sends.ts";

describe("built-in send routes", () => {
  it("reads the tool and arguments each built-in send route runs", () => {
    expect(internalSend("/api/internal/email/mcp", { method: "tools/call", params: { name: "EMAIL_SEND_MESSAGE", arguments: { to: "a@b.c" } } })).toEqual({ tool: "EMAIL_SEND_MESSAGE", args: { to: "a@b.c" } });
    expect(internalSend("/api/internal/device/mcp", { method: "tools/call", params: { name: "PHONE_SEND_WHATSAPP", arguments: { to: "Ramesh" } } })).toEqual({ tool: "PHONE_SEND_WHATSAPP", args: { to: "Ramesh" } });
    expect(internalSend("/api/internal/email/mcp", { method: "tools/list" })).toBeNull();
    expect(internalSend("/api/internal/slack/slack_post", { channel: "C1", text: "hi" })).toEqual({ tool: "slack_post", args: { channel: "C1", text: "hi" } });
    expect(internalSend("/api/internal/people/message", { message: "deck ready" })).toEqual({ tool: "message_person", args: { message: "deck ready" } });
    expect(internalSend("/api/internal/jobs", { action: "start" })).toBeNull();
  });

  it("refuses each route's repeat of a send declined on an approval card, with the engine's own tool name and input", () => {
    const declined = (tool: string, args: unknown): SendRow => ({ role: "bot", kind: "options", card: { send: { key: outboundSendKey(tool, args)!, declined: true } } });
    const cases: Array<[string, string, unknown, unknown]> = [
      ["/api/internal/email/mcp", "mcp__email__EMAIL_SEND_MESSAGE", { to: "a@b.c", text: "late rent" }, { method: "tools/call", params: { name: "EMAIL_SEND_MESSAGE", arguments: { to: "a@b.c", text: "late rent" } } }],
      ["/api/internal/device/mcp", "mcp__phone__PHONE_SEND_MESSAGE", { to: "Ramesh", text: "late" }, { method: "tools/call", params: { name: "PHONE_SEND_MESSAGE", arguments: { to: "Ramesh", text: "late" } } }],
      ["/api/internal/slack/slack_post", "mcp__agents__slack_post", { channel: "C1", text: "late" }, { channel: "C1", text: "late" }],
      ["/api/internal/slack/slack_dm", "mcp__agents__use_tool", { name: "slack_dm", arguments: { user: "U1", text: "late" } }, { user: "U1", text: "late" }],
      ["/api/internal/people/message", "mcp__agents__message_person", { to: "Ana", message: "late" }, { to: "Ana", message: "late" }],
    ];
    for (const [path, tool, input, body] of cases) {
      const rows = [declined(tool, input)];
      expect(declinedInternalSend(path, body, () => rows), path).toEqual({ status: 409, error: DECLINED_BEFORE });
      expect(declinedInternalSend(path, body, () => [...rows, { role: "user", kind: "text", text: "go ahead and send it" }]), path).toBeNull();
    }
    expect(declinedInternalSend("/api/internal/slack/slack_post", { channel: "C1", text: "something else" }, () => [declined("slack_post", { channel: "C1", text: "late" })])).toBeNull();
  });
});
