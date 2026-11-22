import { useState } from "react";
import { AnimatePresence } from "motion/react";

import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { BOT_PROFILE_LIMITS } from "../../../../shared/bot-profile";
import { PackageProvenance } from "../../bot-settings/PackageProvenance";
import type { useBotSettingsDerived } from "../../bot-settings/useBotSettingsDerived";
import { showDefaultBot } from "../../DefaultBotControls";
import { Card, FormDialog, FormField, NavRow, SheetPane } from "../../ListRows";
import { textAreaCls, textFieldCls } from "../../ui/GrokDialog";
import { PermissionsSheet } from "./PermissionsSheet";
import { ToolsSheet } from "./ToolsSheet";
import { SlackBotPage } from "../../slack/SlackBotPage";

type Derived = ReturnType<typeof useBotSettingsDerived>;

export function ToolsModal({ bot, derived }: { bot: Bot; derived: Derived; onClose: () => void }) {
  return (
    <SheetPane data-panel-modal="tools" title={t("botPanel.page.tools")}>
      <ToolsSheet bot={bot} derived={derived} />
    </SheetPane>
  );
}

export function PermissionsModal({ bot, derived }: { bot: Bot; derived: Derived; onClose: () => void }) {
  return (
    <SheetPane data-panel-modal="permissions" title={t("botPanel.ui.botSettingsSectionsPermissions")}>
      <PermissionsSheet bot={bot} derived={derived} />
    </SheetPane>
  );
}

type ProfileField = "name" | "title" | "description";

export function IdentityModal({ bot, derived }: { bot: Bot; derived: Derived; onClose: () => void }) {
  const { dispatch } = useStore();
  const [editing, setEditing] = useState<ProfileField | null>(null);
  const editable = bot.yourAccess !== "view";
  const rows: { field: ProfileField; title: string; value: string }[] = [
    { field: "name", title: t("botPanel.ui.botSettingsIdentityName"), value: bot.name },
    { field: "title", title: t("botPanel.ui.botSettingsIdentityTitle"), value: bot.title?.trim() || t("botPanel.none") },
    { field: "description", title: t("botPanel.sheet.blurb"), value: bot.description?.trim() || t("botPanel.none") },
  ];
  return (
    <SheetPane data-panel-modal="identity" title={t("botPanel.ui.botSettingsSectionsIdentity")}>
      <Card label={t("botPanel.sheet.profile")} data-sheet-group="profile">
        {rows.map((row) => (
          <NavRow key={row.field} data-sheet-row={row.field} disabled={!editable} title={row.title} value={row.value} onClick={() => setEditing(row.field)} />
        ))}
      </Card>
      {bot.defaultBot && !bot.sidebarHidden && (
        <Card>
          <NavRow drill={false} data-sheet-row="default-bot-hide" title={t("botPanel.ui.defaultBotHide")} onClick={() => showDefaultBot(dispatch, bot, false)} />
        </Card>
      )}
      <PackageProvenance bot={bot} rows />
      <AnimatePresence>{editing && <ProfileDialog key="profile-dialog" bot={bot} focus={editing} onSave={(patch) => { derived.patch(patch); setEditing(null); }} onClose={() => setEditing(null)} />}</AnimatePresence>
    </SheetPane>
  );
}

function ProfileDialog({ bot, focus, onSave, onClose }: {
  bot: Bot;
  focus: ProfileField;
  onSave: (patch: Partial<Pick<Bot, ProfileField>>) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title ?? "");
  const [description, setDescription] = useState(bot.description ?? "");
  const patch: Partial<Pick<Bot, ProfileField>> = {};
  if (name.trim() && name !== bot.name) patch.name = name;
  if (title !== (bot.title ?? "")) patch.title = title;
  if (description !== (bot.description ?? "")) patch.description = description;
  return (
    <FormDialog
      data-panel-modal="identity-form"
      title={t("botPanel.sheet.profile")}
      canSave={Boolean(name.trim()) && Object.keys(patch).length > 0}
      onSave={() => onSave(patch)}
      onClose={onClose}
      nativeForm={{
        fields: [
          {
            id: "name",
            label: t("botPanel.ui.botSettingsIdentityName"),
            value: bot.name,
            required: true,
            maxLength: BOT_PROFILE_LIMITS.name,
            autoFocus: focus === "name",
          },
          {
            id: "title",
            label: t("botPanel.ui.botSettingsIdentityTitle"),
            value: bot.title ?? "",
            placeholder: t("botPanel.ui.botSettingsIdentityTitlePlaceholder"),
            maxLength: BOT_PROFILE_LIMITS.title,
            autoFocus: focus === "title",
          },
          {
            id: "description",
            label: t("botPanel.sheet.blurb"),
            value: bot.description ?? "",
            placeholder: t("botPanel.sheet.blurbHint"),
            kind: "multiline",
            maxLength: BOT_PROFILE_LIMITS.description,
            autoFocus: focus === "description",
          },
        ],
        onSaved: (values) => {
          const nextName = values.name ?? "";
          const nextTitle = values.title ?? "";
          const nextDescription = values.description ?? "";
          const nextPatch: Partial<Pick<Bot, ProfileField>> = {};
          if (nextName.trim() && nextName !== bot.name) nextPatch.name = nextName;
          if (nextTitle !== (bot.title ?? "")) nextPatch.title = nextTitle;
          if (nextDescription !== (bot.description ?? "")) nextPatch.description = nextDescription;
          if (Object.keys(nextPatch).length > 0) onSave(nextPatch);
        },
      }}
    >
      <FormField label={t("botPanel.ui.botSettingsIdentityName")}>
        <input data-autofocus={focus === "name" || undefined} aria-label={t("botPanel.ui.botSettingsIdentityName")} maxLength={BOT_PROFILE_LIMITS.name} value={name} onChange={(event) => setName(event.target.value)} className={textFieldCls} />
      </FormField>
      <FormField label={t("botPanel.ui.botSettingsIdentityTitle")}>
        <input
          data-autofocus={focus === "title" || undefined}
          aria-label={t("botPanel.ui.botSettingsIdentityTitle")}
          maxLength={BOT_PROFILE_LIMITS.title}
          placeholder={t("botPanel.ui.botSettingsIdentityTitlePlaceholder")}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className={textFieldCls}
        />
      </FormField>
      <FormField label={t("botPanel.sheet.blurb")}>
        <textarea
          data-autofocus={focus === "description" || undefined}
          aria-label={t("botPanel.ui.botSettingsIdentityBlurb")}
          rows={3}
          maxLength={BOT_PROFILE_LIMITS.description}
          placeholder={t("botPanel.sheet.blurbHint")}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className={textAreaCls}
        />
      </FormField>
    </FormDialog>
  );
}

export function SlackModal({ bot }: { bot: Bot; onClose: () => void }) {
  return (
    <SheetPane data-panel-modal="slack" title={t("botPanel.page.slack")}>
      <div data-bot-settings-section="slack" className="contents">
        <SlackBotPage bot={bot} />
      </div>
    </SheetPane>
  );
}
