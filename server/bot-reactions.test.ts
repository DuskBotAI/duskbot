import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { botReactor } from "../shared/reactions.ts";
import { reactAsBot } from "./bot-reactions.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { callReactTool, REACT_TOOL_DEFINITION } from "./drivers/agents-react-tool.ts";
import type { ToolCallContext } from "./drivers/agents-call.ts";
import { withReactionNotes } from "./reactions.ts";
import { Store } from "./store.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

function fixture() {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  const write = (text: string, patch = {}) => store.appendMessage(bot.threadId, { role: "user", kind: "text", text, ...patch });
  const say = (text: string) => store.appendMessage(bot.threadId, { role: "bot", kind: "text", text });
  const line = (id: string) => store.messagesFor(bot.threadId).find((message) => message.id === id)!;
  return { store, bot, write, say, line };
}

describe("a bot's reaction", () => {
  it("lands on the person's latest message under the bot's key and name, and adds no line", () => {
    const { store, bot, write, say, line } = fixture();
    write("can you book it");
    say("Booked for Friday.");
    const thanks = write("thank you!!");
    const before = store.messagesFor(bot.threadId).length;
    expect(reactAsBot(store, { botId: bot.id, threadId: bot.threadId, emoji: "❤️" })).toMatchObject({ ok: true });
    expect(line(thanks.id).reactions).toEqual([{ emoji: "❤️", by: botReactor(bot.id), name: "Scout", at: expect.any(Number) }]);
    expect(store.messagesFor(bot.threadId)).toHaveLength(before);
  });

  it("keeps one per bot per message: a new emoji replaces its own and leaves the person's", () => {
    const { store, bot, write, line } = fixture();
    const news = write("I got the job");
    store.setReaction(bot.threadId, news.id, "user", { emoji: "🎉", at: 1 });
    reactAsBot(store, { botId: bot.id, threadId: bot.threadId, emoji: "👍" });
    reactAsBot(store, { botId: bot.id, threadId: bot.threadId, emoji: "🎉" });
    expect(reactAsBot(store, { botId: bot.id, threadId: bot.threadId, emoji: "🎉" })).toEqual({ ok: true, text: "You had already reacted 🎉." });
    expect(line(news.id).reactions).toEqual([
      { emoji: "🎉", by: "user", at: 1 },
      { emoji: "🎉", by: botReactor(bot.id), name: "Scout", at: expect.any(Number) },
    ]);
  });

  it("takes an earlier message of the person's by id, and refuses the bot's own lines and a teammate's ask", () => {
    const { store, bot, write, say, line } = fixture();
    const joke = write("why did the chicken cross the road");
    write("anyway");
    const mine = say("To get to the other side.");
    const ask = write("Please check the logs", { peerAsk: { botId: "other", name: "Otter" } });
    expect(reactAsBot(store, { botId: bot.id, threadId: bot.threadId, emoji: "😂", messageId: joke.id }).ok).toBe(true);
    expect(line(joke.id).reactions?.[0]?.emoji).toBe("😂");
    for (const messageId of [mine.id, ask.id, "nope"]) {
      expect(reactAsBot(store, { botId: bot.id, threadId: bot.threadId, emoji: "👍", messageId })).toEqual({ ok: false, error: "That is not a message the person wrote in this chat." });
    }
  });

  it("refuses an emoji outside its set, another bot's chat and a room", () => {
    const { store, bot, write } = fixture();
    write("hello");
    const otter = store.createBot({ name: "Otter" });
    const room = store.createGroup("Launch", [bot.id, otter.id]);
    store.appendMessage(room.threadId, { role: "user", kind: "text", text: "we shipped" });
    expect(reactAsBot(store, { botId: bot.id, threadId: bot.threadId, emoji: "👎" }).ok).toBe(false);
    expect(reactAsBot(store, { botId: bot.id, threadId: bot.threadId, emoji: "🔥" }).ok).toBe(false);
    expect(reactAsBot(store, { botId: otter.id, threadId: bot.threadId, emoji: "👍" }).ok).toBe(false);
    expect(reactAsBot(store, { botId: bot.id, threadId: room.threadId, emoji: "🎉" }).ok).toBe(false);
    expect(store.messagesFor(room.threadId).every((message) => !message.reactions)).toBe(true);
  });

  it("is never read back to the bot as a person's reaction", () => {
    const { store, bot, write, say } = fixture();
    say("Here is the draft.");
    const thanks = write("perfect, thanks");
    reactAsBot(store, { botId: bot.id, threadId: bot.threadId, emoji: "❤️" });
    const next = write("one more thing");
    const path = store.messagesFor(bot.threadId);
    expect(withReactionNotes("one more thing", path, new Set([next.id]), "Sam")).toBe("one more thing");
    expect(path.find((message) => message.id === thanks.id)?.reactions).toHaveLength(1);
  });
});

describe("the react tool", () => {
  it("offers only the bot's emoji set and posts the call to the harness", async () => {
    expect(REACT_TOOL_DEFINITION.inputSchema.properties.emoji.enum).toEqual(["👍", "❤️", "😂", "🎉", "👀"]);
    const apiResponse = vi.fn(async () => ({ ok: true, status: 200, body: { text: "Reacted 🎉 to the person's message." } }));
    const context = { client: { apiResponse } } as unknown as ToolCallContext;
    expect(await callReactTool({ emoji: "🎉" }, context)).toEqual({ text: "Reacted 🎉 to the person's message." });
    expect(apiResponse).toHaveBeenCalledWith("/api/internal/react", expect.objectContaining({ method: "POST", body: JSON.stringify({ emoji: "🎉" }) }));
    apiResponse.mockResolvedValueOnce({ ok: false, status: 400, body: { error: "You can react only in your own chat with the person, not in a room." } } as never);
    expect(await callReactTool({ emoji: "🎉", message_id: "m1" }, context)).toEqual({ text: "You can react only in your own chat with the person, not in a room.", isError: true });
  });
});
