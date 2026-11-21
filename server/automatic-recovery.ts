import type { ProviderAdapter } from "./contracts.ts";
import { supportsWorkspaceFiles } from "./workspace.ts";
import type { ModelSelection } from "../shared/wire.ts";
import { backupOrder } from "../shared/ai-ranking.ts";
import { readyToRun, type DefaultSelectionContext, type SelectableInstance } from "./default-model-selection.ts";

type Engine = { driverKind: string; capabilities: ProviderAdapter["capabilities"] };
type Backup = Pick<ModelSelection, "instanceId" | "model">;

/** The backups a bot's turn tries, in order, when its AI provably never started it: the bot's own list, which needs no
 * switch, or else the installation's one backup while Automatic recovery is on. */
export function startupBackups(bot: { fallback?: Backup[] }, recovery?: { enabled: boolean; backup?: Backup }): Backup[] {
  if (bot.fallback?.length) return bot.fallback;
  return recovery?.enabled && recovery.backup ? [recovery.backup] : [];
}

/** An automatic switch must not strand the task without its tools or its files: an AI that works in the bot's folder
 * is never carried on by a chat-only one, while a chat-only AI may be carried on by one that has the folder. A USB
 * phone is not one of those tools: only Codex and Pi drive one, Claude offers it on every desktop, and no Cloud has a
 * USB port, so counting it left a limited Claude bot with no backup but those two. */
export function recoveryCapabilityError(from: Engine, to: Engine): string | undefined {
  if (supportsWorkspaceFiles(from.driverKind) && !supportsWorkspaceFiles(to.driverKind)) {
    return "The backup cannot use the same workspace.";
  }
  const tools = ["agentsMcp", "computerMcp", "composioMcp", "dataMcp", "emailMcp", "deviceMcp",
    "browserMcp", "localComputerMcp", "customMcp", "images"] as const;
  if (tools.some(key => from.capabilities[key] === true && to.capabilities[key] !== true)) {
    return "The backup does not support all of this AI's tools and attachments.";
  }
}

/** A bot that chose no backup (`fallback` absent) is carried on by the other AIs the person already has working, best
 * first: the same kind of AI first, then the shared ranking, OpenCode's free backup last. A bot set to No backup
 * (`fallback: []`) or with its own list gets none of these. */
export function automaticBackups(bot: { fallback?: unknown[] }, engines: readonly SelectableInstance[], from: Pick<ModelSelection, "instanceId">, context: DefaultSelectionContext = {}): Backup[] {
  if (bot.fallback !== undefined) return [];
  const working = engines.filter((engine) => engine.instanceId !== from.instanceId && !engine.found && readyToRun(engine, context)
    && engine.snapshot.authenticated !== false && engine.models.default.trim());
  return backupOrder(working, engines.find((engine) => engine.instanceId === from.instanceId)?.driverKind)
    .map((engine) => ({ instanceId: engine.instanceId, model: engine.models.default }));
}
