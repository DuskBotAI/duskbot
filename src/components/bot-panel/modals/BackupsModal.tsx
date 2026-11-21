import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import type { useBotSettingsDerived } from "../../bot-settings/useBotSettingsDerived";
import { Card, SheetPane } from "../../ListRows";
import { SwitchRow } from "../rows";
import { LimitModeCard } from "../SettingsPage";

/** Whether another AI the person has connected carries the bot on (the server picks which, in its own order), and what
 * the bot does at a limit. Absent `fallback`: on; empty: off; a list set before stays and counts as on. */
export function BackupsModal({ bot, derived }: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
  onClose: () => void;
}) {
  const backupOn = bot.fallback === undefined || bot.fallback.length > 0;
  return (
    <SheetPane data-panel-modal="backups" title={t("botPanel.backups.title")}>
      <Card data-sheet-group="backups">
        <SwitchRow data-panel-row="backup-ai" color={bot.color} title={t("botPanel.backupAi")} label={t("botPanel.backupAi")}
          hint={backupOn ? t("botPanel.backupAi.on") : t("botPanel.backupAi.off")} checked={backupOn} disabled={bot.yourAccess === "view"}
          onChange={() => derived.patch({ fallback: backupOn ? [] : null })} />
      </Card>
      <LimitModeCard bot={bot} derived={derived} />
    </SheetPane>
  );
}
