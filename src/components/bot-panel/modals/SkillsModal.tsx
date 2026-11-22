import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import { OrgSkillsCard } from "../../bot-settings/OrgSkillsCard";
import { SkillReviewSheet } from "../../bot-settings/SkillsSection";
import { Card, FormDialog, FormField, NavRow, NoteRow, rowCls, RowText, SheetPane, useSubPage } from "../../ListRows";
import { buttonCls } from "../rows";
import { RowIconButton, textFieldCls } from "../../ui/GrokDialog";
import { Toggle } from "../../ui/Toggle";
import { useSkillActions } from "./use-skill-actions";
import { ArtState } from "../../ui/Art";

/** The bot's skills: how many are on, opening the list of them (each switchable and removable), a small form to add one
 * from a link, and the ways to find more. */
export function SkillsModal({ bot }: { bot: Bot; onClose: () => void }) {
  return (
    <SheetPane data-panel-modal="skills" title={t("botPanel.ui.botSettingsSimpleSkills")}>
      <SkillRows bot={bot} />
    </SheetPane>
  );
}

function SkillRows({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const actions = useSkillActions(bot);
  const { skills, remove, browse } = actions;
  const { at, open } = useSubPage();
  const [adding, setAdding] = useState(false);
  const busy = Boolean(skills.working);
  const on = skills.skills.filter((skill) => skill.enabled).length;
  const notLoaded = skills.loadFailed && !skills.loading;
  const failedRows = (
    <>
      <NoteRow tone="warn" data-sheet-row="skills-load-failed">{t("botPanel.skills.loadFailed")}</NoteRow>
      <div className={rowCls}><button type="button" className={buttonCls} onClick={() => void skills.refresh()}>{t("botPanel.skills.retry")}</button></div>
    </>
  );
  const errorRow = notLoaded && !adding ? <Card>{failedRows}</Card>
    : skills.error && !skills.reviewing && !adding ? <Card><NoteRow tone="warn">{skills.error}</NoteRow></Card> : null;
  const review = (
    <SkillReviewSheet
      reviewing={skills.reviewing}
      error={skills.error}
      working={Boolean(skills.reviewing && skills.working === skills.reviewing.skill.name)}
      onCancel={() => skills.setReviewing(null)}
      onEnable={() => void skills.enableReviewed()}
    />
  );

  return (
    <>
      {at === "installed" ? (
        <>
          <Card data-sheet-group="installed">
            {skills.loading ? <NoteRow>{t("botPanel.ui.skillsLoading")}</NoteRow>
              : notLoaded ? failedRows
              : skills.skills.length === 0 ? <ArtState data-art-state="skills" art="cap" title={t("empty.skills.title")} className="py-6">{t("empty.skillsSheet.hint", { name: bot.name })}</ArtState>
                : skills.skills.map((skill) => (
                  <div key={skill.name} data-panel-row={`skill:${skill.name}`} className={cn(rowCls, "group/row")}>
                    <RowText title={skill.name} hint={skill.description || skill.source} />
                    <RowIconButton
                      reveal
                      icon="trash"
                      data-modal-action={`remove-skill:${skill.name}`}
                      label={t("botPanel.skills.remove", { name: skill.name })}
                      disabled={busy}
                      onClick={() => void remove(skill)}
                    />
                    <Toggle
                      checked={skill.enabled}
                      disabled={busy}
                      aria-label={t("botPanel.ui.botSettingsSimpleSkillToggle", { name: skill.name })}
                      onClick={() => void skills.toggle(skill)}
                    />
                  </div>
                ))}
          </Card>
          {!notLoaded && errorRow}
          <OrgSkillsCard bot={bot} onAdded={() => void skills.refresh()} />
        </>
      ) : (
        <>
          <Card data-sheet-group="skills">
            <NavRow
              data-sheet-row="installed"
              title={t("botPanel.ui.sheetRowsInstalled")}
              value={skills.loading ? t("botPanel.ui.skillsLoading") : notLoaded ? t("botPanel.skills.notLoaded") : skills.skills.length === 0 ? t("botPanel.sheet.noSkills") : t("botPanel.skills.on", { count: on })}
              onClick={() => open("installed", t("botPanel.ui.sheetRowsInstalled"))}
            />
            <NavRow data-sheet-row="add-skill" title={t("botPanel.ui.sheetRowsAddSkill")} onClick={() => setAdding(true)} />
          </Card>
          <Card label={t("botPanel.ui.sheetRowsFindMore")}>
            <NavRow data-panel-link="browse-skills" title={t("botPanel.skills.browse")} onClick={browse} />
            <NavRow data-panel-link="connect-apps" title={t("botPanel.ui.sheetRowsConnectApps")} onClick={() => dispatch({ type: "togglePlugins", open: true, surface: "apps" })} />
          </Card>
          {errorRow}
          <AnimatePresence>{adding && <AddSkillDialog key="add-skill-dialog" actions={actions} onClose={() => setAdding(false)} />}</AnimatePresence>
        </>
      )}
      {review}
    </>
  );
}

function AddSkillDialog({ actions, onClose }: { actions: ReturnType<typeof useSkillActions>; onClose: () => void }) {
  const { skills, source, setSource, importing, importSkill } = actions;
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (sent && !importing && !skills.error && source === "") onClose();
  }, [sent, importing, skills.error, source, onClose]);
  return (
    <FormDialog
      data-panel-modal="skill-import"
      title={t("botPanel.ui.sheetRowsAddSkill")}
      saveLabel={importing ? t("botPanel.ui.skillsImportImporting") : t("botPanel.ui.commonAdd")}
      canSave={Boolean(source.trim())}
      busy={importing}
      error={sent && skills.error ? skills.error : null}
      onSave={() => { setSent(true); return importSkill(); }}
      onClose={onClose}
      nativeForm={{
        fields: [{
          id: "source",
          label: t("botPanel.ui.skillsImportLabel"),
          value: source,
          placeholder: t("botPanel.skills.importPlaceholder"),
          kind: "url",
          required: true,
          autoFocus: true,
        }],
        onSubmit: (values) => importSkill(values.source ?? ""),
      }}
    >
      <FormField label={t("botPanel.ui.skillsImportLabel")}>
        <input
          data-autofocus
          data-panel-form="skill-import"
          value={source}
          placeholder={t("botPanel.skills.importPlaceholder")}
          aria-label={t("botPanel.ui.skillsImportLabel")}
          onChange={(event) => setSource(event.target.value)}
          className={textFieldCls}
        />
      </FormField>
    </FormDialog>
  );
}
