// Do it, Not now or Don't suggest this on a suggestion. Only the owner or an admin answers, and only the line the
// suggestion posted.
import type { OfferAnswer } from "../../shared/offer.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { AnswerOutcome } from "../host/offers.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface OfferRouteDeps {
  answer(input: { threadId: string; messageId: string; offerId: string; answer: OfferAnswer; auth: RequestAuth }): Promise<AnswerOutcome>;
}

const ID = /^[\w-]{1,128}$/;
const ANSWERS: ReadonlySet<string> = new Set(["do", "notNow", "never"]);

export function createOfferRoutes(deps: OfferRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/offers/answer" || method !== "POST") return PASS;
    const body = await readBody(req, 2048);
    const threadId = typeof body?.threadId === "string" ? body.threadId : "";
    const messageId = typeof body?.messageId === "string" ? body.messageId : "";
    const offerId = typeof body?.offerId === "string" ? body.offerId : "";
    const answer = typeof body?.answer === "string" && ANSWERS.has(body.answer) ? body.answer as OfferAnswer : null;
    if (!ID.test(threadId) || !ID.test(messageId) || !ID.test(offerId) || !answer) return json(res, 400, { error: "threadId, messageId, offerId and answer are required" });
    const outcome = await deps.answer({ threadId, messageId, offerId, answer, auth });
    if (outcome.kind === "refused") return json(res, 403, { error: "Only the owner can answer this." });
    if (outcome.kind === "unknown") return json(res, 404, { error: "There is no such suggestion." });
    if (outcome.kind === "unavailable") return json(res, 409, { error: outcome.why });
    return json(res, 200, { ok: true, ...(outcome.started ? { started: outcome.started } : {}) });
  };
}
