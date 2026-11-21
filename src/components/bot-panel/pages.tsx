import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { FolderOpen, Plus } from "../../icons";

import { appSwitchPatch } from "@/lib/bot-app-access";
import { t } from "@/lib/i18n";
import { shortPath } from "@/lib/short-path";
import { useStore, type Bot } from "@/state/store";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { ServiceIcon } from "../ServiceIcon";
import { ArtState } from "../ui/Art";
import { useWorkingFolder } from "../bot-settings/AccessSection";
import { SkillReviewSheet } from "../bot-settings/SkillsSection";
import { useBotApps, type BotApp } from "../bot-settings/useBotApps";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { BotRoutines } from "../routines/BotRoutines";
import { BrowserLogins } from "./browser-logins";
import { useOpenComputer, WherePage } from "./ComputerTab";
import { ApiPage, BackupsPage, InstructionsPage, SettingsPage, ThreadsPage } from "./SettingsPage";
import { LibraryPage } from "./LibraryTab";
import { FilesPage } from "../documents/FilesSection";
import { DocumentPage } from "../documents/DocumentPage";
import type { SimplePageId } from "./page-registry";
import { BotSwitch, buttonCls, Card, fieldCls, LinkRow, NoteRow, RadioRow, rowCls, SwitchRow, TextRow, TrashButton } from "./rows";
import { ForgetUndoToast } from "./modals/MemoryModal";
import { useMemoryEditor } from "./modals/use-memory-editor";
import { useSkillActions } from "./modals/use-skill-actions";

type Derived = ReturnType<typeof useBotSettingsDerived>;

export interface PageContext {
  bot: Bot;
  derived: Derived;
}

export const pageSurfaceCls = "flex flex-col gap-3";

export function AppsPage({ bot, derived }: PageContext) {
  const { dispatch } = useStore();
  const apps = useBotApps(bot);
  const { patch, canUseConnectedApps } = derived;

  const toggle = (app: BotApp) => {
    const next = appSwitchPatch(bot, apps.connectedSlugs, app.slug, app.scope === null);
    if (Object.keys(next).length > 0) patch(next);
  };
  const note = !canUseConnectedApps
    ? t("botSettings.simple.appsCannot", { name: bot.name })
    : apps.phase === "loading"
      ? t("botPanel.ui.commonChecking")
      : apps.phase === "unknown"
        ? t("botSettings.simple.appsUnknown")
        : null;
  const none = canUseConnectedApps && apps.phase !== "loading" && apps.phase !== "unknown" && apps.apps.length === 0;

  return (
    <>
      <Card>
        {note && <NoteRow>{note}</NoteRow>}
        {none && <ArtState data-art-state="apps" art="plug" title={t("empty.apps.title")} className="py-6">{t("empty.apps.hint", { name: bot.name })}</ArtState>}
        {canUseConnectedApps && apps.apps.map((app) => (
          <div key={app.slug} data-simple-app={app.slug} className={rowCls}>
            <ServiceIcon key={`${app.card.logo}:${app.card.domain}`} card={app.card} className="size-7 shrink-0" />
            <div className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{app.label}</div>
            <BotSwitch
              color={bot.color}
              checked={app.scope !== null}
              aria-label={t("botSettings.simple.appToggle", { name: bot.name, app: app.label })}
              disabled={Boolean(bot.busy)}
              onClick={() => toggle(app)}
              className="disabled:cursor-not-allowed"
            />
          </div>
        ))}
      </Card>
      <Card>
        <LinkRow
          data-panel-link="add-app"
          icon={Plus}
          onClick={() => {
            dispatch({ type: "togglePlugins", open: true, surface: "apps" });
          }}
        >
          {t("botPanel.apps.connectAnother")}
        </LinkRow>
      </Card>
    </>
  );
}

export function RoutinesPage({ bot }: PageContext) {
  return <BotRoutines bot={bot} label={false} />;
}

