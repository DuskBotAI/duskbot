// An email a bot is about to send through a connected app, as the person reviews it on the "Send this email?" card,
// and the edits they make there before tapping Send.
import type { ConnectorCall } from "./outbound.ts";

/** What the review card shows. `app` is the mailbox's app ("Gmail", "Outlook"). */
export interface EmailReview {
  app: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** A reply in an existing conversation. */
  reply?: boolean;
  /** A saved draft sent by id, read from the mailbox: it goes out as saved, so the card offers no Edit. */
  draft?: true;
}

/** The draft id of a single "send this saved Gmail draft" call, or null. */
export function draftSent(calls: readonly ConnectorCall[]): string | null {
  if (calls.length !== 1 || calls[0]!.slug.replace(/^mcp__(?:composio|own_apps)__/u, "") !== "GMAIL_SEND_DRAFT") return null;
  const args = calls[0]!.arguments;
  const id = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>).draft_id : undefined;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

const headerOf = (headers: unknown, name: string): string | undefined => Array.isArray(headers)
  ? headers.find((header) => header && typeof header === "object" && String((header as { name?: unknown }).name).toLowerCase() === name)?.value
  : undefined;

function decodeBase64Url(data: string): string {
  try { return new TextDecoder().decode(Uint8Array.from(atob(data.replace(/-/gu, "+").replace(/_/gu, "/")), (char) => char.charCodeAt(0))); } catch { return ""; }
}

/** The text/plain part of a Gmail message payload, else its first text part with tags dropped. */
function partText(payload: unknown, mime: "text/plain" | "text/html", depth = 0): string {
  if (!payload || typeof payload !== "object" || depth > 6) return "";
  const part = payload as { mimeType?: unknown; body?: { data?: unknown }; parts?: unknown };
  if (part.mimeType === mime && typeof part.body?.data === "string") return decodeBase64Url(part.body.data);
  for (const child of Array.isArray(part.parts) ? part.parts : []) { const text = partText(child, mime, depth + 1); if (text) return text; }
  return "";
}

const payloadText = (payload: unknown) =>
  partText(payload, "text/plain") || partText(payload, "text/html").replace(/<[^>]+>/gu, " ").replace(/[ \t]+/gu, " ").trim();

/** A Gmail draft as Composio's GMAIL_GET_DRAFT returns it, in either of its shapes (the API's message payload, or the
 * flattened fields), as the review card shows it; null when it holds no text. */
export function draftReviewOf(value: unknown): EmailReview | null {
  let found: EmailReview | null = null;
  const visit = (node: unknown, depth: number) => {
    if (found || !node || typeof node !== "object" || depth > 8) return;
    const record = node as Record<string, unknown>;
    const payload = record.payload as { headers?: unknown } | undefined;
    const headers = payload?.headers;
    const body = typeof record.messageText === "string" ? record.messageText : payload ? payloadText(payload) : "";
    if (body.trim()) {
      const to = addressList(headerOf(headers, "to") ?? record.to ?? record.recipient_email ?? record.recipients);
      const cc = addressList(headerOf(headers, "cc") ?? record.cc);
      const subject = String(headerOf(headers, "subject") ?? record.subject ?? "");
      found = { app: "Gmail", to, ...(cc.length ? { cc } : {}), subject, body: body.slice(0, MAX_BODY), draft: true };
      return;
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(value, 0);
  return found;
}

/** On a card that holds an email waiting on the person: who it goes to, its subject and its whole text, editable before Send. */
export interface EmailCardField {
  email?: EmailReview;
}

/** What the person changed on the card; anything left out stays as the bot wrote it. */
export interface EmailEdits {
  to?: string[];
  subject?: string;
  body?: string;
}

interface Fields {
  app: string;
  to: string[];
  extraTo?: string;
  cc?: string;
  subject?: string;
  body: string;
  reply?: boolean;
}

const SLUGS: Readonly<Record<string, Fields>> = {
  GMAIL_SEND_EMAIL: { app: "Gmail", to: ["recipient_email", "to"], extraTo: "extra_recipients", cc: "cc", subject: "subject", body: "body" },
  GMAIL_REPLY_TO_THREAD: { app: "Gmail", to: ["recipient_email", "to"], extraTo: "extra_recipients", cc: "cc", body: "message_body", reply: true },
  OUTLOOK_SEND_EMAIL: { app: "Outlook", to: ["to_email", "to"], cc: "cc_emails", subject: "subject", body: "body" },
  OUTLOOK_OUTLOOK_SEND_EMAIL: { app: "Outlook", to: ["to_email", "to"], cc: "cc_emails", subject: "subject", body: "body" },
  OUTLOOK_REPLY_EMAIL: { app: "Outlook", to: [], cc: "cc_emails", body: "comment", reply: true },
};

const MAX_BODY = 20_000;
const MAX_SUBJECT = 500;
const MAX_RECIPIENTS = 50;
const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/u;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function addressList(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;]/u) : [];
  return parts.flatMap((part) => (typeof part === "string" && part.trim() ? [part.trim()] : []));
}

