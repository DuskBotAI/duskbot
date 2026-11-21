import { describe, expect, it } from "vitest";

import { DECLINED_BEFORE, declinedBefore, declinedSendRefusal, outboundSendKey, sendKey, type SendRow } from "./declined-sends.ts";

const declinedCard = (key: string): SendRow => ({ role: "bot", kind: "options", card: { send: { key, declined: true } } });

describe("declined sends", () => {
  it("keys the same send the same way whichever path names it", () => {
    const args = { channel: "C1", text: "Rent will be 2 days late" };
    const key = outboundSendKey("mcp__agents__slack_post", args);
    expect(key).toBeDefined();
    expect(outboundSendKey("slack_post", { text: "rent  will be 2 days LATE ", channel: "C1" })).toBe(key);
    expect(outboundSendKey("mcp__agents__use_tool", { name: "slack_post", arguments: args })).toBe(key);
    expect(outboundSendKey("mcp__email__EMAIL_SEND_MESSAGE", { to: "a@b.c", subject: "", text: "hi" })).toBe(outboundSendKey("EMAIL_SEND_MESSAGE", { to: "a@b.c", text: "hi" }));
    expect(outboundSendKey("message_person", { message: "the deck is ready" })).toBe(sendKey([{ slug: "message_person", arguments: { to: "", message: "the deck is ready" } }]));
    expect(outboundSendKey("slack_read", { channel: "C1" })).toBeUndefined();
    expect(outboundSendKey("EMAIL_READ_MESSAGE", { uid: 3 })).toBeUndefined();
  });

  it("refuses a declined send until the person asks to send again in their own words", () => {
    const key = outboundSendKey("PHONE_SEND_MESSAGE", { to: "Ramesh", text: "late" })!;
    const card = declinedCard(key);
    expect(declinedSendRefusal([card], "mcp__phone__PHONE_SEND_MESSAGE", { to: "Ramesh", text: "late" })).toBe(DECLINED_BEFORE);
    expect(declinedSendRefusal([card], "PHONE_SEND_MESSAGE", { to: "Ramesh", text: "very late" })).toBeNull();
    expect(declinedBefore([card, { role: "user", kind: "text", text: "no, don't send it" }], key)).toBe(true);
    expect(declinedBefore([card, { role: "user", kind: "text", text: "send it", fromApp: { app: "x" } }], key)).toBe(true);
    expect(declinedBefore([card, { role: "user", kind: "text", text: "send it", peerAsk: { botId: "b" } }], key)).toBe(true);
    expect(declinedBefore([card, { role: "user", kind: "text", text: "ok go ahead and send it" }], key)).toBe(false);
    expect(declinedBefore([{ role: "bot", kind: "options", card: { send: { key } } }], key)).toBe(false);
  });
});
