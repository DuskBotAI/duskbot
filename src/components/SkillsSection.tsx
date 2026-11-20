// Security: local browse only, with no registry and no network fetch, so an import is exactly the bytes pasted here.
import { ModalLayer } from "./ui/ModalLayer";
import { AnimatePresence } from "motion/react";
import { Search, X } from "../icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { useStore } from "@/state/store";
import { Switch } from "./SettingsPrimitives";
import { Card as RowsCard, FormDialog, ItemRow, NavRow, NoteRow, rowCls } from "./ListRows";
import { textFieldCls } from "./ui/GrokDialog";
import { SettingsSelect } from "./SettingsSelect";
import { cn } from "@/lib/cn";
import type { SkillsLibrarySkillWire } from "../../shared/wire";
import { friendlyError } from "@/lib/plain-error";
import { ArtState } from "./ui/Art";

export function filterLibrarySkills(
  skills: readonly SkillsLibrarySkillWire[],
  query: string,
  tag: string | null,
): SkillsLibrarySkillWire[] {
  const q = query.trim().toLowerCase();
  return skills.filter((skill) => {
    if (tag && !skill.tags.includes(tag)) return false;
    if (!q) return true;
    return [skill.name, skill.description, skill.source].some((part) => part.toLowerCase().includes(q));
  });
}

export function LibrarySkillMeta({ skill }: { skill: SkillsLibrarySkillWire }) {
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 text-[12px] leading-4 text-ink-secondary">
      <span className="truncate" title={skill.source}>Source: {skill.source}</span>
      <span>· {skill.version ? t("skills.library.version", { version: skill.version }) : t("skills.library.noVersion")}</span>
      <span>· {t("skills.library.importedAt", { date: new Date(skill.importedAt).toLocaleDateString() })}</span>
      {skill.tags.map((tag) => <span key={tag}>· {tag}</span>)}
    </span>
  );
}

