import { z } from "zod";

import { claudeUserMcpEnabled, DATA_DIR, type AppConfig } from "../config.ts";
import { channelLinks, lookForBots } from "../bot-move-local.ts";
import type { MessengerStatus } from "../../shared/messengers.ts";
import { lookForGrokBot, lookForNotes, removeOldCursorSignIn } from "../grok-local.ts";
import { applySetupImport, detectSetup, thisMachine, type SetupHost, type SetupMachine } from "../setup-import.ts";
import { SETUP_SOURCES } from "../../shared/setup-import.ts";
import type { BusyFlag } from "./config.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface SetupImportRouteDeps {
  /** True only on the desktop app's own server. Never on `duskbot serve`, where any local process, a bot's shell
   * among them, is the owner's loopback; nor on a Cloud home or a hosted organization server, whose files are not the
   * person's own. */
  local: boolean;
  cfg: Pick<AppConfig, "mcpServers" | "features">;
  mcpConfigBusy: BusyFlag;
  mcpPolicyRefusal(name: string, server: object): string | undefined;
  persistMcpServers(next: Record<string, unknown>): void;
  /** A bot of this person's here, whose memory imported notes may go to. */
  botExists?(id: string): boolean;
  /** The computer whose files are read; tests point it at a fixture home. */
  machine?: () => SetupMachine;
  dataDir?: string;
  /** Connects a moved bot to the Telegram or Discord bot it answered on before, keeping who was let in there. */
  connectChannel?(botId: string, platform: "telegram" | "discord", token: string, allowed: string[]): Promise<MessengerStatus>;
}

export const SETUP_IMPORT_PATH = "/api/setup-import";
export const GROK_LOOK_PATH = "/api/setup-import/grok";
export const BOTS_LOOK_PATH = "/api/setup-import/bots";
/** The notes file another AI saved to Downloads after the prompt was copied (`?since=` its time, in ms). */
export const NOTES_LOOK_PATH = "/api/setup-import/notes";
/** POST { ref, botId }: the moved bot answers again on the chat apps its old app answered on. */
export const CHANNELS_CARRY_PATH = "/api/setup-import/channels";
const carrySchema = z.strictObject({ ref: z.string().min(3).max(4096), botId: z.string().regex(/^[\w-]{1,128}$/) });
const LOCAL_ONLY = "Only the desktop app on the computer running dusk bot can bring in that computer's skills and tools.";
const SOURCES = SETUP_SOURCES;
const requestSchema = z.object({
  skills: z.boolean().optional(), tools: z.boolean().optional(), instructions: z.boolean().optional(), memory: z.boolean().optional(),
  memoryBot: z.string().min(1).max(200).optional(),
  sources: z.array(z.enum(SOURCES)).max(SOURCES.length).optional(),
}).strict();

/** GET finds what is new here; POST brings in the chosen kinds. Only the owner's own loopback, never a paired device,
 * a browser elsewhere, a bot's shell on a service server, a Cloud home or a hosted server. */
export function createSetupImportRoutes(deps: SetupImportRouteDeps): RouteHandler {
  removeOldCursorSignIn(deps.dataDir ?? DATA_DIR);
  const machine = deps.machine ?? thisMachine;
  const host: SetupHost = {
    mcpServers: () => deps.cfg.mcpServers ?? {},
    mcpPolicyRefusal: deps.mcpPolicyRefusal,
    persistMcpServers: deps.persistMcpServers,
    mcpConfigBusy: deps.mcpConfigBusy,
    claudeUserMcp: () => claudeUserMcpEnabled(deps.cfg),
  };
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path === NOTES_LOOK_PATH) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      if (!deps.local || auth.kind !== "loopback" || auth.trust === "service") return json(res, 403, { error: LOCAL_ONLY });
      res.setHeader("Cache-Control", "no-store");
      const since = Number(new URL(req.url ?? "", "http://local").searchParams.get("since"));
      if (!Number.isFinite(since) || since <= 0) return json(res, 400, { error: "since must be a time in ms" });
      return json(res, 200, { files: lookForNotes(machine(), since) });
    }
    if (path === CHANNELS_CARRY_PATH) {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      if (!deps.local || auth.kind !== "loopback" || auth.trust === "service") return json(res, 403, { error: LOCAL_ONLY });
      const parsed = carrySchema.safeParse(await readBody(req, 8192));
      if (!parsed.success || !deps.connectChannel || !deps.botExists?.(parsed.data.botId)) return json(res, 400, { error: "send { ref, botId } for a bot that moved in" });
      const { ref, botId } = parsed.data;
      const here = machine();
      const found = lookForBots(here, { dataDir: deps.dataDir ?? DATA_DIR }).apps.some((app) => app.bots.some((bot) => bot.channelRef === ref));
      if (!found) return json(res, 404, { error: "That app's chat apps are no longer there." });
      const results = [];
      for (const link of channelLinks(here, ref)) {
        try {
          const status = await deps.connectChannel(botId, link.platform, link.token, link.allowed);
          results.push({ platform: link.platform, ok: true, handle: status.handle, ...(status.pairUrl ? { pairUrl: status.pairUrl } : {}), ...(status.pairCode ? { pairCode: status.pairCode } : {}) });
        } catch (error) {
          results.push({ platform: link.platform, ok: false, error: error instanceof Error ? error.message : "It could not be connected." });
        }
      }
      return json(res, 200, { channels: results });
    }
    if (path === GROK_LOOK_PATH || path === BOTS_LOOK_PATH) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      if (!deps.local || auth.kind !== "loopback" || auth.trust === "service") return json(res, 403, { error: LOCAL_ONLY });
      res.setHeader("Cache-Control", "no-store");
      const downloads = new URL(req.url ?? "", "http://local").searchParams.get("downloads") !== "0";
      return json(res, 200, path === GROK_LOOK_PATH ? lookForGrokBot(machine(), { downloads }) : lookForBots(machine(), { dataDir: deps.dataDir ?? DATA_DIR }));
    }
    if (path !== SETUP_IMPORT_PATH) return PASS;
    if (method !== "GET" && method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (!deps.local || auth.kind !== "loopback" || auth.trust === "service") return json(res, 403, { error: LOCAL_ONLY });
    res.setHeader("Cache-Control", "no-store");
    if (method === "GET") return json(res, 200, detectSetup(machine(), host));
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return json(res, 415, { error: "content-type must be application/json" });
    }
    const parsed = requestSchema.safeParse(await readBody(req, 4_096));
    if (!parsed.success || (!parsed.data.skills && !parsed.data.tools && !parsed.data.instructions && !parsed.data.memory)) {
      return json(res, 400, { error: "Choose skills, tools, instructions or memory." });
    }
    if (parsed.data.memory && (!parsed.data.memoryBot || !deps.botExists?.(parsed.data.memoryBot))) {
      return json(res, 400, { error: "Memory goes to one of your bots: memoryBot must name one." });
    }
    return json(res, 200, applySetupImport(machine(), host, parsed.data));
  };
}
