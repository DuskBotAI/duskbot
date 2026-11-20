// A send the person declined is final for its chat: the same content to the same place is refused, with no new card,
// until the person asks for a send again in their own words. Every send path keys its content the same way here, so a
// decline on an approval card stops the same send through the built-in email, phone, Slack or person tools as well as
// a connected app. The key is a hash: the content itself is never kept.
import { createHash } from "node:crypto";

import { isOutboundTool } from "./outbound.ts";

export const DECLINED_BEFORE = "dusk bot did not send this: the person already said no to this exact message in this chat. Do not send it again, reword it or reach them another way; tell them it was not sent, unless they ask you to send it again.";

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const canonical = (value: unknown): unknown => typeof value === "string" ? value.replace(/\s+/g, " ").trim().toLowerCase()
  : Array.isArray(value) ? value.map(canonical)
  : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
    const part = canonical(value[key]);
    return part === "" || part === null || part === undefined ? [] : [[key, part]];
  }))
  : value;

/** The tool a call runs, as its own server names it: `mcp__server__x` is x, and a bridged `use_tool` is the tool it names. */
export function sentTool(tool: string, args: unknown): { tool: string; args: unknown } {
  const bare = tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool;
  if (/(?:^|_)use_tool$/.test(bare) && isRecord(args) && typeof args.name === "string") return sentTool(args.name, args.arguments);
  return { tool: bare, args };
}

/** What sends would put out, as a hash: the same tools with the same arguments, ignoring case, spacing and empty fields. */
export function sendKey(calls: ReadonlyArray<{ slug: string; arguments?: unknown }>): string {
  const parts = calls.map((call) => { const sent = sentTool(call.slug, call.arguments); return [sent.tool, canonical(sent.args ?? null)]; });
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

/** The key of one tool call when it sends something to someone, or undefined. */
export function outboundSendKey(tool: string, args: unknown): string | undefined {
  const sent = sentTool(tool, args);
  return isOutboundTool(sent.tool) || isOutboundTool(tool) || sent.tool === "message_person" ? sendKey([{ slug: sent.tool, arguments: sent.args }]) : undefined;
}

const ASKS_TO_SEND = /\b(?:send|post|publish|reply|forward|tweet|dm|message|email|mail|text|share|go ahead|do it)\b/i;
const HOLDS_BACK = /\b(?:don['’]?t|do not|never|not|no|stop|cancel|wait)\b/i;

export interface SendRow {
  role: string;
  kind: string;
  text?: string;
  card?: { send?: { key: string; declined?: true } };
  peerAsk?: unknown;
  fromApp?: unknown;
}

/** Whether the person declined this exact send in this chat and has not asked for a send since. */
export function declinedBefore(rows: readonly SendRow[], key: string): boolean {
  let declined = false;
  for (const row of rows) {
    if (row.kind === "options" && row.card?.send?.declined && row.card.send.key === key) declined = true;
    else if (declined && row.role === "user" && !row.peerAsk && !row.fromApp && ASKS_TO_SEND.test(row.text ?? "") && !HOLDS_BACK.test(row.text ?? "")) declined = false;
  }
  return declined;
}

/** The refusal for a send of `tool` with `args` in a chat with these rows, or null when it may go on. */
export function declinedSendRefusal(rows: readonly SendRow[], tool: string, args: unknown): string | null {
  const key = outboundSendKey(tool, args);
  return key && declinedBefore(rows, key) ? DECLINED_BEFORE : null;
}
