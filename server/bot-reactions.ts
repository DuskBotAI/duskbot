import type { ServerResponse } from "node:http";

import { BOT_REACTIONS, botReactor, normalizeReaction } from "../shared/reactions.ts";
import type { json as sendJson } from "./harness/http.ts";
import { PASS } from "./routes/table.ts";
import type { Message, Store } from "./store.ts";

export const BOT_REACT_PATH = "/api/internal/react";

type BotReactionStore = Pick<Store, "bot" | "botByThread" | "groupByThread" | "messagesFor" | "setReaction">;
type Outcome = { ok: true; text: string } | { ok: false; error: string };

const personsLine = (message: Message) =>
  message.role === "user" && message.kind === "text" && !message.peerAsk && !message.peerResume && !message.reaction &&
  !message.automation && !message.webhookPost;

/** Sets the bot's one reaction on a line the person wrote in its own chat. It patches the line and nothing else, so it
 * starts no turn, answers no card and never reaches a bot as the person's reply. */
export function reactAsBot(store: BotReactionStore, input: { botId: string; threadId: string; emoji: unknown; messageId?: unknown }): Outcome {
  const emoji = normalizeReaction(input.emoji);
  if (!emoji || !(BOT_REACTIONS as readonly string[]).includes(emoji)) return { ok: false, error: `emoji must be one of ${BOT_REACTIONS.join(" ")}` };
  if (input.messageId !== undefined && (typeof input.messageId !== "string" || !input.messageId)) return { ok: false, error: "message_id must be a message id from this chat." };
  const bot = store.bot(input.botId);
  if (!bot || store.groupByThread(input.threadId) || store.botByThread(input.threadId)?.id !== bot.id) {
    return { ok: false, error: "You can react only in your own chat with the person, not in a room." };
  }
  const lines = store.messagesFor(input.threadId);
  const target = input.messageId === undefined ? lines.findLast(personsLine) : lines.find((line) => line.id === input.messageId);
  if (!target || !personsLine(target)) return { ok: false, error: input.messageId === undefined ? "There is no message from the person to react to." : "That is not a message the person wrote in this chat." };
  const by = botReactor(bot.id);
  if (target.reactions?.some((reaction) => reaction.by === by && reaction.emoji === emoji)) return { ok: true, text: `You had already reacted ${emoji}.` };
  store.setReaction(input.threadId, target.id, by, { emoji, name: bot.name, at: Date.now() });
  return { ok: true, text: `Reacted ${emoji} to the person's message. Reply in words if it needs a reply, or end with just (pass) if the reaction is enough.` };
}

export interface BotReactionContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  botId: string;
  threadId: string;
  readBody: () => Promise<unknown>;
}

export function createBotReactionRoutes(store: BotReactionStore) {
  return async (ctx: BotReactionContext): Promise<typeof PASS | void> => {
    if (ctx.method !== "POST" || ctx.path !== BOT_REACT_PATH) return PASS;
    const body = await ctx.readBody().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return void ctx.json(ctx.res, 400, { error: "Send a JSON object with an emoji." });
    const outcome = reactAsBot(store, { botId: ctx.botId, threadId: ctx.threadId, emoji: body.emoji, messageId: body.message_id });
    return void (outcome.ok ? ctx.json(ctx.res, 200, { text: outcome.text }) : ctx.json(ctx.res, 400, { error: outcome.error }));
  };
}
