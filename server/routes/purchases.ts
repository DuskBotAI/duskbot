// POST /api/internal/purchase/confirm: the "Confirm purchase" card a bot posts before a purchase's final step, answered
// by the person's tap. A confirmation lets the bot's browser take that one step (server/purchase-gate.ts).
import type { ServerResponse } from "node:http";

import { parsePurchaseSummary } from "../../shared/purchase.ts";
import type { OutboundHold, OutboundHoldBot } from "../outbound-hold.ts";
import { computerPurchasePasses } from "../computer-purchase.ts";
import { purchaseGate } from "../purchase-gate.ts";
import type { Message } from "../store.ts";
import type { json as sendJson } from "../harness/http.ts";
import { PASS } from "./table.ts";

export const CONFIRM_PURCHASE_PATH = "/api/internal/purchase/confirm";
const MIN_QUOTE = 8;

export interface PurchaseRouteDeps {
  hold: Pick<OutboundHold, "confirmPurchase">;
  bot(id: string): OutboundHoldBot | undefined;
  messagesFor(threadId: string): readonly Message[];
}

export interface PurchaseRouteContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  botId: string;
  threadId: string;
  readBody: () => Promise<unknown>;
  /** The browser session this turn drives, which a confirmation lets finish the purchase. */
  browserSession?: string;
  active?: () => boolean;
}

const words = (text: string) => text.toLocaleLowerCase().replace(/[\s"'“”‘’.,!?¡¿]+/gu, " ").trim();

/** Security: "buy without asking" stands only on the person's own words: the quote must be in their latest message. */
export function personSaid(messages: readonly Message[], quote: unknown): boolean {
  if (typeof quote !== "string" || words(quote).length < MIN_QUOTE) return false;
  const latest = messages.findLast((message) => message.role === "user" && !message.peerAsk && !message.reaction && typeof message.text === "string");
  return Boolean(latest?.text && words(latest.text).includes(words(quote)));
}

export function createPurchaseRoutes(deps: PurchaseRouteDeps) {
  return async (ctx: PurchaseRouteContext): Promise<typeof PASS | void> => {
    if (ctx.method !== "POST" || ctx.path !== CONFIRM_PURCHASE_PATH) return PASS;
    const body = await ctx.readBody().catch(() => null) as Record<string, unknown> | null;
    const bot = deps.bot(ctx.botId);
    if (!bot) return void ctx.json(ctx.res, 404, { error: "no such bot" });
    if (!body || typeof body !== "object") return void ctx.json(ctx.res, 400, { error: "Send {summary, without_asking?, quote?}." });
    const parsed = parsePurchaseSummary(body.summary);
    if (!parsed.ok) return void ctx.json(ctx.res, 400, { error: parsed.error });
    const messages = deps.messagesFor(ctx.threadId);
    if (body.without_asking === true && !personSaid(messages, body.quote)) {
      return void ctx.json(ctx.res, 400, { error: "quote: copy the person's own words from their latest message that say to buy without asking. If they did not say so, call confirm_purchase without without_asking so they can confirm." });
    }
    const recorded = body.without_asking === true;
    const answer = await deps.hold.confirmPurchase({ bot, threadId: ctx.threadId, summary: parsed.value, recorded, active: ctx.active ?? (() => true) });
    if (!answer.ok) return void ctx.json(ctx.res, 409, { error: answer.text });
    if (ctx.browserSession) purchaseGate.grant(ctx.browserSession);
    computerPurchasePasses.grant(ctx.threadId);
    return void ctx.json(ctx.res, 200, {
      text: recorded
        ? "Recorded: the summary card is in the chat as the person's receipt. Take the final step now, once."
        : "The person confirmed this purchase. Take the final step now, once, then tell them it is done with the order number if the page shows one.",
    });
  };
}
