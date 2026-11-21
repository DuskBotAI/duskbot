import { t } from "@/lib/i18n";
import { addTemplate } from "@/lib/template-add";
import { api, type Action, type Bot } from "@/state/store";
import type { LocaleKey } from "@/locales";
import { takeImportName } from "../../shared/import-name";
import { factsTopic, GrokImportError, grokMovePlan, mergeGrokBots, parseGrokExport, type GrokBot, type GrokMovePlan, type MoveFrom } from "../../shared/grok-import";

/** What the desktop app found on this computer. */
export interface GrokLook {
  files: Array<{ name: string; modifiedAt: number; text: string }>;
  bots: string[];
}

/** A refusal or an unreadable reply, in the person's words. */
export function grokErrorText(cause: unknown): string {
  if (!(cause instanceof GrokImportError)) return cause instanceof Error ? cause.message : String(cause);
  return t(`grokMove.error.${cause.code}` as LocaleKey, { keys: cause.keys.join(", ") });
}

export interface FoundExports {
  bots: GrokBot[];
  refused: Array<{ file: string; error: string }>;
}

/** Every file found, joined by Bot: a split export comes together and a saved-twice one counts once. A refused file says
 * why and costs the others nothing. Oldest first, so the newest copy wins. */
export function foundExports(files: GrokLook["files"]): FoundExports {
  const refused: FoundExports["refused"] = [];
  const bots = [...files].sort((a, b) => a.modifiedAt - b.modifiedAt).flatMap((file) => {
    try {
      return parseGrokExport(file.text);
    } catch (cause) {
      refused.push({ file: file.name, error: grokErrorText(cause) });
      return [];
    }
  });
  return { bots: mergeGrokBots(bots), refused };
}

export interface GrokPreview {
  /** `addedAs`: the Bot's name here, numbered when it is taken. `channelRef`: its old app's chat-app bots, which the
   * server connects again once it lands. */
  plans: Array<GrokMovePlan & { addedAs: string; channelRef?: string }>;
  moved: string[];
  unreadable: string[];
}

export interface GrokPreviewFacts {
  bots: readonly Pick<Bot, "name" | "installedPackage">[];
  servers: ReadonlySet<string>;
  timeZone: string;
  /** Another app than Grok Bot. */
  from?: MoveFrom;
}

/** The whole plan, nothing written. A Bot already moved or that can't be read is named, and costs the others nothing. */
export function previewGrokMove(bots: readonly GrokBot[], facts: GrokPreviewFacts, names = new Set(facts.bots.map((bot) => bot.name.trim().toLowerCase())),
  servers = new Set(facts.servers), planned = new Set<string>()): GrokPreview {
  const installed = new Set(facts.bots.flatMap((bot) => bot.installedPackage?.id ?? []));
  const preview: GrokPreview = { plans: [], moved: [], unreadable: [] };
  for (const bot of bots) {
    try {
      const plan = grokMovePlan(bot, { timeZone: facts.timeZone, takenServers: servers, ...(facts.from ? { from: facts.from } : {}) });
      if (installed.has(plan.packageId)) {
        preview.moved.push(plan.name);
        continue;
      }
      if (planned.has(plan.packageId)) continue;
      planned.add(plan.packageId);
      for (const connection of plan.document.package.connections ?? []) servers.add(connection.key);
      preview.plans.push({ ...plan, addedAs: takeImportName(plan.name, names), ...(bot.channelRef ? { channelRef: bot.channelRef } : {}) });
    } catch {
      preview.unreadable.push(bot.name);
    }
  }
  return preview;
}

export interface GrokMovedBot {
  id: string;
  name: string;
  /** The sidebar section the import made for it. */
  section?: string;
  skills: number;
  /** Skills left off: the skill scan flagged them, or they could not be switched on. */
  skillsOff: string[];
  routines: number;
  notes: number;
  memories: number;
  apps: number;
  /** Facts about the person it knew: in About me, or its own memory when About me couldn't take them. */
  facts: number;
}

/** Adds facts about the person to About me, each once; resolves false when it couldn't. */
export type SaveFacts = (facts: readonly string[], from: string) => Promise<boolean>;

export interface GrokReport {
  bots: GrokMovedBot[];
  moved: string[];
  unreadable: string[];
  failed: string[];
}

/** Imports each plan through the package path, then switches on its skills. One Bot failing is named and the rest carry on. */
export async function runGrokMove(preview: GrokPreview, dispatch: (action: Action) => void, onBot?: (plan: GrokPreview["plans"][number]) => void,
  saveFacts?: SaveFacts): Promise<GrokReport> {
  const report: GrokReport = { bots: [], moved: preview.moved, unreadable: preview.unreadable, failed: [] };
  for (const plan of preview.plans) {
    onBot?.(plan);
    try {
      const added = await addTemplate(plan.document, dispatch);
      if (added.alreadyAdded) {
        report.moved.push(plan.name);
        continue;
      }
      const bot = added.first;
      if (!bot) throw new Error("no bot");
      const skillsOff: string[] = [];
      for (const skill of plan.skills) {
        const on = skill.on && await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.folder)}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) }).then(() => true, () => false);
        if (!on) skillsOff.push(skill.name);
      }
      const from = plan.document.package.author.name;
      if (plan.facts.length && !(saveFacts && await saveFacts(plan.facts, from).catch(() => false))) {
        // About me couldn't take them: the bot keeps them, so nothing it knew is lost
        await api(`/api/bots/${encodeURIComponent(bot.id)}/memory/file`, { method: "PUT", body: JSON.stringify({ path: "memory/about-you.md", text: factsTopic(plan.facts, { name: from, key: "" }) }) }).catch(() => {});
      }
      // passages and the overflow of its memory: its own engine condenses them into notes, now or once it has one
      if (plan.distill.length) {
        await api(`/api/bots/${encodeURIComponent(bot.id)}/memory/import-distill`, { method: "POST", body: JSON.stringify({ from, chunks: plan.distill.slice(0, 10) }) }).catch(() => {});
      }
      if (plan.channelRef) {
        await api("/api/setup-import/channels", { method: "POST", body: JSON.stringify({ ref: plan.channelRef, botId: bot.id }) }).catch(() => {});
      }
      report.bots.push({ id: bot.id, name: bot.name, ...(bot.section ? { section: bot.section } : {}), skills: plan.skills.length, skillsOff, routines: plan.routines, notes: plan.notes, memories: plan.memories, apps: plan.apps, facts: plan.facts.length });
    } catch {
      report.failed.push(plan.name);
    }
  }
  return report;
}
