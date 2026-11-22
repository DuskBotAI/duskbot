// A chat message or public post a bot is about to send through a connected app, as the person reviews it on the
// "Send this message?" or "Post this?" card, and the text edit they make there before tapping Send.
import type { ConnectorCall } from "./outbound.ts";

/** What the review card shows. `app` is the app it goes out through ("Slack", "X"). */
export interface MessageReview {
  app: string;
  /** Where it goes as the app's arguments name it: a channel, a chat, a handle or a number; empty for a public post. */
  to: string;
  text: string;
  /** A public post on the person's profile rather than a message to someone. */
  post?: true;
  /** A reply in an existing thread. */
  reply?: true;
  /** How many pictures or files go with it. */
  attachments?: number;
  /** The text is formatted for the app (HTML), so the card shows it without markup and offers no Edit. */
  fixed?: true;
}

/** On a card that holds a message waiting on the person: where it goes and its whole text, editable before Send. */
export interface MessageCardField {
  messageReview?: MessageReview;
}

/** What the person changed on the card. */
export interface MessageEdits {
  text: string;
}

interface Fields {
  app: string;
  to?: readonly string[];
  /** Turns the raw recipient into what the person reads. */
  where?: (value: string) => string;
  text: readonly string[];
  reply?: readonly string[];
  attachments?: readonly string[];
  post?: true;
  /** An argument that, when set, holds a layout the card cannot show. */
  layout?: string;
  html?: string;
}

const slackChannel = (value: string) => /^[CGD][A-Z0-9]{6,}$/u.test(value) || value.startsWith("#") || value.startsWith("@") ? value : `#${value}`;
const handle = (value: string) => /^[A-Za-z][\w.]*$/u.test(value) && !/^\d+$/u.test(value) ? `@${value}` : value;

const SLACK: Fields = { app: "Slack", to: ["channel", "channel_id"], where: slackChannel, text: ["markdown_text", "text"], reply: ["thread_ts"], layout: "blocks" };
const TEAMS_CHANNEL: Fields = { app: "Microsoft Teams", to: ["channel_id"], text: ["content"], attachments: ["attachments"], html: "content_type" };
const TWILIO: Fields = { app: "SMS", to: ["to", "To", "to_number"], text: ["body", "Body", "message"] };

const SLUGS: Readonly<Record<string, Fields>> = {
  SLACK_SEND_MESSAGE: SLACK,
  SLACK_CHAT_POST_MESSAGE: SLACK,
  SLACK_POST_MESSAGE: SLACK,
  SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL: SLACK,
  TELEGRAM_SEND_MESSAGE: { app: "Telegram", to: ["chat_id"], where: handle, text: ["text"], reply: ["reply_to_message_id"] },
  WHATSAPP_SEND_MESSAGE: { app: "WhatsApp", to: ["to_number", "to"], text: ["text", "body"], reply: ["message_id", "reply_to_message_id"] },
  DISCORDBOT_CREATE_MESSAGE: { app: "Discord", to: ["channel_id"], text: ["content"], reply: ["message_reference"], attachments: ["attachments"], layout: "embeds" },
  DISCORDBOT_SEND_MESSAGE: { app: "Discord", to: ["channel_id"], text: ["content"], reply: ["message_reference"], attachments: ["attachments"], layout: "embeds" },
  MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE: { ...TEAMS_CHANNEL, to: ["chat_id"] },
  MICROSOFT_TEAMS_TEAMS_POST_CHANNEL_MESSAGE: TEAMS_CHANNEL,
  MICROSOFT_TEAMS_TEAMS_POST_MESSAGE_REPLY: { ...TEAMS_CHANNEL, reply: ["message_id"] },
  MICROSOFT_TEAMS_POST_MESSAGE_REPLY: { ...TEAMS_CHANNEL, reply: ["message_id"] },
  TWITTER_CREATION_OF_A_POST: { app: "X", text: ["text"], reply: ["reply_in_reply_to_tweet_id"], attachments: ["media_media_ids"], post: true, layout: "poll_options" },
  TWITTER_SEND_A_NEW_MESSAGE_TO_A_USER: { app: "X", to: ["participant_id"], text: ["text"], attachments: ["attachments"] },
  TWITTER_SEND_DM_TO_CONVERSATION: { app: "X", to: ["dm_conversation_id"], text: ["text"], attachments: ["attachments"] },
  LINKEDIN_CREATE_LINKED_IN_POST: { app: "LinkedIn", text: ["commentary"], attachments: ["images"], post: true },
  REDDIT_POST_REDDIT_COMMENT: { app: "Reddit", text: ["text"], reply: ["thing_id"] },
  REDDIT_SEND_PRIVATE_MESSAGE: { app: "Reddit", to: ["recipient"], where: (value) => value.startsWith("u/") ? value : `u/${value}`, text: ["text"] },
  TWILIO_SEND_SMS: TWILIO,
  TWILIO_SEND_MESSAGE: TWILIO,
  TWILIO_CREATE_MESSAGE: TWILIO,
};