export function MemoryPage({ bot }: PageContext) {
  const editor = useMemoryEditor(bot);
  const { memoryOn, readError, notes, index, draft, setDraft, saving, error, forget, add } = editor;

  return (
    <>
      <Card>
        {!memoryOn ? (
          <NoteRow>{t("botPanel.library.memoryOff", { name: bot.name })}</NoteRow>
        ) : readError ? (
          <NoteRow tone="warn">{t("botPanel.library.memoryError")}</NoteRow>
        ) : notes === null ? (
          <NoteRow>{t("botPanel.ui.commonChecking")}</NoteRow>
        ) : notes.length === 0 ? (
          <ArtState data-art-state="memory" art="notebook" title={t("empty.memory.title")} className="py-6">{t("empty.memory.hint", { name: bot.name })}</ArtState>
        ) : notes.map((note) => (
          <div key={`${note.path}:${note.line}:${note.text}`} data-memory-note={note.line ?? note.path} className={rowCls}>
            <div className="min-w-0 flex-1 text-[13px] leading-[1.45] text-ink">{note.text}</div>
            <TrashButton label={t("botPanel.memory.forget")} disabled={saving} onClick={() => forget(note)} />
          </div>
        ))}
        {error && <NoteRow tone="warn">{error}</NoteRow>}
      </Card>
      {memoryOn && (
        <Card>
          <TextRow
            data-panel-form="memory-add"
            value={draft}
            placeholder={t("botPanel.memory.addPlaceholder", { name: bot.name })}
            label={t("botPanel.memory.addPlaceholder", { name: bot.name })}
            action={t("botPanel.ui.commonAdd")}
            disabled={saving || index === null}
            onChange={setDraft}
            onSubmit={() => void add()}
          />
        </Card>
      )}
      <ForgetUndoToast editor={editor} />
    </>
  );
}

export function SkillsPage({ bot }: PageContext) {
  const { skills, source, setSource, importing, remove, importSkill, browse } = useSkillActions(bot);

  return (
    <>
      <Card>
        {skills.loading ? (
          <NoteRow>{t("botPanel.ui.skillsLoading")}</NoteRow>
        ) : skills.skills.length === 0 ? (
          <ArtState data-art-state="skills" art="cap" title={t("empty.skills.title")} className="py-6">{t("empty.skills.hint", { name: bot.name })}</ArtState>
        ) : skills.skills.map((skill) => (
          <SwitchRow
            key={skill.name}
            data-panel-row={`skill:${skill.name}`}
            title={skill.name}
            hint={skill.description || skill.source}
            label={t("botPanel.ui.botSettingsSimpleSkillToggle", { name: skill.name })}
            color={bot.color}
            checked={skill.enabled}
            disabled={Boolean(skills.working)}
            onChange={() => void skills.toggle(skill)}
            extra={<TrashButton data-panel-action={`remove-skill:${skill.name}`} label={t("botPanel.skills.remove", { name: skill.name })} disabled={Boolean(skills.working)} onClick={() => void remove(skill)} />}
          />
        ))}
        {skills.error && !skills.reviewing && <NoteRow tone="warn">{skills.error}</NoteRow>}
      </Card>
      <Card>
        <TextRow
          data-panel-form="skill-import"
          value={source}
          placeholder={t("botPanel.skills.importPlaceholder")}
          label={t("botPanel.ui.skillsImportLabel")}
          action={importing ? t("botPanel.ui.skillsImportImporting") : t("botPanel.ui.commonAdd")}
          disabled={importing}
          onChange={setSource}
          onSubmit={() => void importSkill()}
        />
        <LinkRow data-panel-link="browse-skills" onClick={browse}>{t("botPanel.skills.browse")}</LinkRow>
      </Card>
      <SkillReviewSheet
        reviewing={skills.reviewing}
        error={skills.error}
        working={Boolean(skills.reviewing && skills.working === skills.reviewing.skill.name)}
        onCancel={() => skills.setReviewing(null)}
        onEnable={() => void skills.enableReviewed()}
      />
    </>
  );
}

