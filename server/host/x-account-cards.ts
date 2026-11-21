// x_search's one question to a person: may it read X through their own x.com sign-in in the bot's browser. A card with
// fixed options in the conversation the search was asked in; the search waits on the answer, the way a send waits on
// its approval card. Security: only the person's tap (or their typed answer on the card) settles it, never the bot.
import { randomUUID } from "node:crypto";

import type { Store } from "../store.ts";
import type { XAskAnswer } from "../x-providers/session.ts";

const REQUEST_PREFIX = "x-account-";

export interface XAccountCardsDeps {
  store: Pick<Store, "appendMessage" | "messagesFor" | "patchMessage">;
  holdMs: number;
}

export function createXAccountCards(deps: XAccountCardsDeps) {
  const waiting = new Map<string, { threadId: string; messageId: string; options: readonly string[]; settle: (answer: XAskAnswer) => void; timer: ReturnType<typeof setTimeout> }>();

  function close(requestId: string, answer: XAskAnswer, answeredText?: string): void {
    const entry = waiting.get(requestId);
    if (!entry) return;
    waiting.delete(requestId);
    clearTimeout(entry.timer);
    const line = deps.store.messagesFor(entry.threadId).find((message) => message.id === entry.messageId);
    if (line?.card && !line.card.answered) {
      deps.store.patchMessage(entry.threadId, line.id, {
        card: answeredText ? { ...line.card, answered: "answer", answeredText } : { ...line.card, answered: "unavailable", dismissed: true },
      });
    }
    entry.settle(answer);
  }

  return {
    ask(input: { botId: string; threadId: string; title: string; subtitle: string; options: string[] }): Promise<XAskAnswer> {
      const requestId = `${REQUEST_PREFIX}${randomUUID()}`;
      const line = deps.store.appendMessage(input.threadId, {
        role: "bot",
        kind: "options",
        card: { title: input.title, subtitle: input.subtitle, options: input.options, fixedOptions: true, requestType: "question", requestId, tool: "x_search" },
      });
      return new Promise<XAskAnswer>((settle) => {
        const timer = setTimeout(() => close(requestId, "timeout"), deps.holdMs);
        timer.unref?.();
        waiting.set(requestId, { threadId: input.threadId, messageId: line.id, options: input.options, settle, timer });
      });
    },

    /** Answers one of these cards; null for any other card. */
    resolve(threadId: string, requestId: string, behavior: string, message: unknown): { status: number; body: unknown } | null {
      if (!requestId.startsWith(REQUEST_PREFIX)) return null;
      const entry = waiting.get(requestId);
      if (!entry || entry.threadId !== threadId) {
        // The search that asked has ended (answered elsewhere, timed out, or the server restarted).
        const stale = deps.store.messagesFor(threadId).find((line) => line.card?.requestId === requestId);
        if (stale?.card && !stale.card.answered) deps.store.patchMessage(threadId, stale.id, { card: { ...stale.card, answered: "unavailable", dismissed: true } });
        return { status: 409, body: { error: "This question has closed. Ask for the X search again." } };
      }
      const allow = behavior === "allow" || (behavior === "answer" && message === entry.options[0]);
      close(requestId, allow ? "allow" : "deny", allow ? entry.options[0] : entry.options[1]);
      return { status: 200, body: { ok: true, outcome: allow ? "allowed" : "declined" } };
    },

    /** The person wrote in the conversation instead of answering: the search goes on without their account. */
    replied(threadId: string): void {
      for (const [requestId, entry] of waiting) if (entry.threadId === threadId) close(requestId, "replied");
    },
  };
}
