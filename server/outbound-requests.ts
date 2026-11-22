import { randomUUID } from "node:crypto";
import type { ConnectorCall } from "../shared/outbound.ts";
import { describeTool } from "./activity.ts";
import { normalizeEmailEdits, type EmailEdits } from "../shared/email-review.ts";
import { normalizeMessageEdits, type MessageEdits } from "../shared/message-review.ts";

/** What a card's Edit changes: an email's fields or a message's text. */
export type CardEdits = EmailEdits | MessageEdits;

/** replied: the person wrote in the chat while the card waited, so the turn reads their words instead of waiting on. */
export type OutboundAnswer = "allow" | "deny" | "timeout" | "replied";

interface Held {
  botId: string;
  threadId: string;
  tool: string;
  settle: (answer: OutboundAnswer) => void;
  answered?: OutboundAnswer;
  reviews: "email" | "message";
  edits?: CardEdits;
  timer: ReturnType<typeof setTimeout>;
}

export type OutboundResolution =
  | { claimed: false }
  | { claimed: true; state: "allowed" | "denied" }
  | { claimed: true; state: "already_settled"; behavior: OutboundAnswer };

export class OutboundRequestService {
  private held = new Map<string, Held>();

  /** `reviews`: which card's edits the answer may carry; an email card's unless it holds a message. */
  open(input: { botId: string; threadId: string; tool: string; timeoutMs: number; reviews?: "email" | "message" }): {
    requestId: string;
    answer: Promise<OutboundAnswer>;
  } {
    const requestId = randomUUID();
    let settle!: (answer: OutboundAnswer) => void;
    const answer = new Promise<OutboundAnswer>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => this.settle(requestId, "timeout"), input.timeoutMs);
    timer.unref?.();
    this.held.set(requestId, { botId: input.botId, threadId: input.threadId, tool: input.tool, reviews: input.reviews ?? "email", settle, timer });
    return { requestId, answer };
  }

  private settle(requestId: string, answer: OutboundAnswer): void {
    const entry = this.held.get(requestId);
    if (!entry || entry.answered) return;
    entry.answered = answer;
    clearTimeout(entry.timer);
    entry.settle(answer);
  }

  /** `edits`: what the person changed on an email or message card before Send; edits that do not read as a valid set send nothing: the card is denied rather than sent as the bot wrote it. */
  resolve(input: { threadId: string; requestId: string; behavior: "allow" | "deny" | "answer"; edits?: unknown }): OutboundResolution {
    const entry = this.held.get(input.requestId);
    if (!entry || entry.threadId !== input.threadId) return { claimed: false };
    if (entry.answered) return { claimed: true, state: "already_settled", behavior: entry.answered };
    const edits = input.behavior === "allow" && input.edits !== undefined
      ? entry.reviews === "message" ? normalizeMessageEdits(input.edits) : normalizeEmailEdits(input.edits)
      : null;
    const answer: OutboundAnswer = input.behavior === "allow" && (input.edits === undefined || edits) ? "allow" : "deny";
    if (edits) entry.edits = edits;
    this.settle(input.requestId, answer);
    return { claimed: true, state: answer === "allow" ? "allowed" : "denied" };
  }

  /** Settles every card still waiting in this thread as replied; returns their request ids. */
  replied(threadId: string): string[] {
    const ids = this.pending(threadId);
    for (const requestId of ids) this.settle(requestId, "replied");
    return ids;
  }

  pending(threadId: string): string[] {
    return [...this.held.entries()]
      .filter(([, entry]) => entry.threadId === threadId && !entry.answered)
      .map(([requestId]) => requestId);
  }

  edits(requestId: string): CardEdits | null {
    return this.held.get(requestId)?.edits ?? null;
  }

  forget(requestId: string): void {
    const entry = this.held.get(requestId);
    if (entry) clearTimeout(entry.timer);
    this.held.delete(requestId);
  }
}

/** What a "Send on your behalf?" card shows: each app action and its arguments, cut at 400 characters. */
export function outboundCard(outboundCalls: ConnectorCall[]): { app: string | null; calls: { app: string | null; label: string }[]; summary: string } {
  const calls = outboundCalls.map((call) => {
    const { app, label } = describeTool(call.slug);
    return { app, label };
  });
  const summary = outboundCalls.map((call, index) => {
    const described = calls[index];
    const argsText = call.arguments === undefined ? "" : JSON.stringify(call.arguments);
    return `${described.app ? `${described.app} · ` : ""}${described.label}${argsText ? `\n${argsText.slice(0, 400)}${argsText.length > 400 ? "… [arguments truncated]" : ""}` : ""}`;
  }).join("\n\n");
  return { app: calls[0]?.app ?? null, calls, summary };
}
