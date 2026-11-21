import type { ReactNode } from "react";

import { t } from "@/lib/i18n";
import { shortPath } from "@/lib/short-path";
import { useStore, type Bot } from "@/state/store";
import { useTeamName } from "../bot-access/ShareBotButton";
import { BotApiCard } from "../bot-settings/BotApiCard";
import { useManagedSkills } from "../bot-settings/SkillsSection";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { useDeleteAllThreads } from "../BotMenuDelete";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { SoulField } from "../SoulField";
import { LIMIT_MODES } from "../../../shared/wire";
import { radioArrows, RadioRow, SwitchRow } from "./rows";
import { BotConversations } from "./Conversations";
import { panelMemoryNotes } from "./memory-notes";
import type { SheetPage } from "./modals/panel-modal";
import { Card, NavRow } from "../ListRows";
import { useMemoryDoc } from "./use-memory-doc";
import { useSlackAvailable, useSlackBotState } from "../slack/use-slack";

type Derived = ReturnType<typeof useBotSettingsDerived>;

function useMemoryLine(bot: Bot): string {
  const memory = useMemoryDoc(bot);
  if (bot.memoryEnabled === false) return t("botPanel.memory.off");
  const notes = memory.docs ? panelMemoryNotes(memory.docs).length : 0;
  return notes === 0 ? t("botPanel.memory.nothingYet") : notes === 1 ? t("botPanel.memory.note") : t("botPanel.memory.notes", { count: notes });
}

/** The bot's settings as Grok-style list rows: what it knows, then what it can reach, each row opening its page of the
 * bot's settings in Settings (its Bots page); then its rare actions. The Advanced tab draws it; the model lives on Details. */
export function SettingsPage({ bot, onOpen, more }: {
  bot: Bot;
  derived?: Derived;
  onOpen?: (page: SheetPage) => void;
  /** rows that join the rest under More settings */
  more?: ReactNode;
}) {
  const { state, dispatch } = useStore();
  const skills = useManagedSkills(bot);
  const { capabilities } = useDesktopCapabilities();
  const memoryLine = useMemoryLine(bot);
  const clearThreads = useDeleteAllThreads(true);
  const team = useTeamName();
  const slackAvailable = useSlackAvailable();
  const slackState = useSlackBotState(bot.id);
  const slackValue = slackState ? t(({ online: "botPanel.ui.slackStateOnline", offline: "botPanel.ui.slackStateOffline", not_linked: "botPanel.ui.slackStateNotAdded", provisioned: "botPanel.ui.slackStateNeedsStep", installed: "botPanel.ui.slackStateNeedsStep", error: "botPanel.ui.slackStateProblem" } as const)[slackState]) : undefined;
  const open = (page: SheetPage) => () => onOpen?.(page);

  const skillsOn = skills.skills.filter((skill) => skill.enabled).length;
  // absent: the automatic backup; empty: Off; a list someone set: on, that list first
  const backupOn = bot.fallback === undefined || bot.fallback.length > 0;
  const engineCoordinates = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.capabilities?.agentsMcp;
  const editable = bot.yourAccess !== "view";

  return (
    <div data-panel-settings className="contents">
      <Card label={t("botPanel.section.thisBot")} anchor="uses">
        {/* grok's one-line rows: what it is on the left, its value on the right, as the Voice row is */}
        <NavRow data-panel-page="identity" title={t("botPanel.ui.botSettingsSectionsIdentity")} value={bot.title?.trim() || undefined} onClick={open("identity")} />
        <NavRow data-panel-page="instructions" title={t("botPanel.ui.botSettingsSimpleInstructions")} value={(bot.soul ?? "").trim() ? undefined : t("botPanel.none")} onClick={open("instructions")} />
        <NavRow data-panel-page="memory" title={t("botPanel.memoryRow")} value={memoryLine} onClick={open("memory")} />
        <NavRow data-panel-page="skills" title={t("botPanel.ui.botSettingsSimpleSkills")} value={skills.loading ? undefined : skills.loadFailed ? t("botPanel.skills.notLoaded") : skillsOn > 0 ? t("botPanel.skills.on", { count: skillsOn }) : t("botPanel.none")} onClick={open("skills")} />
        {slackAvailable && <NavRow data-panel-page="slack" title={t("slack.title")} value={slackValue} onClick={open("slack")} />}
      </Card>

      {/* where it works lives on the Computer tab */}
        <Card label={t("botPanel.ui.botSettingsSectionsAccess")} anchor="access">
          <NavRow data-panel-page="tools" title={t("botPanel.page.tools")} value={bot.toolScope !== undefined ? t("botPanel.tools.custom") : undefined} onClick={open("tools")} />
          <NavRow data-panel-page="permissions" title={t("botPanel.ui.botSettingsSectionsPermissions")} value={bot.chiefOfStaff ? t("botPanel.ui.permissionsChiefTitle") : undefined} onClick={open("permissions")} />
          <NavRow data-panel-page="folder" title={t("botPanel.page.folder")} value={bot.cwd ? shortPath(bot.cwd, capabilities.host?.homeDir) : t("botPanel.folder.private")} tooltip={bot.cwd ?? undefined} onClick={open("folder")} />
          <SwitchRow data-panel-row="backup-ai" color={bot.color} title={t("botPanel.backupAi")} label={t("botPanel.backupAi")}
            tooltip={backupOn ? t("botPanel.backupAi.on") : t("botPanel.backupAi.off")} checked={backupOn} disabled={!editable}
            onChange={() => dispatch({ type: "updateBot", botId: bot.id, patch: { fallback: backupOn ? [] : null } })} />
        </Card>

        {editable && (
          <Card label={t("botPanel.section.actions")} anchor="actions">
            {!team && (
              <NavRow
                data-panel-row="chief"
                drill={false}
                title={bot.chiefOfStaff ? t("botPanel.ui.sidebarBotRemoveChief") : t("botPanel.ui.sidebarBotMakeChief")}
                disabled={!bot.chiefOfStaff && engineCoordinates !== true}
                tooltip={!bot.chiefOfStaff && engineCoordinates !== true ? t("botPanel.ui.sidebarBotChiefNeedsEngine") : undefined}
                onClick={() => dispatch({ type: "updateBot", botId: bot.id, patch: { chiefOfStaff: !bot.chiefOfStaff } })}
              />
            )}
            <NavRow data-panel-row="duplicate" drill={false} title={t("botPanel.actions.duplicate")} onClick={() => dispatch({ type: "duplicateBot", botId: bot.id })} />
            <NavRow data-panel-row="delete-all" drill={false} danger title={t("botPanel.ui.taskDeleteAllConversations")} onClick={() => clearThreads.ask(bot.id)} />
          </Card>
        )}
        {more}
      {clearThreads.dialog}
    </div>
  );
}

