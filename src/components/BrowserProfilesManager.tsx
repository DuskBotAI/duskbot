import { useEffect, useId, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Globe, Plus, Trash2 } from "../icons";
import { api, ApiError, useStore, type Bot, type BotAnnouncement, type BrowserProfile, type ConfigStatus } from "@/state/store";
import { browserProfileDeletionBlockReason, browserProfilesMutation, newBrowserProfileId } from "@/lib/browser-profiles";
import { isOwnerOrAdmin, readSessionState } from "@/lib/session";
import { t } from "@/lib/i18n";
import { askConfirm } from "./ConfirmDialog";
import { SignedInSites } from "./SignedInSites";
import { Select } from "./Select";
import { browserScope } from "@/lib/team-browser";
import { Card as RowsCard, FormDialog, FormField, ItemRow, NavRow, NoteRow, useSubPage } from "./ListRows";
import { SettingRow } from "./SettingsPrimitives";
import { SettingsSelect } from "./SettingsSelect";
import { textFieldCls } from "./ui/GrokDialog";
import { PROFILE_PAGE } from "./settings-page-ids";
import { friendlyError } from "@/lib/plain-error";
import { ArtState } from "./ui/Art";

/** Security: the server owns session routing and erasure; this UI never handles cookies or partitions. */
export function BrowserProfilesManager({ bot, onProfileChanged, disabled = false, folded = false }: {
  bot?: Bot;
  onProfileChanged?: () => void;
  disabled?: boolean;
  folded?: boolean;
}) {
  const { state, dispatch, flushBotPatches } = useStore();
  const profiles = state.config?.browserProfiles ?? [];
  const myChrome = state.config?.browserEngine?.myChrome === true;
  const bots = state.bots ?? [];
  const currentBot = bot ? bots.find((candidate) => candidate.id === bot.id) ?? bot : undefined;
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState("");
  const fieldId = useId();
  const sub = useSubPage();
  const [adding, setAdding] = useState(false);
  const locked = busy || disabled || canManage !== true;

  useEffect(() => {
    let alive = true;
    void readSessionState().then((session) => {
      if (alive) setCanManage(isOwnerOrAdmin(session));
    });
    return () => { alive = false; };
  }, []);

  const failed = async (cause: unknown) => {
    setError(friendlyError(cause, t("settings.profiles.saveError")));
    if (cause instanceof ApiError && cause.status === 409) {
      try {
        const config: ConfigStatus = await api("/api/config");
        dispatch({ type: "configStatus", config });
      } catch {
        setError(t("settings.profiles.refreshError"));
      }
    }
    if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) setCanManage(false);
  };

  const save = async (next: BrowserProfile[]): Promise<boolean> => {
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify(browserProfilesMutation(profiles, next)),
      });
      dispatch({ type: "configStatus", config });
      return true;
    } catch (cause) {
      await failed(cause);
      return false;
    }
  };

  const create = async () => {
    if (locked || !name.trim() || profiles.length >= 20) return;
    setBusy(true);
    setError("");
    try {
      if (await save([...profiles, { id: newBrowserProfileId(), name: name.trim() }])) { setName(""); setAdding(false); }
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (locked || !renaming?.name.trim()) return;
    if (!profiles.some((profile) => profile.id === renaming.id)) {
      setError(t("settings.profiles.removed"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (await save(profiles.map((profile) => profile.id === renaming.id ? { ...profile, name: renaming.name.trim() } : profile))) {
        setRenaming(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (profile: BrowserProfile): Promise<boolean> => {
    if (locked) return false;
    const blocked = browserProfileDeletionBlockReason(bots, profile.id);
    if (blocked) { setError(blocked); return false; }
    const users = bots.filter((candidate) => candidate.browserProfile === profile.id);
    const summary = users.length ? `${t("settings.profiles.deleteUsers", { names: users.map((candidate) => candidate.name).join(", ") })} ` : "";
    if (!(await askConfirm({ title: t("memory.confirmDelete", { name: profile.name }), body: summary + t("confirm.profileDeleteBody"), confirmLabel: t("common.delete") }))) return false;
    setBusy(true);
    setError("");
    try {
      if (await save(profiles.filter((candidate) => candidate.id !== profile.id))) {
        if (renaming?.id === profile.id) setRenaming(null);
        if (currentBot?.browserProfile === profile.id) onProfileChanged?.();
        return true;
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const setBrowser = async (profile: BrowserProfile, browser: string) => {
    if (locked || (profile.browser ?? "") === browser) return;
    setBusy(true);
    setError("");
    try {
      await save(profiles.map((candidate) => candidate.id === profile.id ? { ...candidate, browser: browser === "chrome" ? "chrome" : undefined } : candidate));
    } finally {
      setBusy(false);
    }
  };

  const select = async (profileId: string) => {
    if (locked || !currentBot || currentBot.busy || profileId === (currentBot.browserProfile ?? "")) return;
    setBusy(true);
    setError("");
    try {
      // Drain coalesced settings edits first, so an older queued patch cannot put the bot back on its previous login.
      await flushBotPatches(currentBot.id);
      const result: { bot: BotAnnouncement } = await api(`/api/bots/${encodeURIComponent(currentBot.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ browserProfile: profileId || null }),
      });
      dispatch({ type: "botPatched", bot: result.bot });
      onProfileChanged?.();
    } catch (cause) {
      await failed(cause);
    } finally {
      setBusy(false);
    }
  };

  if (canManage === false) return currentBot
    ? <p className="text-[12px] text-ink-secondary">{t("settings.profiles.ownerOnly")}</p>
    : <RowsCard><NoteRow>{t("settings.profiles.ownerOnly")}</NoteRow></RowsCard>;

  const inputClass = "min-w-0 flex-1 rounded-md border border-transparent bg-inset px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-50";
  const buttonClass = "shrink-0 rounded-md bg-control px-2.5 py-2 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50";
  const selected = currentBot?.browserProfile ?? "";
  const selectedProfile = profiles.find((profile) => profile.id === selected);
  const usersOf = (profileId: string) => bots.filter((candidate) => candidate.browserProfile === profileId).map((candidate) => candidate.name);
  const usesMyChrome = (profile: BrowserProfile | undefined) => profile?.browser === "chrome" && myChrome;
  const chromeNote = <p className="text-[11px] leading-relaxed text-ink-secondary">{t("settings.profiles.myChromeHint")}</p>;
  // In Settings (no bot): the shared profiles as rows, each opening its own page; names are typed in a small form
  if (!currentBot) {
    const errorRow = error ? <NoteRow tone="danger">{error}</NoteRow> : null;
    const renameDialog = <AnimatePresence>{renaming && (
      <FormDialog key="rename-profile" data-panel-modal="rename-profile" title={t("settings.profiles.rename")} canSave={Boolean(renaming.name.trim())} busy={busy}
        error={error || undefined} onSave={rename} onClose={() => setRenaming(null)}>
        <FormField label={t("settings.profiles.nameAria")}>
          <input autoFocus value={renaming.name} onChange={(event) => setRenaming({ id: renaming.id, name: event.target.value })} maxLength={40} required disabled={locked} className={textFieldCls} />
        </FormField>
      </FormDialog>
    )}</AnimatePresence>;
    const pageId = sub.at?.startsWith(PROFILE_PAGE) ? sub.at.slice(PROFILE_PAGE.length) : null;
    if (pageId !== null) {
      const profile = profiles.find((candidate) => candidate.id === pageId);
      if (!profile) return <RowsCard><NoteRow>{t("settings.profiles.removed")}</NoteRow></RowsCard>;
      const users = usersOf(profile.id);
      const blocked = browserProfileDeletionBlockReason(bots, profile.id);
      const chrome = usesMyChrome(profile);
      return (
        <div className="contents" aria-busy={busy}>
          <RowsCard data-settings-block="browser-profile">
            <NavRow data-settings-open="rename-profile" title={t("settings.profiles.nameAria")} value={profile.name} disabled={locked}
              onClick={() => { setRenaming({ id: profile.id, name: profile.name }); setError(""); }} />
            <SettingRow title={t("settings.profiles.browserLabel")}>
              <SettingsSelect data-settings-select="profile-browser" aria-label={t("settings.profiles.browserLabel")} value={profile.browser ?? ""} disabled={locked}
                options={[{ value: "", label: t("settings.profiles.builtIn") }, { value: "chrome", label: t("settings.profiles.myChrome"), disabled: !myChrome }]}
                onChange={(event) => void setBrowser(profile, event.target.value)} />
            </SettingRow>
            <ItemRow title={t("settings.s2.profiles.usedBy")} value={users.length ? users.join(", ") : t("settings.s2.profiles.nobody")} />
            {errorRow}
          </RowsCard>
          {chrome ? (
            <RowsCard>
              <NoteRow>{t("settings.profiles.myChromeHint")}</NoteRow>
              {!myChrome && <NoteRow>{t("settings.profiles.myChromeUnavailable")}</NoteRow>}
            </RowsCard>
          ) : (
            <RowsCard label={t("settings.sites.title")}>
              <SignedInSites bare target={{ profile: profile.id }} sharedBy={users} disabled={locked} />
            </RowsCard>
          )}
          <RowsCard>
            <NavRow danger drill={false} data-settings-open="delete-profile" title={t("settings.s2.profiles.delete")} hint={blocked ?? undefined}
              aria-label={`${t("common.delete")} ${profile.name}`} disabled={locked || Boolean(blocked)}
              onClick={() => void remove(profile).then((removed) => { if (removed) sub.back(); })} />
          </RowsCard>
          {renameDialog}
        </div>
      );
    }
    return (
      <div className="contents" aria-busy={busy}>
        <RowsCard data-settings-block="browser-profiles"
          footnote={profiles.length >= 20 ? t("settings.profiles.limit")
            : !myChrome && profiles.length > 0 ? t("settings.profiles.myChromeUnavailable") : undefined}>
          {!profiles.length && <ArtState data-art-state="profiles" art="binoculars" title={t("empty.profiles.title")} className="py-6">{t("empty.profiles.hint")}</ArtState>}
          {profiles.map((profile) => {
            const users = usersOf(profile.id);
            return (
              <NavRow key={profile.id} data-panel-page={`${PROFILE_PAGE}${profile.id}`} title={profile.name}
                hint={users.length ? t("settings.profiles.usedBy", { names: users.join(", ") }) : t("settings.profiles.notInUse")}
                value={profile.browser === "chrome" ? t("settings.profiles.myChrome") : t("settings.profiles.builtIn")}
                onClick={() => { setError(""); sub.open(`${PROFILE_PAGE}${profile.id}`, profile.name); }} />
            );
          })}
          <NavRow data-settings-open="new-profile" title={t("settings.s2.profiles.new")} hint={t("settings.s2.profiles.newHint")} disabled={locked || profiles.length >= 20}
            onClick={() => { setError(""); setName(""); setAdding(true); }} />
          {!adding && errorRow}
        </RowsCard>
        <AnimatePresence>{adding && (
          <FormDialog key="new-profile" data-panel-modal="new-profile" title={t("settings.s2.profiles.new")} saveLabel={t("settings.profiles.create")} canSave={Boolean(name.trim())} busy={busy}
            error={error || undefined} onSave={create} onClose={() => setAdding(false)}>
            <FormField label={t("settings.profiles.newName")}>
              <input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={40} required disabled={locked} className={textFieldCls} />
            </FormField>
          </FormDialog>
        )}</AnimatePresence>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" aria-busy={busy}>
      {currentBot && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${fieldId}-profile`} className="text-[12px] font-medium text-ink">{t("settings.profiles.browserSession")}</label>
          <Select className="w-full"
            id={`${fieldId}-profile`}
            value={selected}
            disabled={locked || currentBot.busy}
            onChange={(event) => void select(event.target.value)}
          >
            <option value="">{t("settings.profiles.own")}</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            <option value="guest">{t("settings.profiles.temporary")}</option>
            {selected && selected !== "guest" && !profiles.some((profile) => profile.id === selected)
              ? <option value={selected} disabled>{t("settings.profiles.removed")}</option> : null}
          </Select>
          <p className="text-[11px] leading-relaxed text-ink-secondary">
            {currentBot.busy ? t("settings.profiles.stopToSwitch") : selected === "guest" ? t("settings.profiles.temporaryHint") : t("settings.profiles.sharedHint")}
          </p>
          {usesMyChrome(selectedProfile) ? chromeNote
            : (selected === "" || selectedProfile) && (
              <SignedInSites key={`${currentBot.id}:${selected}`} target={{ bot: currentBot.id }} scope={browserScope(state.config?.team, bot?.threadId)} sharedBy={selected ? usersOf(selected) : [currentBot.name]} disabled={locked} />
            )}
        </div>
      )}
      <details open={!currentBot && !folded} className="min-w-0">
        <summary className="cursor-pointer text-[12px] font-medium text-ink-secondary hover:text-ink">{t("settings.profiles.manage")}</summary>
        <div className="mt-3 flex flex-col gap-3">
          <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void create(); }}>
            <label htmlFor={`${fieldId}-new`} className="sr-only">{t("settings.profiles.newName")}</label>
            <input id={`${fieldId}-new`} value={name} onChange={(event) => setName(event.target.value)} maxLength={40} required disabled={locked || profiles.length >= 20} placeholder={t("settings.profiles.newName")} className={inputClass} />
            <button type="submit" disabled={locked || !name.trim() || profiles.length >= 20} className={`${buttonClass} flex items-center gap-1`}><Plus size={13} />{t("settings.profiles.create")}</button>
          </form>
          {profiles.length >= 20 && <p className="text-[11px] text-ink-secondary">{t("settings.profiles.limit")}</p>}
          {!myChrome && profiles.length > 0 && <p className="text-[11px] leading-relaxed text-ink-secondary">{t("settings.profiles.myChromeUnavailable")}</p>}
          {!profiles.length && <p className="text-[12px] text-ink-secondary">{t("settings.profiles.sharedEmpty")}</p>}
          <div className="divide-y divide-transparent">
            {profiles.map((profile) => {
              const users = usersOf(profile.id);
              const blocked = browserProfileDeletionBlockReason(bots, profile.id);
              const chrome = usesMyChrome(profile);
              return (
                <div key={profile.id} className="flex flex-col gap-1 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Globe size={14} className="shrink-0 text-ink-secondary" />
                    {renaming?.id === profile.id ? (
                      <form className="flex min-w-0 flex-1 flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void rename(); }}>
                        <input autoFocus value={renaming.name} onChange={(event) => setRenaming({ id: profile.id, name: event.target.value })} maxLength={40} required disabled={locked} className={inputClass} aria-label={t("settings.profiles.nameAria")} />
                        <button type="submit" disabled={locked || !renaming.name.trim()} className={buttonClass}>{t("common.save")}</button>
                        <button type="button" disabled={busy} onClick={() => setRenaming(null)} className={buttonClass}>{t("common.cancel")}</button>
                      </form>
                    ) : (
                      <>
                        <button type="button" disabled={locked} onClick={() => { setRenaming({ id: profile.id, name: profile.name }); setError(""); }} className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-ink hover:underline disabled:opacity-50" title={t("settings.profiles.rename")}>{profile.name}</button>
                        <button type="button" onClick={() => void remove(profile)} disabled={locked || Boolean(blocked)} title={blocked ?? t("settings.profiles.deleteTitle")} aria-label={`${t("common.delete")} ${profile.name}`} className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"><Trash2 size={13} />{t("common.delete")}</button>
                      </>
                    )}
                  </div>
                  <p className="break-words pl-6 text-[11px] text-ink-secondary">{users.length ? t("settings.profiles.usedBy", { names: users.join(", ") }) : t("settings.profiles.notInUse")}</p>
                  <div className="flex min-w-0 flex-col gap-2 pl-6 pt-1">
                    <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
                      {t("settings.profiles.browserLabel")}
                      <Select size="sm" value={profile.browser ?? ""} disabled={locked} onChange={(event) => void setBrowser(profile, event.target.value)}>
                        <option value="">{t("settings.profiles.builtIn")}</option>
                        <option value="chrome" disabled={!myChrome}>{t("settings.profiles.myChrome")}</option>
                      </Select>
                    </label>
                    {chrome ? chromeNote : <SignedInSites target={{ profile: profile.id }} sharedBy={users} disabled={locked} />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </details>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </div>
  );
}
