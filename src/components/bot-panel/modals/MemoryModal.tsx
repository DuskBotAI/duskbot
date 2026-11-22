import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import type { useBotSettingsDerived } from "../../bot-settings/useBotSettingsDerived";
import { Card, FormDialog, FormField, NavRow, NoteRow, rowCls, SheetPane, SwitchRow, useSubPage } from "../../ListRows";
import { RowIconButton, textAreaCls } from "../../ui/GrokDialog";
import { DELETE_UNDO_MS } from "../../ui/Toast";
import { UndoToast } from "../../bot-access/ShareBotButton";
import { useMemoryEditor } from "./use-memory-editor";
import { ArtState } from "../../ui/Art";

/** "Note forgotten · Undo" after a Forget, held while the pointer or focus is on it. */
export function ForgetUndoToast({ editor }: { editor: Pick<ReturnType<typeof useMemoryEditor>, "forgotten" | "settleForgotten"> }) {
  const { forgotten, settleForgotten } = editor;
  if (!forgotten) return null;
  return <UndoToast key={forgotten.id} text={t("botPanel.memory.forgotten")} failedText={t("botPanel.memory.undoFailed")}
    timeoutMs={DELETE_UNDO_MS} onUndo={forgotten.restore} onDone={settleForgotten} />;
}

/** What the bot remembers: memory on or off, its notes on a page of their own with a forget on each, and a small form to
 * add one. */
export function MemoryModal({ bot, derived }: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
  onClose: () => void;
}) {
  return (
    <SheetPane data-panel-modal="memory" title={t("botPanel.memoryRow")}>
      <MemoryRows bot={bot} derived={derived} />
    </SheetPane>
  );
}

function MemoryRows({ bot, derived }: { bot: Bot; derived: ReturnType<typeof useBotSettingsDerived> }) {
  const editor = useMemoryEditor(bot);
  const { memoryOn, readError, notes, index, saving, error, forget } = editor;
  const { at, open } = useSubPage();
  const [adding, setAdding] = useState(false);
  const editable = bot.yourAccess !== "view";
  const count = notes?.length ?? 0;
  const value = readError ? t("botPanel.library.memoryError") : notes === null ? t("botPanel.ui.commonChecking")
    : count === 0 ? t("botPanel.sheet.noNotes") : count === 1 ? t("botPanel.memory.note") : t("botPanel.memory.notes", { count });

  if (at === "notes") {
    return (
      <>
        <Card data-sheet-group="notes">
          {readError ? <NoteRow tone="warn">{t("botPanel.library.memoryError")}</NoteRow>
            : notes === null ? <NoteRow>{t("botPanel.ui.commonChecking")}</NoteRow>
              : notes.length === 0 ? <ArtState data-art-state="memory" art="notebook" title={t("empty.memory.title")} className="py-6">{t("empty.memory.hint", { name: bot.name })}</ArtState>
                : notes.map((note) => (
                  <div key={`${note.path}:${note.line}:${note.text}`} data-memory-note={note.line ?? note.path} className={cn(rowCls, "group/row py-0.5 pr-0.5")}>
                    <span className="min-w-0 flex-1 py-1 text-[13px] leading-[18px] tracking-[0.015em] text-pretty text-ink">{note.text}</span>
                    {editable && <RowIconButton reveal icon="trash" data-modal-action="forget" label={t("botPanel.memory.forget")} disabled={saving} onClick={() => forget(note)} />}
                  </div>
                ))}
          {error && <NoteRow tone="warn">{error}</NoteRow>}
        </Card>
        {editable && (
          <Card>
            <NavRow data-sheet-row="add-note" disabled={index === null} title={t("botPanel.ui.sheetRowsAddNote")} onClick={() => setAdding(true)} />
          </Card>
        )}
        <AnimatePresence>{adding && <AddNoteDialog key="add-note-dialog" bot={bot} editor={editor} onClose={() => setAdding(false)} />}</AnimatePresence>
        <ForgetUndoToast editor={editor} />
      </>
    );
  }

  return (
    <>
      <Card data-sheet-group="memory">
        <SwitchRow
          title={t("botPanel.ui.memoryEnable")}
          hint={memoryOn ? t("botPanel.sheet.memoryOn") : t("botPanel.sheet.off")}
          checked={memoryOn}
          disabled={Boolean(bot.busy) || !editable}
          onChange={() => derived.patch({ memoryEnabled: !memoryOn })}
        />
        {memoryOn && <NavRow data-sheet-row="notes" title={t("botPanel.ui.sheetRowsNotes")} value={value} onClick={() => open("notes", t("botPanel.ui.sheetRowsNotes"))} />}
        {memoryOn && editable && <NavRow data-sheet-row="add-note" disabled={index === null} title={t("botPanel.ui.sheetRowsAddNote")} onClick={() => setAdding(true)} />}
      </Card>
      {error && <Card><NoteRow tone="warn">{error}</NoteRow></Card>}
      <AnimatePresence>{adding && <AddNoteDialog key="add-note-dialog" bot={bot} editor={editor} onClose={() => setAdding(false)} />}</AnimatePresence>
    </>
  );
}

function AddNoteDialog({ bot, editor, onClose }: { bot: Bot; editor: ReturnType<typeof useMemoryEditor>; onClose: () => void }) {
  const { draft, setDraft, saving, error, add } = editor;
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (sent && !saving && !error && draft === "") onClose();
  }, [sent, saving, error, draft, onClose]);
  return (
    <FormDialog
      data-panel-modal="memory-add"
      title={t("botPanel.ui.sheetRowsAddNote")}
      saveLabel={t("botPanel.ui.commonAdd")}
      canSave={Boolean(draft.trim())}
      busy={saving}
      error={sent ? error : null}
      onSave={() => { setSent(true); return add(); }}
      onClose={onClose}
      nativeForm={{
        fields: [{
          id: "note",
          label: t("botPanel.memory.addPlaceholder", { name: bot.name }),
          value: draft,
          kind: "multiline",
          required: true,
          autoFocus: true,
        }],
        onSubmit: (values) => add(values.note ?? ""),
      }}
    >
      <FormField label={t("botPanel.memory.addPlaceholder", { name: bot.name })}>
        <textarea
          data-autofocus
          data-panel-form="memory-add"
          rows={3}
          value={draft}
          aria-label={t("botPanel.memory.addPlaceholder", { name: bot.name })}
          onChange={(event) => setDraft(event.target.value)}
          className={textAreaCls}
        />
      </FormField>
    </FormDialog>
  );
}
