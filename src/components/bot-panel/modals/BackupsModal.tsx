import { useRef } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { shortModelLabel } from "@/lib/model-friendly";
import { modelName, providerName } from "@/lib/simple-model-menu";
import { phoneApp } from "@/lib/store-app";
import { useStore, type Bot } from "@/state/store";
import { Icon } from "../../Icon";
import { InstanceProviderMark } from "../../ProviderIcons";
import type { useBotSettingsDerived } from "../../bot-settings/useBotSettingsDerived";
import { Card, NoteRow, rowCls, SheetPane } from "../../ListRows";
import { RowIconButton } from "../../ui/GrokDialog";
import { BackupChooser, MAX_BACKUPS, modelKey, type Backup } from "../BackupAis";
import { LimitModeCard } from "../SettingsPage";

const chooserRowCls = cn(rowCls, "min-w-0 flex-1 cursor-pointer text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:cursor-default");
const textCls = "text-[13px] leading-[18px] tracking-[0.015em]";

/** The bot's backup AIs as an ordered list under its own: change one, move it up or down, remove it, add another. */
export function BackupsModal({ bot, derived }: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
  onClose: () => void;
}) {
  const { state } = useStore();
  const chain = bot.fallback ?? [];
  const addRef = useRef<HTMLButtonElement>(null);
  const editable = bot.yourAccess !== "view";
  const onChange = (fallback: Backup[]) => derived.patch({ fallback });
  const others = (except: number | null) => new Set([bot.modelSelection, ...chain.filter((_, index) => index !== except)]
    .map((entry) => modelKey(entry.instanceId, entry.model)));
  const describe = (entry: Backup) => {
    const instance = state.instances.find((candidate) => candidate.instanceId === entry.instanceId);
    const option = instance?.models.options.find((candidate) => candidate.id === entry.model);
    const name = modelName(instance, entry.model);
    return { instance, name, short: instance && option ? shortModelLabel(option.label, providerName(instance)) : name };
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= chain.length) return;
    const next = [...chain];
    const [entry] = next.splice(from, 1);
    next.splice(to, 0, entry!);
    onChange(next);
  };
  const main = describe(bot.modelSelection);

  const mark = (instance: ReturnType<typeof describe>["instance"]) => instance
    ? <InstanceProviderMark instance={instance} size={16} />
    : <span className="size-4 shrink-0 rounded-full bg-ink/8" aria-hidden="true" />;

  return (
    <SheetPane data-panel-modal="backups" title={t("botPanel.backups.title")}>
      <Card label={t("botPanel.sheet.mainAi")} data-sheet-group="main">
        <div data-backup-main title={t("botPanel.backups.hint", { name: bot.name })} className={rowCls}>
          {mark(main.instance)}
          <span className={cn(textCls, "min-w-0 flex-1 truncate text-ink")}>{main.short}</span>
          {main.instance && <span className={cn(textCls, "min-w-0 max-w-[50%] shrink-0 truncate text-ink-secondary")}>{main.instance.displayName}</span>}
        </div>
      </Card>

      <Card
        label={t("botPanel.sheet.backups")}
        data-sheet-group="backups"
        footnote={chain.length >= MAX_BACKUPS ? t("sheet.rows.backupsFull") : t("botPanel.sheet.backupsHint")}
      >
        {chain.length === 0 && !(editable && chain.length < MAX_BACKUPS) && <NoteRow>{t("botPanel.sheet.noBackups")}</NoteRow>}
        {chain.length > 0 && (
          <ol aria-label={t("botPanel.backups.title")} className="m-0 flex list-none flex-col p-0">
            {chain.map((entry, index) => {
              const { instance, name, short } = describe(entry);
              return (
                <li key={modelKey(entry.instanceId, entry.model)} data-backup={entry.instanceId} className="group/row flex items-center rounded-lg has-[>button:first-child:hover]:bg-ink/[0.035] has-[>button[aria-expanded=true]]:bg-ink/[0.035]">
                  <BackupChooser
                    bot={bot}
                    current={entry}
                    exclude={others(index)}
                    onPick={(picked) => onChange(chain.map((candidate, at) => (at === index ? picked : candidate)))}
                    label={t("botPanel.backups.row", { position: index + 1, model: name })}
                    title={instance ? `${instance.displayName}: ${name}` : name}
                    data-panel-action="backup-change"
                    className={chooserRowCls}
                  >
                    <span className="w-3 shrink-0 text-center text-[12px] tabular-nums text-ink-tertiary" aria-hidden="true">{index + 1}</span>
                    {mark(instance)}
                    <span className={cn(textCls, "min-w-0 flex-1 truncate text-ink")}>{short}</span>
                    {instance
                      ? <span className={cn(textCls, "min-w-0 max-w-[45%] shrink-0 truncate text-ink-secondary")}>{instance.displayName}</span>
                      : <span className="shrink-0 text-[12px] text-warning">{t("botPanel.ui.modelSimpleUnavailable")}</span>}
                    <span aria-hidden="true" className="flex shrink-0 text-ink-tertiary"><Icon name={phoneApp() ? "chevron-right" : "chevron-down-small"} size={14} /></span>
                  </BackupChooser>
                  {editable && (
                    <span className="flex shrink-0 items-center pr-0.5">
                      {chain.length > 1 && (
                        <>
                          <RowIconButton reveal icon="arrow-up" data-modal-action="backup-up" label={`Move ${name} up`} disabled={index === 0} onClick={() => move(index, index - 1)} />
                          <RowIconButton reveal icon="arrow-down" data-modal-action="backup-down" label={`Move ${name} down`} disabled={index === chain.length - 1} onClick={() => move(index, index + 1)} />
                        </>
                      )}
                      <RowIconButton
                        reveal
                        icon="trash"
                        data-modal-action="backup-remove"
                        label={t("botPanel.backups.remove", { model: name })}
                        onClick={() => {
                          onChange(chain.filter((_, at) => at !== index));
                          addRef.current?.focus({ preventScroll: true });
                        }}
                      />
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {editable && chain.length < MAX_BACKUPS && (
          <BackupChooser
            bot={bot}
            current={null}
            exclude={others(null)}
            onPick={(picked) => onChange([...chain, picked])}
            label={t("botPanel.ui.modelFallbackAdd")}
            buttonRef={addRef}
            data-panel-action="backup-add"
            className={cn(chooserRowCls, "flex-none hover:bg-ink/[0.035] aria-expanded:bg-ink/[0.035]")}
          >
            <span className={cn(textCls, "min-w-0 flex-1 text-ink")}>{t("botPanel.ui.modelFallbackAdd")}</span>
            <span aria-hidden="true" className="flex shrink-0 text-ink-tertiary"><Icon name={phoneApp() ? "chevron-right" : "chevron-down-small"} size={14} /></span>
          </BackupChooser>
        )}
      </Card>

      <LimitModeCard bot={bot} derived={derived} />
    </SheetPane>
  );
}