export function SkillsSection() {
  const { state } = useStore();
  const [skills, setSkills] = useState<SkillsLibrarySkillWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ skill: SkillsLibrarySkillWire; text: string; review: boolean } | null>(null);
  const [working, setWorking] = useState("");
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [assignBot, setAssignBot] = useState("");
  const busy = useRef(false);
  const [importOpen, setImportOpen] = useState(false);

  const bots = state.bots.filter((bot) => !bot.hidden);
  const tags = useMemo(
    () => [...new Set(skills.flatMap((skill) => skill.tags))].sort((a, b) => a.localeCompare(b)),
    [skills],
  );
  const visible = filterLibrarySkills(skills, query, activeTag);

  const refresh = async (cancelled?: () => boolean) => {
    try {
      const response = await fetch("/api/skills-library");
      const body = (await response.json()) as { skills?: SkillsLibrarySkillWire[]; error?: string };
      // a server without the library reads as an empty one, not as a red server message beside "no skills yet"
      if (response.status === 404) { if (!cancelled?.()) { setSkills([]); setError(""); } return; }
      if (!response.ok) throw new Error(body.error ?? t("skills.library.loadError"));
      if (cancelled?.()) return;
      setSkills(body.skills ?? []);
      setError("");
    } catch (cause) {
      if (!cancelled?.()) setError(friendlyError(cause, t("skills.library.loadError")));
    } finally {
      if (!cancelled?.()) setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  const putAssignments = async (botId: string, name: string, remove: boolean) => {
    if (busy.current) return;
    busy.current = true;
    const label = `${name}:${botId}`;
    setWorking(label);
    setError("");
    try {
      // Read the complete current list while mutations are serialized, so a second row never overwrites an earlier
      // assignment.
      const listing = await fetch("/api/skills-library");
      const listed = (await listing.json()) as { skills?: SkillsLibrarySkillWire[]; error?: string };
      if (!listing.ok) throw new Error(listed.error ?? t("skills.library.loadError"));
      const current = (listed.skills ?? []).filter((skill) => skill.assignedBots.some((bot) => bot.id === botId)).map((skill) => skill.name);
      const next = remove ? current.filter((skill) => skill !== name) : [...new Set([...current, name])];
      const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/skills-library`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skills: next }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not update assignments.");
      await refresh();
    } catch (cause) {
      setError(friendlyError(cause, "Could not update assignments."));
    } finally {
      busy.current = false;
      setWorking("");
    }
  };

  const assign = async (skill: SkillsLibrarySkillWire) => {
    if (!assignBot) return;
    await putAssignments(assignBot, skill.name, false);
  };

  const unassign = async (skill: SkillsLibrarySkillWire, botId: string) => {
    await putAssignments(botId, skill.name, true);
  };

  const toggle = async (skill: SkillsLibrarySkillWire, reviewed = false) => {
    if (busy.current) return;
    if (!skill.enabled && !reviewed) return view(skill, true);
    busy.current = true;
    setWorking(skill.name);
    setError("");
    try {
      const response = await fetch(`/api/skills-library/${encodeURIComponent(skill.name)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !skill.enabled }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not update this skill.");
      if (reviewed) setViewing(null);
      await refresh();
    } catch (cause) {
      setError(friendlyError(cause, "Could not update this skill."));
    } finally {
      busy.current = false;
      setWorking("");
    }
  };

  const toggleEveryBot = async (skill: SkillsLibrarySkillWire) => {
    if (busy.current) return;
    busy.current = true;
    setWorking(skill.name);
    setError("");
    try {
      const response = await fetch(`/api/skills-library/${encodeURIComponent(skill.name)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ everyBot: !skill.everyBot }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not update this skill.");
      await refresh();
    } catch (cause) {
      setError(friendlyError(cause, "Could not update this skill."));
    } finally {
      busy.current = false;
      setWorking("");
    }
  };

  const view = async (skill: SkillsLibrarySkillWire, review = false) => {
    setError("");
    try {
      const response = await fetch(`/api/skills-library/${encodeURIComponent(skill.name)}`);
      const body = (await response.json()) as { text?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load this skill.");
      if (!body.text) throw new Error("The skill contents are unavailable; import it again.");
      setViewing({ skill, text: body.text, review });
    } catch (cause) {
      setError(friendlyError(cause, "Could not load this skill."));
    }
  };

  const importSkill = async () => {
    const text = importText.trim();
    if (!text) return;
    setImporting(true);
    setError("");
    setImportMessage("");
    try {
      const response = await fetch("/api/skills-library", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const body = (await response.json()) as { skill?: { name: string }; error?: string };
      if (!response.ok) throw new Error(body.error ?? "could not import that skill.");
      setImportMessage(t("skills.library.imported", { name: body.skill?.name ?? "" }));
      setImportText("");
      setImportOpen(false);
      await refresh();
    } catch (cause) {
      setError(friendlyError(cause, "could not import that skill."));
    } finally {
      setImporting(false);
    }
  };

  const pill = (on: boolean) => cn("h-[26px] cursor-pointer rounded-full px-2.5 text-[12px] leading-4", on ? "bg-ink/[0.06] text-ink" : "text-ink-secondary hover:text-ink");
  const locked = Boolean(working || importing);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="relative">
          <Search size={13} aria-hidden="true" className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-ink-secondary" />
          <input
            className={cn(textFieldCls, "h-[30px] ps-8")}
            placeholder={t("skills.library.searchPlaceholder")}
            aria-label={t("skills.library.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-0.5">
            <button type="button" onClick={() => setActiveTag(null)} className={pill(activeTag === null)}>{t("skills.library.allTags")}</button>
            {tags.map((tag) => (
              <button key={tag} type="button" onClick={() => setActiveTag(activeTag === tag ? null : tag)} className={pill(activeTag === tag)}>{tag}</button>
            ))}
          </div>
        )}
      </div>

      <RowsCard label={t("skills.library.title")} footnote={t("skills.library.subtitle")} data-settings-block="skills-library">
        {loading ? <NoteRow>{t("skills.library.loading")}</NoteRow>
          : skills.length === 0 ? <ArtState data-art-state="skills-library" art="cap" title={t("empty.skills.title")} className="py-6">{t("empty.skillsLibrary.hint")}</ArtState>
          : visible.length === 0 ? <NoteRow>{t("skills.library.noMatches")}</NoteRow>
          : visible.map((skill) => (
            <div key={skill.name} className="contents">
              <div className={cn(rowCls, "items-start hover:bg-ink/[0.035]")}>
                <button type="button" onClick={() => void view(skill)} className="min-w-0 flex-1 cursor-pointer text-left" aria-label={t("skills.library.view", { skill: skill.name })}>
                  <span className="block truncate text-[13px] leading-[18px] text-ink">{skill.name}</span>
                  <span className="line-clamp-2 block text-[12px] leading-4 text-ink-secondary">{skill.description}</span>
                  <LibrarySkillMeta skill={skill} />
                  {skill.warnings.length > 0 && <span className="block text-[12px] leading-4 text-warning">{skill.warnings.join(" · ")}</span>}
                </button>
                <Switch
                  checked={skill.enabled}
                  aria-label={skill.enabled ? t("skills.library.disable", { skill: skill.name }) : t("skills.library.enable", { skill: skill.name })}
                  disabled={locked}
                  onClick={() => void toggle(skill)}
                />
              </div>
              <ItemRow title={t("skills.library.everyBot")} hint={t("skills.library.everyBotHint")}>
                <Switch checked={skill.everyBot} aria-label={t("skills.library.everyBot")} disabled={locked} onClick={() => void toggleEveryBot(skill)} />
              </ItemRow>
              {skill.assignedBots.length === 0 ? <NoteRow>{t("skills.library.notAssigned")}</NoteRow> : skill.assignedBots.map((bot) => (
                <ItemRow key={bot.id} title={bot.name}>
                  <button type="button" aria-label={t("skills.library.removeAssignment", { bot: bot.name })} title={t("skills.library.removeAssignment", { bot: bot.name })}
                    disabled={locked} onClick={() => void unassign(skill, bot.id)}
                    className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-secondary hover:bg-ink/[0.035] hover:text-danger disabled:opacity-45">
                    <X size={13} aria-hidden="true" />
                  </button>
                </ItemRow>
              ))}
              {bots.length > 0 && (
                <ItemRow title={t("skills.library.assignLabel")}>
                  <SettingsSelect
                    data-settings-select="skill-assign"
                    aria-label={t("skills.library.assignLabel")}
                    value={assignBot}
                    disabled={locked}
                    onChange={(e) => setAssignBot(e.target.value)}
                  >
                    <option value="">{t("skills.library.assignPickBot")}</option>
                    {bots.map((bot) => (
                      <option key={bot.id} value={bot.id}>{bot.name}</option>
                    ))}
                  </SettingsSelect>
                  <button type="button" disabled={!assignBot || locked} onClick={() => void assign(skill)} className="ui-button">
                    {t("skills.library.assign")}
                  </button>
                </ItemRow>
              )}
            </div>
          ))}
        {error && !importOpen && <NoteRow tone="danger">{error}</NoteRow>}
      </RowsCard>

      <RowsCard data-settings-block="skills-import">
        <NavRow data-settings-open="skill-import" title={t("skills.library.importTitle")} hint={t("settings.s2.skills.importHint")} onClick={() => setImportOpen(true)} />
        {importMessage && !importOpen && <NoteRow>{importMessage}</NoteRow>}
      </RowsCard>
      <AnimatePresence>{importOpen && (
        <FormDialog key="skill-import" data-panel-modal="skill-import" title={t("skills.library.importTitle")} description={t("skills.library.importHint")} width={520}
          saveLabel={importing ? t("skills.library.importing") : t("skills.library.importButton")} canSave={!importing && !working && Boolean(importText.trim())} busy={importing}
          error={error || undefined} onSave={async () => { await importSkill(); }} onClose={() => setImportOpen(false)}>
          <textarea
            className={cn(textFieldCls, "h-auto min-h-32 py-2 font-mono text-[12px]")}
            placeholder={t("skills.library.importPlaceholder")}
            aria-label={t("skills.library.importTitle")}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
        </FormDialog>
      )}</AnimatePresence>

      {viewing && <SkillSourceDialog viewing={viewing} error={error} working={Boolean(working)} onClose={() => { if (!working) setViewing(null); }} onEnable={() => void toggle(viewing.skill, true)} />}
    </div>
  );
}

function SkillSourceDialog({ viewing, error, working, onClose, onEnable }: {
  viewing: { skill: SkillsLibrarySkillWire; text: string; review: boolean };
  error: string;
  working: boolean;
  onClose: () => void;
  onEnable: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, onClose);
  return (
        <ModalLayer><div
          ref={dialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="skills-library-view-title"
          className="ui-dialog-scrim fixed inset-0 z-[90] flex items-center justify-center p-6"
        >
          <div className="ui-dialog flex max-h-[min(760px,90vh)] w-full max-w-2xl flex-col p-5">
            <div className="flex items-center justify-between gap-3">
              <div id="skills-library-view-title" className="text-[15px] font-medium leading-[22px] text-ink">{viewing.review ? `Review ${viewing.skill.name} before enabling` : viewing.skill.name}</div>
              <button
                type="button"
                disabled={working}
                onClick={onClose}
                className="ui-button"
              >
                {t("skills.library.close")}
              </button>
            </div>
            {viewing.review && <LibrarySkillMeta skill={viewing.skill} />}
            {viewing.skill.warnings.length > 0 && <div className="mt-2 text-[12px] text-warning">{viewing.skill.warnings.join(" · ")}</div>}
            <pre
              tabIndex={0}
              aria-label={`${t("skills.library.view", { skill: viewing.skill.name })}`}
              className="mt-3 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-transparent p-3 font-mono text-[12px] leading-[18px] text-ink"
            >
              {viewing.text}
            </pre>
            {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
            {viewing.review && <button type="button" disabled={working} onClick={onEnable} className="ui-button ui-button-primary mt-3 self-end">Enable reviewed skill</button>}
          </div>
        </div></ModalLayer>
  );
}
