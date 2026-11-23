// Read-only dry run of "bring what you already use" and "Move from Grok Bot" against this computer's real home: what
// each tool would bring, in counts and kinds only. Writes nothing (dusk bot's data folder is pointed at a throwaway one), uploads nothing,
// prints no names, text or values. Run: node --experimental-strip-types scripts/import-dry-run.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DUSK_DATA_DIR = mkdtempSync(join(tmpdir(), "dusk-dry-run-"));
const { lookForBots } = await import("../server/bot-move-local.ts");
const { detectSetup, thisMachine } = await import("../server/setup-import.ts");
const { grokMovePlan } = await import("../shared/grok-import.ts");
const { moveFrom } = await import("../shared/bot-move.ts");
const { lookForGrokBot, readGrokChat, readGrokPhoto, readGrokProfile } = await import("../server/grok-local.ts");
const { GROK_FROM } = await import("../shared/grok-import.ts");

const machine = thisMachine();
const look = lookForBots(machine);
const rows: Record<string, Record<string, number>> = {};
const add = (tool: string, key: string, n: number) => { (rows[tool] ??= {})[key] = (rows[tool]![key] ?? 0) + n; };
// the same bot kept in two apps comes over once, as the copy with the most in it (src/lib/bot-move.ts)
const weight = (bot: (typeof look.apps)[number]["bots"][number]) => bot.instructions.length + 400 * bot.skills.length
  + 200 * (bot.memories.length + bot.userFacts.length) + 300 * bot.routines.length + Object.values(bot.memoryFiles ?? {}).reduce((sum, text) => sum + text.length, 0);
const best = new Map<string, unknown>();
for (const bot of look.apps.flatMap((app) => app.bots)) {
  const key = bot.name.trim().toLowerCase();
  const held = best.get(key) as typeof bot | undefined;
  if (!held || weight(bot) > weight(held)) best.set(key, bot);
}
for (const app of look.apps) {
  for (const bot of app.bots) {
    if (best.get(bot.name.trim().toLowerCase()) !== bot) {
      add(app.app, "sameBotKeptFromAnotherApp", 1);
      continue;
    }
    const plan = grokMovePlan(bot, { timeZone: "UTC", from: moveFrom(app) });
    add(app.app, "bots", 1);
    add(app.app, "memories", plan.memories);
    add(app.app, "aboutMeFacts", plan.facts.length);
    add(app.app, "skills", plan.skills.length);
    add(app.app, "routines", plan.routines);
    add(app.app, "appsToReconnect", plan.apps);
    add(app.app, "personaChars", bot.instructions.length);
    add(app.app, "forEngineChunks", plan.distill.length);
    add(app.app, "noiseDropped", plan.dropped);
  }
  add(app.app, "channels", app.channels.length);
  add(app.app, "unreadableFiles", app.unreadable.length);
}
const host = { mcpServers: () => ({}), mcpPolicyRefusal: () => undefined, persistMcpServers: () => { throw new Error("dry run"); }, mcpConfigBusy: { get: () => false, set: () => {} } };
const setup = detectSetup(machine, host);
for (const skill of setup.skills) add(`setup:${skill.source}`, "skills", 1);
for (const tool of setup.tools) add(`setup:${tool.source}`, "mcpServers", 1);
for (const file of setup.instructions ?? []) add(`setup:${file.source}`, "instructionFiles", 1);
const grok = readGrokProfile(machine);
if (grok.found) {
  const live = grok.bots.filter((bot) => !bot.removed);
  add("grokBot", "rosterBots", grok.bots.length);
  add("grokBot", "removedOrHidden", grok.bots.length - live.length);
  add("grokBot", "wouldMove", live.length);
  add("grokBot", "sameNameTwice", live.length - new Set(live.map((bot) => bot.name.toLowerCase())).size);
  add("grokBot", "connectedAppNames", grok.apps.length);
  for (const problem of grok.problems) add("grokBot", `problem:${problem.slice}:${problem.code}`, 1);
  for (const bot of live) {
    add("grokBot", "withDescription", bot.description.trim() ? 1 : 0);
    const photo = readGrokPhoto(machine, grok, bot);
    add("grokBot", photo && "bytes" in photo ? "pictures" : photo ? `problem:photo:${photo.problem.code}` : "noPicture", 1);
    const chat = readGrokChat(machine, grok, bot.rosterId);
    if (chat && "problem" in chat) add("grokBot", `problem:chat:${chat.problem.code}`, 1);
    else if (chat) {
      add("grokBot", "chatMessages", chat.lines.length);
      add("grokBot", "placeholderLines", chat.lines.filter((line) => line.placeholder).length);
      add("grokBot", "chatsWithEarlierHistory", chat.earlier ? 1 : 0);
      add("grokBot", "routineNames", chat.routines.length);
      add("grokBot", "appsUsed", chat.appsUsed.length);
    }
  }
}
const downloads = lookForGrokBot(machine).exports;
for (const file of downloads) {
  if (file.refused) add("grokBotExports", `refused:${file.refused.code}`, 1);
  for (const bot of file.bots ?? []) {
    const plan = grokMovePlan(bot, { timeZone: "UTC", from: GROK_FROM, exactZones: true, appNamesOnly: true });
    add("grokBotExports", "bots", 1);
    add("grokBotExports", "memories", bot.memories.length);
    add("grokBotExports", "skills", plan.skills.length);
    add("grokBotExports", "routinesPaused", plan.routines);
    add("grokBotExports", "routinesToSet", plan.routineNotes.length);
  }
}
console.log(JSON.stringify(rows, null, 2));
