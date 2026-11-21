import { describe, expect, it, vi } from "vitest";

import type { Message } from "../store.ts";
import { createXAccountCards } from "./x-account-cards.ts";

function fakeStore() {
  const lines: Message[] = [];
  return {
    lines,
    appendMessage: vi.fn((_threadId: string, message: Omit<Message, "id" | "at">) => { const line = { ...message, id: `m${lines.length}`, at: 1 } as Message; lines.push(line); return line; }),
    messagesFor: vi.fn(() => lines),
    patchMessage: vi.fn((_threadId: string, id: string, patch: Partial<Message>) => { const line = lines.find((one) => one.id === id); if (line) Object.assign(line, patch); }),
  };
}

const ASK = { botId: "b", threadId: "t", title: "Search X with your X account?", subtitle: "s", options: ["Use my X account", "Not now"] };

describe("X account question card", () => {
  it("posts a fixed-option question and settles on the person's tap", async () => {
    const store = fakeStore();
    const cards = createXAccountCards({ store: store as never, holdMs: 60_000 });
    const answer = cards.ask(ASK);
    const card = store.lines[0]!.card!;
    expect(card).toMatchObject({ title: ASK.title, options: ASK.options, fixedOptions: true, requestType: "question", tool: "x_search" });
    expect(cards.resolve("t", card.requestId!, "answer", "Use my X account")).toMatchObject({ status: 200 });
    expect(await answer).toBe("allow");
    expect(store.lines[0]!.card).toMatchObject({ answered: "answer", answeredText: "Use my X account" });
    expect(cards.resolve("t", card.requestId!, "answer", "Not now")).toMatchObject({ status: 409 });
  });

  it("takes Not now as a no, ignores other cards, and closes on a typed reply or a timeout", async () => {
    vi.useFakeTimers();
    try {
      const store = fakeStore();
      const cards = createXAccountCards({ store: store as never, holdMs: 1_000 });
      const no = cards.ask(ASK);
      expect(cards.resolve("t", "other-card", "allow", undefined)).toBeNull();
      expect(cards.resolve("t", store.lines[0]!.card!.requestId!, "answer", "Not now")).toMatchObject({ status: 200 });
      expect(await no).toBe("deny");
      const typed = cards.ask(ASK);
      cards.replied("t");
      expect(await typed).toBe("replied");
      const late = cards.ask(ASK);
      vi.advanceTimersByTime(1_001);
      expect(await late).toBe("timeout");
      expect(store.lines[2]!.card).toMatchObject({ answered: "unavailable", dismissed: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
