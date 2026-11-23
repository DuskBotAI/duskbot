import { z } from "zod";

import { GROK_EXPORT_MAX_CHARS } from "../../shared/grok-import.ts";
import { GROK_MOVE_PATH, GROK_MOVE_ROUTES, isRosterId, type GrokDetection } from "../../shared/grok-move.ts";
import { exportProblem, type GrokMoveError, type GrokMover } from "../grok-bot-move.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface GrokMoveRouteDeps {
  /** True only on the desktop app's own server: see SetupImportRouteDeps.local. */
  local: boolean;
  mover: () => GrokMover;
}

const LOCAL_ONLY = "Only the desktop app on the computer running dusk bot can move bots from Grok Bot on that computer.";
const NOT_HERE: GrokDetection = { available: false, reason: "notDesktop", found: false, bots: [], apps: [], problems: [], running: false, waiting: 0 };
const rosterId = z.string().refine(isRosterId, "not a Grok Bot id");
const startSchema = z.object({
  bots: z.array(z.object({ rosterId, chat: z.boolean().optional(), instructions: z.boolean().optional() }).strict()).min(1).max(200),
}).strict();
const undoSchema = z.object({ moveId: z.string().uuid(), confirm: z.literal(true) }).strict();
const requestSchema = z.object({ rosterId }).strict();
const acceptSchema = z.object({ text: z.string().min(1), rosterId: rosterId.optional(), file: z.string().max(255).optional() }).strict();
/** JSON escaping can double an export's size on the wire. */
const ACCEPT_BODY_MAX = 2 * GROK_EXPORT_MAX_CHARS + 4_096;

const isMoveError = (error: unknown): error is GrokMoveError =>
  error instanceof Error && error.name === "GrokMoveError" && typeof (error as { status?: unknown }).status === "number";

const ROUTES = new Set<string>(Object.values(GROK_MOVE_ROUTES));
const METHODS: Record<string, readonly string[]> = {
  [GROK_MOVE_ROUTES.detect]: ["GET"], [GROK_MOVE_ROUTES.photo]: ["GET"], [GROK_MOVE_ROUTES.start]: ["POST"],
  [GROK_MOVE_ROUTES.progress]: ["GET"], [GROK_MOVE_ROUTES.stop]: ["POST"], [GROK_MOVE_ROUTES.undo]: ["GET", "POST"],
  [GROK_MOVE_ROUTES.waiting]: ["GET"], [GROK_MOVE_ROUTES.request]: ["POST"], [GROK_MOVE_ROUTES.acceptExport]: ["POST"],
};

/** "Move from Grok Bot": only the owner's own loopback on the desktop app's server, never a paired device, a browser
 * elsewhere, a bot's shell on a service server, a Cloud home or a hosted server. */
export function createGrokMoveRoutes(deps: GrokMoveRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!path.startsWith(`${GROK_MOVE_PATH}/`)) return PASS;
    if (!ROUTES.has(path)) return json(res, 404, { error: "not found" });
    if (!METHODS[path]!.includes(method)) return json(res, 405, { error: "method not allowed" });
    const owner = auth.kind === "loopback" && auth.trust !== "service";
    if (!deps.local && owner && path === GROK_MOVE_ROUTES.detect) return json(res, 200, NOT_HERE);
    if (!deps.local || !owner) return json(res, 403, { error: LOCAL_ONLY });
    res.setHeader("Cache-Control", "no-store");
    const url = new URL(req.url ?? "", "http://local");
    let body: unknown;
    if (method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      try {
        body = await readBody(req, path === GROK_MOVE_ROUTES.acceptExport ? ACCEPT_BODY_MAX : 64 * 1024);
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        if (status === 413 && path === GROK_MOVE_ROUTES.acceptExport) return json(res, 200, { applied: [], problems: [exportProblem("pasted text", "tooLarge")] });
        return json(res, status, { error: status === 413 ? "request too large" : "invalid JSON" });
      }
    }
    const mover = deps.mover();
    try {
      switch (path) {
        case GROK_MOVE_ROUTES.detect:
          return json(res, 200, mover.detect());
        case GROK_MOVE_ROUTES.photo: {
          const id = url.searchParams.get("id") ?? "";
          if (!isRosterId(id)) return json(res, 400, { error: "id must be a Grok Bot id" });
          const photo = mover.photo(id);
          if (!photo) return json(res, 404, { error: "This bot has no picture here." });
          res.writeHead(200, { "content-type": photo.mime, "content-length": String(photo.bytes.length), "x-content-type-options": "nosniff", "cache-control": "no-store" });
          res.end(photo.bytes);
          return;
        }
        case GROK_MOVE_ROUTES.start: {
          const parsed = startSchema.safeParse(body);
          if (!parsed.success) return json(res, 400, { error: "Choose the bots to move: bots is a list of { rosterId, chat?, instructions? }." });
          return json(res, 202, mover.start(parsed.data.bots));
        }
        case GROK_MOVE_ROUTES.progress: {
          const progress = mover.progress();
          return progress ? json(res, 200, progress) : json(res, 404, { error: "No move from Grok Bot yet." });
        }
        case GROK_MOVE_ROUTES.stop:
          return json(res, 200, mover.stop());
        case GROK_MOVE_ROUTES.undo: {
          if (method === "GET") {
            const moveId = url.searchParams.get("moveId") ?? "";
            if (!z.string().uuid().safeParse(moveId).success) return json(res, 400, { error: "moveId must name a move" });
            return json(res, 200, mover.undoPreview(moveId));
          }
          const parsed = undoSchema.safeParse(body);
          if (!parsed.success) return json(res, 400, { error: "Send moveId and confirm: true after showing what will be removed." });
          return json(res, 200, await mover.undo(parsed.data.moveId));
        }
        case GROK_MOVE_ROUTES.waiting:
          return json(res, 200, mover.waiting());
        case GROK_MOVE_ROUTES.request: {
          const parsed = requestSchema.safeParse(body);
          if (!parsed.success) return json(res, 400, { error: "rosterId must be a Grok Bot id" });
          return json(res, 200, mover.request(parsed.data.rosterId));
        }
        case GROK_MOVE_ROUTES.acceptExport: {
          const parsed = acceptSchema.safeParse(body);
          if (!parsed.success) return json(res, 400, { error: "Send the export as text, with the bot's rosterId when it is known." });
          const file = parsed.data.file?.trim() || "pasted text";
          if (parsed.data.text.length > GROK_EXPORT_MAX_CHARS) return json(res, 200, { applied: [], problems: [exportProblem(file, "tooLarge")] });
          return json(res, 200, mover.accept(parsed.data.text, { ...(parsed.data.rosterId ? { rosterId: parsed.data.rosterId } : {}), file }));
        }
      }
    } catch (error) {
      if (isMoveError(error)) return json(res, error.status, { error: error.message });
      throw error;
    }
    return json(res, 404, { error: "not found" });
  };
}