/** Instructions on their own page: the bot's soul, saved as it is typed. */
export function InstructionsPage({ bot, derived }: { bot: Bot; derived: Derived }) {
  return (
    <Card>
      <div className="px-2 py-1.5">
        <SoulField
          bot={bot}
          onPatch={derived.patch}
          simple={{ label: t("botPanel.ui.botSettingsSimpleInstructions"), placeholder: t("botPanel.ui.botSettingsSimpleInstructionsPlaceholder", { name: bot.name }) }}
        />
      </div>
    </Card>
  );
}

const LIMIT_MODE_TEXT = {
  wait: { title: "botPanel.limitMode.wait", hint: "botPanel.limitMode.waitHint" },
  ask: { title: "botPanel.limitMode.ask", hint: "botPanel.limitMode.askHint" },
  free: { title: "botPanel.limitMode.free", hint: "botPanel.limitMode.freeHint" },
} as const;

/** "When the AI hits a limit": wait for the reset, ask, or the free model. */
export function LimitModeCard({ bot, derived }: { bot: Bot; derived: Derived }) {
  const mode = bot.limitMode ?? "wait";
  const editable = bot.yourAccess !== "view";
  return (
    <Card label={t("botPanel.limitMode.title")} anchor="limit-mode" data-sheet-group="limit-mode" footnote={t("botPanel.limitMode.hint")}>
      <div role="radiogroup" aria-label={t("botPanel.limitMode.title")} onKeyDown={radioArrows} className="contents">
        {LIMIT_MODES.map((choice) => (
          <RadioRow
            key={choice}
            data-panel-choice={`limit-${choice}`}
            title={t(LIMIT_MODE_TEXT[choice].title)}
            hint={t(LIMIT_MODE_TEXT[choice].hint)}
            checked={mode === choice}
            tabIndex={mode === choice ? 0 : -1}
            disabled={!editable}
            onClick={() => { if (mode !== choice) derived.patch({ limitMode: choice }); }}
          />
        ))}
      </div>
    </Card>
  );
}

export function BackupsPage({ bot, derived }: { bot: Bot; derived: Derived }) {
  return <LimitModeCard bot={bot} derived={derived} />;
}

export function ThreadsPage({ bot }: { bot: Bot }) {
  return <BotConversations bot={bot} />;
}

export function ApiPage({ bot }: { bot: Bot }) {
  return <BotApiCard bot={bot} webhooksLink />;
}
