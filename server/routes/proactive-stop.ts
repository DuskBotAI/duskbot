// Stop sending me these, on a message an automation sent unasked: the automation pauses and its name goes under Never in
// the person's What to tell me about, so no bot sets the same thing up again. Only the owner or an admin.
import { ownerOrAdmin } from "../request-auth.ts";
import type { ProactiveRule } from "../host/proactive-prefs.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ProactiveStopDeps {
  /** The automation that sent this message, or null when a person or a turn they started wrote it. */
  sender(threadId: string, messageId: string): { routineId: string; name: string; botId: string } | null;
  pause(routineId: string): void;
  rule(rule: ProactiveRule, text: string, actor: "person"): "saved" | "known" | null;
  tell(botId: string, threadId: string, name: string): void;
}

const ID = /^[\w-]{1,128}$/;

export function createProactiveStopRoutes(deps: ProactiveStopDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/proactive/stop" || method !== "POST") return PASS;
    const body = await readBody(req, 2048);
    const threadId = typeof body?.threadId === "string" ? body.threadId : "";
    const messageId = typeof body?.messageId === "string" ? body.messageId : "";
    if (!ID.test(threadId) || !ID.test(messageId)) return json(res, 400, { error: "threadId and messageId are required" });
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only the owner can change this." });
    const sender = deps.sender(threadId, messageId);
    if (!sender) return json(res, 404, { error: "No automation sent this message." });
    deps.pause(sender.routineId);
    const saved = deps.rule("never", sender.name, "person");
    deps.tell(sender.botId, threadId, sender.name);
    return json(res, 200, { ok: true, paused: sender.routineId, remembered: saved !== null });
  };
}
