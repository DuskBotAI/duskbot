import { offersSignIn } from "@/components/EngineSetup";
import { t } from "@/lib/i18n";
import { failurePreviewLine } from "@/lib/failed-reply";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import { failedTurnCause } from "../../shared/failed-turn";
import { toolStepLabel } from "@/lib/tool-step-label";
import { isClientCancellation, isStoppedTurnName } from "../../shared/client-cancel";

export const STATUS_MARKER = /^(?:recovery|notice):\s*/;

export { failedTurnCause };

type ActivityTool = NonNullable<Message["tool"]>;

export function engineSignedOut(engine: InstanceInfo | undefined): boolean {
  return Boolean(engine?.snapshot) && offersSignIn(engine);
}

export function signedOutEngine(tool: ActivityTool, engine: InstanceInfo | undefined): InstanceInfo | undefined {
  return tool.setup && !tool.claudeUpdate && engineSignedOut(engine) ? engine : undefined;
}

export function claudeUpdateTarget(engine: InstanceInfo | undefined): InstanceInfo | undefined {
  return engine?.driverKind === "claudeAgent" && !engine.readOnly ? engine : undefined;
}

type Backup = { instanceId: string; model: string };

/** The bot's AI when it is signed out and no backup that is signed in would take the turn instead. */
export function signedOutWithoutBackup(bot: Bot, instances: InstanceInfo[], recovery?: { enabled: boolean; backup?: Backup }): InstanceInfo | undefined {
  const engine = botEngine(bot, instances);
  if (!engineSignedOut(engine)) return undefined;
  const backups = bot.fallback?.length ? bot.fallback : recovery?.enabled && recovery.backup ? [recovery.backup] : [];
  const answers = (backup: Backup) => {
    const instance = instances.find((candidate) => candidate.instanceId === backup.instanceId);
    return instance?.snapshot.state === "available" && instance.snapshot.authenticated !== false;
  };
  return backups.some(answers) ? undefined : engine;
}

export function botEngine(bot: Bot | undefined, instances: InstanceInfo[]): InstanceInfo | undefined {
  return bot && instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
}

export function activityPreview(tool: ActivityTool, engine: InstanceInfo | undefined, dataResult?: Message["dataResult"]): string {
  if (dataResult) return dataResult.title;
  if (isStoppedTurnName(tool.name)) return t("chat.turnStopped");
  const cause = failedTurnCause(tool.name);
  if (cause !== null && isClientCancellation(cause)) return t("chat.turnStopped");
  if (cause !== null && tool.partial) return t("chat.error.partialPreview");
  if (cause !== null && tool.reason === "timeout") return t("failedReply.timeout");
  if (cause === null) return STATUS_MARKER.test(tool.name) ? tool.name.replace(STATUS_MARKER, "") : toolStepLabel(tool);
  return failurePreviewLine(tool, engine);
}
