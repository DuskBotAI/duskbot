import { describe, expect, it, vi } from "vitest";

import { draftSent } from "../shared/email-review.ts";
import { readGmailDraft } from "./gmail-draft-read.ts";

const b64 = (text: string) => Buffer.from(text).toString("base64url");
const apiDraft = { data: { id: "r-1", message: { payload: {
  mimeType: "multipart/alternative",
  headers: [{ name: "To", value: "sam@example.com, kim@example.com" }, { name: "Subject", value: "Friday works" }],
  parts: [{ mimeType: "text/html", body: { data: b64("<p>Hi Sam</p>") } }, { mimeType: "text/plain", body: { data: b64("Hi Sam,\nFriday works.") } }],
} } } };
const reply = (value: unknown, stream = false) => {
  const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
  return { bytes: new TextEncoder().encode(stream ? `event: message\ndata: ${rpc}\n\n` : rpc), contentType: stream ? "text/event-stream" : "application/json" };
};

describe("a Gmail draft sent by id", () => {
  it("is recognised by its call", () => {
    expect(draftSent([{ slug: "GMAIL_SEND_DRAFT", arguments: { user_id: "me", draft_id: "r-1" } }])).toBe("r-1");
    expect(draftSent([{ slug: "GMAIL_SEND_EMAIL", arguments: { draft_id: "r-1" } }])).toBeNull();
  });

  it("is read through the relay so its card shows the real recipients, subject and text", async () => {
    const relay = vi.fn(async () => reply(apiDraft, true));
    await expect(readGmailDraft(relay, "r-1")).resolves.toEqual({ app: "Gmail", to: ["sam@example.com", "kim@example.com"], subject: "Friday works", body: "Hi Sam,\nFriday works.", draft: true });
    expect(relay).toHaveBeenCalledWith(expect.objectContaining({ method: "tools/call", params: expect.objectContaining({
      arguments: { tools: [{ tool_slug: "GMAIL_GET_DRAFT", arguments: { user_id: "me", draft_id: "r-1", format: "full" } }] } }) }));
  });

  it("reads the flattened shape too, and answers null for an error or a draft with no text", async () => {
    await expect(readGmailDraft(async () => reply({ data: { results: [{ response: { data: { to: "sam@example.com", subject: "Hi", messageText: "Hello" } } }] } }), "r-2"))
      .resolves.toMatchObject({ to: ["sam@example.com"], subject: "Hi", body: "Hello" });
    await expect(readGmailDraft(async () => ({ bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [] } })), contentType: "application/json" }), "r-3")).resolves.toBeNull();
    await expect(readGmailDraft(async () => reply({ data: { message: { payload: { headers: [] } } } }), "r-4")).resolves.toBeNull();
  });
});
