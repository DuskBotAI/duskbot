import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";

import { t } from "@/lib/i18n";
import { shortPath } from "@/lib/short-path";
import type { Bot } from "@/state/store";
import { useDesktopCapabilities } from "../../DesktopCapabilities";
import { useWorkingFolder } from "../../bot-settings/AccessSection";
import { Card, CheckRow, FormDialog, FormField, NoteRow, SheetPane } from "../../ListRows";
import { textFieldCls } from "../../ui/GrokDialog";

/** Where the bot keeps and edits files: its own private folder, or one the person picks (typed in a small form where
 * there is no folder picker). */
export function FolderModal({ bot }: { bot: Bot; onClose: () => void }) {
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host?.homeDir;
  const { error, saving, canPick, save, pick } = useWorkingFolder(bot);
  const [typing, setTyping] = useState(false);
  const editable = bot.yourAccess !== "view";

  return (
    <SheetPane data-panel-modal="folder" title={t("botPanel.page.folder")}>
      <Card data-sheet-group="folder">
        <div role="radiogroup" aria-label={t("botPanel.page.folder")} className="contents">
          <CheckRow
            role="radio"
            data-panel-choice="private"
            title={t("botPanel.folder.own")}
            hint={t("botPanel.folder.ownHint")}
            checked={!bot.cwd}
            disabled={saving || !editable}
            onClick={() => { if (bot.cwd) void save(null); }}
          />
          <CheckRow
            role="radio"
            data-panel-choice="pick"
            title={t("botPanel.folder.pick")}
            hint={bot.cwd ? <span data-folder-path title={bot.cwd}>{shortPath(bot.cwd, home)}</span> : t("botPanel.folder.pickHint")}
            checked={Boolean(bot.cwd)}
            disabled={saving || !editable}
            onClick={() => (canPick ? void pick() : setTyping(true))}
          />
        </div>
        {error && !typing && <NoteRow tone="warn">{error}</NoteRow>}
      </Card>
      <AnimatePresence>{typing && (
        <FolderPathDialog key="folder-path-dialog"
          title={t("botPanel.ui.botAccessFolderTitle")}
          initial={bot.cwd ?? ""}
          saving={saving}
          error={error}
          onSave={(path) => save(path)}
          onClose={() => setTyping(false)}
        />
      )}</AnimatePresence>
    </SheetPane>
  );
}

/** A folder typed in as a path, for a computer without a folder picker. It closes once the folder is saved. */
export function FolderPathDialog({ title, initial, saving, error, onSave, onClose }: {
  title: string;
  initial: string;
  saving: boolean;
  error: string | null;
  onSave: (path: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [path, setPath] = useState(initial);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (sent && !saving && !error) onClose();
  }, [sent, saving, error, onClose]);
  return (
    <FormDialog
      data-panel-modal="folder-path"
      title={title}
      canSave={Boolean(path.trim()) && path.trim() !== initial}
      busy={saving}
      error={sent ? error : null}
      onSave={() => { setSent(true); return onSave(path.trim()); }}
      onClose={onClose}
      nativeForm={{
        fields: [{
          id: "path",
          label: t("botPanel.ui.botAccessFolderTitle"),
          value: initial,
          placeholder: t("botPanel.ui.botAccessFolderPlaceholder"),
          kind: "text",
          monospaced: true,
          required: true,
          autoFocus: true,
        }],
        onSubmit: async (values) => {
          const trimmed = (values.path ?? "").trim();
          if (!trimmed || trimmed === initial) return null;
          const result = await onSave(trimmed);
          return typeof result === "string" ? result : null;
        },
      }}
    >
      <FormField label={t("botPanel.ui.botAccessFolderTitle")}>
        <input
          data-autofocus
          data-panel-form="folder-path"
          dir="auto"
          value={path}
          placeholder={t("botPanel.ui.botAccessFolderPlaceholder")}
          aria-label={title}
          onChange={(event) => setPath(event.target.value)}
          className={`${textFieldCls} font-mono text-[12px]`}
        />
      </FormField>
    </FormDialog>
  );
}
