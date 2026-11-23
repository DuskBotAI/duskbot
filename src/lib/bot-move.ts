import { api, type Action, type Bot } from "@/state/store";
import { moveFrom, readBotLook, EMPTY_LOOK, type BotLook } from "../../shared/bot-move";
import type { GrokBot, MoveFrom } from "../../shared/grok-import";
import { previewGrokMove, runGrokMove, type GrokPreview, type GrokReport, type SaveFacts } from "./grok-move";

export const BOTS_LOOK_TIME_BOX_MS = 2_500;

/** What this computer holds: other apps' bots. Grok Bot's move is its own (grok-bot-move.ts). */
export interface BotMoveLook {
  bots: BotLook;
}

export const NOTHING: BotMoveLook = { bots: EMPTY_LOOK };

/** Settles within `ms`: a slow or failed look reads as nothing found, never as an error in the way. */
export async function lookForOtherBots(ms = BOTS_LOOK_TIME_BOX_MS): Promise<BotMoveLook> {
  const bots = await api<unknown>("/api/setup-import/bots", { signal: AbortSignal.timeout(ms), timeoutMs: ms }).then(readBotLook, () => EMPTY_LOOK);
  return { bots };
}

export interface AppMove {
  app: string;
  where: string;
  from: MoveFrom;
  preview: GrokPreview;
  channels: string[];
  /** Files there that could not be read. */
  unreadable: string[];
}

export interface BotMovePlan {
  apps: AppMove[];
}

/** The same bot kept in two apps (one persona run in both Hermes Agent and OpenClaw, say) comes over once: the copy
 * with the most in it (its persona, skills, memory, routines). */
function oneBotPerName(apps: BotMoveLook["bots"]["apps"]): Set<GrokBot> {
  const weight = (bot: GrokBot) => bot.instructions.length + 400 * bot.skills.length + 200 * (bot.memories.length + bot.userFacts.length)
    + 300 * bot.routines.length + Object.values(bot.memoryFiles ?? {}).reduce((sum, text) => sum + text.length, 0);
  const best = new Map<string, GrokBot>();
  for (const bot of apps.flatMap((app) => app.bots)) {
    const key = bot.name.trim().toLowerCase();
    const held = best.get(key);
    if (!held || weight(bot) > weight(held)) best.set(key, bot);
  }
  return new Set(best.values());
}

/** Everything that would come over, nothing written. Names are numbered against bots here and each other; a bot moved
 * before is named as already here. */
export function planBotMove(look: BotMoveLook, facts: { bots: readonly Pick<Bot, "name" | "installedPackage">[]; servers: ReadonlySet<string>; timeZone: string }): BotMovePlan {
  const names = new Set(facts.bots.map((bot) => bot.name.trim().toLowerCase()));
  const servers = new Set(facts.servers);
  const planned = new Set<string>();
  const kept = oneBotPerName(look.bots.apps);
  const apps: AppMove[] = look.bots.apps.map((found) => {
    const from = moveFrom(found);
    return { app: found.app, where: found.where, from, channels: found.channels, unreadable: found.unreadable,
      preview: previewGrokMove(found.bots.filter((bot) => kept.has(bot)), { ...facts, from }, names, servers, planned) };
  });
  return { apps: apps.filter((app) => app.preview.plans.length || app.preview.moved.length || app.preview.unreadable.length) };
}

export const movable = (plan: BotMovePlan) => plan.apps.reduce((total, app) => total + app.preview.plans.length, 0);

export interface MoveCounts { bots: number; skills: number; routines: number; memories: number; facts?: number; apps?: number }

export function planCounts(app: AppMove): MoveCounts {
  const facts = new Set(app.preview.plans.flatMap((plan) => plan.facts.map((fact) => fact.replace(/\s+/g, " ").toLowerCase())));
  return app.preview.plans.reduce((sum, plan) => ({
    ...sum, bots: sum.bots + 1, skills: sum.skills + plan.skills.length, routines: sum.routines + plan.routines, memories: sum.memories + plan.memories + plan.notes,
    apps: (sum.apps ?? 0) + plan.apps,
  }), { bots: 0, skills: 0, routines: 0, memories: 0, facts: facts.size, apps: 0 });
}

/** One section named after the app for its bots, in place of the one each import made; a failure leaves them where
 * they landed. */
async function groupUnder(name: string, bots: GrokReport["bots"], dispatch: (action: Action) => void): Promise<void> {
  if (!bots.length) return;
  try {
    const moved = await api<{ bots?: Bot[] }>("/api/sidebar-sections", { method: "POST", body: JSON.stringify({ name, botIds: bots.map((bot) => bot.id) }) });
    for (const bot of moved.bots ?? []) dispatch({ type: "botPatched", bot });
    for (const section of new Set(bots.flatMap((bot) => (bot.section && bot.section !== name ? [bot.section] : [])))) {
      const left = await api<{ sections: string[] }>(`/api/sidebar-sections?section=${encodeURIComponent(section)}`, { method: "DELETE" });
      dispatch({ type: "sectionDeleted", section, sections: left.sections });
    }
  } catch {
    // grouping is tidiness only
  }
}

export interface AppReport { app: AppMove; report: GrokReport }

/** Moves app by app, bot by bot; one that fails is named and the rest carry on. `onBot` hears each as it starts. Each
 * app's bots end up together in one sidebar section named after it. */
export async function runBotMove(plan: BotMovePlan, dispatch: (action: Action) => void, onBot?: (done: number, name: string) => void,
  saveFacts?: SaveFacts): Promise<AppReport[]> {
  const out: AppReport[] = [];
  let done = 0;
  for (const app of plan.apps) {
    if (!app.preview.plans.length) {
      out.push({ app, report: { bots: [], moved: app.preview.moved, unreadable: app.preview.unreadable, failed: [] } });
      continue;
    }
    const report = await runGrokMove(app.preview, dispatch, (bot) => onBot?.(done++, bot.addedAs), saveFacts);
    await groupUnder(app.app, report.bots, dispatch);
    out.push({ app, report });
  }
  return out;
}
