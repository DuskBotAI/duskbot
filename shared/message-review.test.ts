import { describe, expect, it } from "vitest";

import { editedMessageArguments, MESSAGE_REVIEW_SLUGS, messageReviewOf, normalizeMessageEdits } from "./message-review.ts";
import { isOutboundTool } from "./outbound.ts";

const one = (slug: string, args: unknown) => messageReviewOf([{ slug, arguments: args }]);

describe("messageReviewOf", () => {
  it("reads where each common messaging send goes and its text", () => {
    expect(one("SLACK_SEND_MESSAGE", { channel: "launch", markdown_text: "Shipping at 5", thread_ts: "1.2" })).toEqual({ app: "Slack", to: "#launch", text: "Shipping at 5", reply: true });
    expect(one("mcp__own_apps__SLACK_CHAT_POST_MESSAGE", { channel: "C0123ABCD", text: "Hi" })).toEqual({ app: "Slack", to: "C0123ABCD", text: "Hi" });
    expect(one("TELEGRAM_SEND_MESSAGE", { chat_id: "mychannel", text: "Hi" })).toMatchObject({ app: "Telegram", to: "@mychannel" });
    expect(one("TELEGRAM_SEND_MESSAGE", { chat_id: -100123, text: "Hi" })).toMatchObject({ to: "-100123" });
    expect(one("WHATSAPP_SEND_MESSAGE", { to_number: "+15551234567", text: "On my way", phone_number_id: "1" })).toEqual({ app: "WhatsApp", to: "+15551234567", text: "On my way" });
    expect(one("DISCORDBOT_CREATE_MESSAGE", { channel_id: "99", content: "gg", attachments: [{}, {}] })).toEqual({ app: "Discord", to: "99", text: "gg", attachments: 2 });
    expect(one("TWITTER_CREATION_OF_A_POST", { text: "Launch day", media_media_ids: ["m1"] })).toEqual({ app: "X", to: "", text: "Launch day", post: true, attachments: 1 });
    expect(one("TWITTER_SEND_A_NEW_MESSAGE_TO_A_USER", { participant_id: "42", text: "Hey" })).toMatchObject({ app: "X", to: "42" });
    expect(one("LINKEDIN_CREATE_LINKED_IN_POST", { author: "urn:li:person:1", commentary: "Hiring!" })).toEqual({ app: "LinkedIn", to: "", text: "Hiring!", post: true });
    expect(one("REDDIT_SEND_PRIVATE_MESSAGE", { recipient: "spez", subject: "Hi", text: "Hello" })).toMatchObject({ to: "u/spez" });
    expect(one("TWILIO_SEND_SMS", { to: "+15550001111", body: "Running late" })).toEqual({ app: "SMS", to: "+15550001111", text: "Running late" });
  });

  it("shows Teams HTML as plain text and marks it fixed", () => {
    expect(one("MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE", { chat_id: "19:abc", content: "<p>Hi <b>team</b></p>", content_type: "html" }))
      .toEqual({ app: "Microsoft Teams", to: "19:abc", text: "Hi team", fixed: true });
    expect(one("MICROSOFT_TEAMS_TEAMS_POST_CHANNEL_MESSAGE", { team_id: "t", channel_id: "c", content: "plain" })).toEqual({ app: "Microsoft Teams", to: "c", text: "plain" });
  });

  it("leaves the generic card for what it cannot show", () => {
    expect(one("SLACK_SEND_MESSAGE", { channel: "x", blocks: [{ type: "section" }], fallback_text: "Hi" })).toBeNull();
    expect(one("SLACK_SEND_MESSAGE", { channel: "x" })).toBeNull();
    expect(one("SLACK_SEND_MESSAGE", { markdown_text: "Hi" })).toBeNull();
    expect(one("TWITTER_CREATION_OF_A_POST", { text: "Vote", poll_options: ["a", "b"] })).toBeNull();
    expect(one("NOTION_CREATE_COMMENT", { text: "Hi" })).toBeNull();
    expect(messageReviewOf([{ slug: "SLACK_SEND_MESSAGE", arguments: { channel: "a", markdown_text: "1" } }, { slug: "SLACK_SEND_MESSAGE", arguments: { channel: "b", markdown_text: "2" } }])).toBeNull();
  });

  it("covers only tools the hold treats as sends", () => {
    for (const slug of MESSAGE_REVIEW_SLUGS) expect(isOutboundTool(slug), slug).toBe(true);
  });
});

describe("message edits", () => {
  it("accept non-empty text only", () => {
    expect(normalizeMessageEdits({ text: "ok" })).toEqual({ text: "ok" });
    for (const bad of [null, {}, { text: " " }, { text: 3 }, { body: "email-shaped" }, { text: "x".repeat(40_001) }]) expect(normalizeMessageEdits(bad)).toBeNull();
  });

  it("write the text where the app reads it", () => {
    expect(editedMessageArguments({ slug: "SLACK_CHAT_POST_MESSAGE", arguments: { channel: "c", text: "a" } }, { text: "b" })).toEqual({ channel: "c", text: "b" });
    expect(editedMessageArguments({ slug: "SLACK_SEND_MESSAGE", arguments: { channel: "c", markdown_text: "a" } }, { text: "b" })).toEqual({ channel: "c", markdown_text: "b" });
    expect(editedMessageArguments({ slug: "GMAIL_SEND_EMAIL", arguments: { body: "a" } }, { text: "b" })).toBeNull();
  });
});