export function FolderPage({ bot }: PageContext) {
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host?.homeDir;
  const { draft, setDraft, error, saving, canPick, save, pick } = useWorkingFolder(bot);
  const [choosing, setChoosing] = useState(false);
  const chosen = Boolean(bot.cwd) || choosing;

  const choose = () => {
    if (canPick) {
      void pick();
      return;
    }
    setChoosing(true);
  };

  return (
    <>
      <Card>
        <RadioRow
          data-panel-choice="private"
          title={t("botPanel.folder.own")}
          hint={t("botPanel.folder.ownHint")}
          checked={!chosen}
          disabled={saving}
          onClick={() => {
            setChoosing(false);
            if (bot.cwd) void save(null);
          }}
        />
        <RadioRow
          data-panel-choice="pick"
          title={t("botPanel.folder.pick")}
          hint={t("botPanel.folder.pickHint")}
          checked={chosen}
          disabled={saving}
          onClick={() => { if (!bot.cwd) choose(); }}
        />
      </Card>
      {chosen && (
        <Card>
          {canPick ? (
            <div className={rowCls}>
              <div className="min-w-0 flex-1 truncate px-0.5 font-mono text-[13px] leading-[18px] text-ink" title={bot.cwd}>
                {bot.cwd ? shortPath(bot.cwd, home) : <span className="text-ink-secondary">{t("botPanel.ui.botAccessFolderPrivate")}</span>}
              </div>
              <button type="button" data-panel-action="pick-folder" disabled={saving} onClick={() => void pick()} className={buttonCls}>
                <FolderOpen size={14} aria-hidden="true" />
                {t("botPanel.ui.botAccessFolderChoose")}
              </button>
            </div>
          ) : (
            <form
              data-panel-form="folder-path"
              className={rowCls}
              onSubmit={(event) => {
                event.preventDefault();
                const path = (draft ?? bot.cwd ?? "").trim();
                if (path) void save(path);
              }}
            >
              <input
                value={draft ?? bot.cwd ?? ""}
                placeholder={t("botPanel.ui.botAccessFolderPlaceholder")}
                aria-label={t("botPanel.ui.botAccessFolderTitle")}
                onChange={(event) => setDraft(event.target.value)}
                className={cn(fieldCls, "font-mono")}
              />
              <button type="submit" disabled={saving || draft === null} className={buttonCls}>{t("botPanel.ui.botAccessFolderSave")}</button>
            </form>
          )}
          {error && <NoteRow tone="warn">{error}</NoteRow>}
        </Card>
      )}
    </>
  );
}

export function BrowserPage({ bot, derived }: PageContext) {
  const openComputer = useOpenComputer(bot);
  return <BrowserLogins bot={bot} browserEnabled={derived.browserEnabled} onOpenBrowser={() => openComputer("browser")} />;
}

export function PageBody({ page, onOpen, editingInstructions: _editing, onEditInstructions: _onEdit, ...context }: PageContext & {
  page: SimplePageId;
  onOpen?: (page: SimplePageId) => void;
  editingInstructions?: boolean;
  onEditInstructions?: (open: boolean) => void;
}): ReactNode {
  switch (page) {
    case "settings":
      return <SettingsPage {...context} />;
    case "where":
      return <WherePage {...context} />;
    case "apps":
      return <AppsPage {...context} />;
    case "routines":
      return <RoutinesPage {...context} />;
    case "memory":
      return <MemoryPage {...context} />;
    case "skills":
      return <SkillsPage {...context} />;
    case "folder":
      return <FolderPage {...context} />;
    case "browser":
      return <BrowserPage {...context} />;
    case "instructions":
      return <InstructionsPage {...context} />;
    case "backups":
      return <BackupsPage {...context} />;
    case "threads":
      return <ThreadsPage {...context} />;
    case "api":
      return <ApiPage {...context} />;
    case "library":
      return <LibraryPage bot={context.bot} />;
    case "files":
      return <FilesPage bot={context.bot} onOpen={onOpen ?? (() => {})} />;
    case "document":
      return <DocumentPage bot={context.bot} />;
  }
}