const slugOf = (slug: string) => slug.replace(/^mcp__(?:composio|own_apps)__/u, "");

/** The review of one send whose recipients, subject and text can be read from its arguments; null for anything else
 * (a draft sent by id, a batch, a send with no text). */
export function emailReviewOf(calls: readonly ConnectorCall[]): EmailReview | null {
  if (calls.length !== 1) return null;
  const fields = SLUGS[slugOf(calls[0]!.slug)];
  const args = calls[0]!.arguments;
  if (!fields || !isRecord(args)) return null;
  const body = args[fields.body];
  if (typeof body !== "string" || !body.trim()) return null;
  const key = fields.to.find((name) => args[name] !== undefined);
  const to = [...(key ? addressList(args[key]) : []), ...(fields.extraTo ? addressList(args[fields.extraTo]) : [])];
  if (!to.length && !fields.reply) return null;
  const cc = fields.cc ? addressList(args[fields.cc]) : [];
  const subject = fields.subject && typeof args[fields.subject] === "string" ? String(args[fields.subject]) : "";
  return { app: fields.app, to, ...(cc.length ? { cc } : {}), subject, body, ...(fields.reply ? { reply: true } : {}) };
}

/** The edits a card sent, or null when they are not a valid set: every address must read as one. */
export function normalizeEmailEdits(value: unknown): EmailEdits | null {
  if (!isRecord(value)) return null;
  const edits: EmailEdits = {};
  if (value.to !== undefined) {
    const to = addressList(value.to);
    if (!to.length || to.length > MAX_RECIPIENTS || !to.every((address) => ADDRESS.test(address))) return null;
    edits.to = to;
  }
  if (value.subject !== undefined) {
    if (typeof value.subject !== "string" || value.subject.length > MAX_SUBJECT) return null;
    edits.subject = value.subject;
  }
  if (value.body !== undefined) {
    if (typeof value.body !== "string" || !value.body.trim() || value.body.length > MAX_BODY) return null;
    edits.body = value.body;
  }
  return Object.keys(edits).length ? edits : null;
}

/** The arguments the send goes out with once the person's edits are in, written where that app reads them. */
export function editedEmailArguments(call: ConnectorCall, edits: EmailEdits): Record<string, unknown> | null {
  const fields = SLUGS[slugOf(call.slug)];
  if (!fields || !isRecord(call.arguments)) return null;
  const next: Record<string, unknown> = { ...call.arguments };
  if (edits.to && fields.to.length) {
    const key = fields.to.find((name) => next[name] !== undefined) ?? fields.to[0]!;
    if (fields.extraTo) {
      const [first, ...rest] = edits.to;
      next[key] = first;
      if (rest.length) next[fields.extraTo] = rest;
      else delete next[fields.extraTo];
    } else {
      next[key] = Array.isArray(next[key]) ? edits.to : edits.to.join(", ");
    }
  }
  if (edits.subject !== undefined && fields.subject) next[fields.subject] = edits.subject;
  if (edits.body !== undefined) next[fields.body] = edits.body;
  return next;
}

/** The review with the person's edits shown, as the card keeps it once sent. */
export function editedEmailReview(review: EmailReview, edits: EmailEdits): EmailReview {
  return { ...review, ...(edits.to ? { to: edits.to } : {}), ...(edits.subject !== undefined ? { subject: edits.subject } : {}), ...(edits.body !== undefined ? { body: edits.body } : {}) };
}