const MAX_TEXT = 40_000;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const slugOf = (slug: string) => slug.replace(/^mcp__(?:composio|own_apps)__/u, "");
const present = (value: unknown) => value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && !value.length);
const scalar = (value: unknown) => typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
const plain = (html: string) => html.replace(/<br\s*\/?>/giu, "\n").replace(/<\/(?:p|div|li)>/giu, "\n").replace(/<[^>]+>/gu, "")
  .replace(/&nbsp;/gu, " ").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, "\"").replace(/&#39;/gu, "'").replace(/&amp;/gu, "&").trim();

/** Every slug the message card reads, for tests that check each one is held as a send. */
export const MESSAGE_REVIEW_SLUGS: readonly string[] = Object.keys(SLUGS);

function textKey(fields: Fields, args: Record<string, unknown>): string | undefined {
  return fields.text.find((name) => typeof args[name] === "string" && String(args[name]).trim());
}

/** The review of one send whose place and text can be read from its arguments; null for anything else (a batch, a
 * layout the card cannot show, a send with no text): those keep the generic card. */
export function messageReviewOf(calls: readonly ConnectorCall[]): MessageReview | null {
  if (calls.length !== 1) return null;
  const fields = SLUGS[slugOf(calls[0]!.slug)];
  const args = calls[0]!.arguments;
  if (!fields || !isRecord(args) || (fields.layout && present(args[fields.layout]))) return null;
  const key = textKey(fields, args);
  if (!key) return null;
  const html = fields.html !== undefined && (String(args[fields.html] ?? "").toLowerCase() === "html" || /<\/?[a-z][^>]*>/iu.test(String(args[key])));
  const text = html ? plain(String(args[key])) : String(args[key]);
  if (!text.trim()) return null;
  const raw = fields.to?.map((name) => scalar(args[name])).find(Boolean) ?? "";
  if (!raw && fields.to && !fields.post) return null;
  const to = raw && fields.where ? fields.where(raw) : raw;
  const attachments = (fields.attachments ?? []).reduce((sum, name) => {
    const value = args[name];
    return sum + (Array.isArray(value) ? value.length : present(value) ? 1 : 0);
  }, 0);
  return {
    app: fields.app, to, text,
    ...(fields.post ? { post: true as const } : {}),
    ...(fields.reply?.some((name) => present(args[name])) ? { reply: true as const } : {}),
    ...(attachments ? { attachments } : {}),
    ...(html ? { fixed: true as const } : {}),
  };
}

/** The edit a card sent, or null when it is not a valid one. */
export function normalizeMessageEdits(value: unknown): MessageEdits | null {
  if (!isRecord(value) || typeof value.text !== "string" || !value.text.trim() || value.text.length > MAX_TEXT) return null;
  return { text: value.text };
}

/** The arguments the send goes out with once the person's edit is in, written where that app reads its text. */
export function editedMessageArguments(call: ConnectorCall, edits: MessageEdits): Record<string, unknown> | null {
  const fields = SLUGS[slugOf(call.slug)];
  if (!fields || !isRecord(call.arguments)) return null;
  const key = textKey(fields, call.arguments);
  return key ? { ...call.arguments, [key]: edits.text } : null;
}

/** The review with the person's edit shown, as the card keeps it once sent. */
export function editedMessageReview(review: MessageReview, edits: MessageEdits): MessageReview {
  return { ...review, text: edits.text };
}
