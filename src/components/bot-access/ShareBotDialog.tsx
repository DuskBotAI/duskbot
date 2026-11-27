import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Lock, Users, X } from "../../icons";

import type { BotAccess, BotAccessLevel, GrantedLevel } from "../../../shared/bot-access";
import { BOT_SHARING_ENABLED } from "../../../shared/bot-sharing";
import { botOwner } from "../../../shared/bot-owner";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { phoneApp } from "@/lib/store-app";
import { wakeSystemControls } from "@/lib/system-control";
import { useStore, type Bot } from "@/state/store";
import { mayChangeOwner, ownerChanged, ownerOf, useTeamPeople, type TeamPeople, type TeamPerson } from "@/state/team-people";
import { MENU_SHEET } from "../menu-recipe";
import { SIMPLE_BUTTONS, SIMPLE_CARD, SettingsGroup } from "../SettingsPrimitives";
import { compactBackdropStyle, compactSheetStyle } from "../compact-settings-sheet";
import "../../styles/settings.css";
import { accessOfBot, addablePeople, canShare, levelWhenAdded, nameOf, personOf, saveAccess, saveOwner, withPerson } from "./access";
import { choiceItem, EntryFace, PersonMenu, QuietMenu } from "./ShareControls";
import { friendlyError } from "@/lib/plain-error";

export interface AccessChange { before: BotAccess; after: BotAccess; text: string }

/** A bot's Share dialog on a team: whether everyone in the team can use it or only the people added, and who those
 * are. A change applies at once; the caller shows it with Undo. `headerMenu` holds what else the opener offers there.
 * A person's stored level (view, chat or edit) stays as it is until they are removed; the dialog does not show it. */
export function ShareBotDialog({ bot, teamName, onClose, onChanged, headerMenu, embedded = false }: {
  bot: Bot;
  teamName: string;
  onClose: () => void;
  onChanged: (change: AccessChange) => void;
  headerMenu?: ReactNode;
  embedded?: boolean;
}) {
  const team = useTeamPeople();
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newOwner, setNewOwner] = useState<TeamPerson | null>(null);
  const access = accessOfBot(bot);
  const owner = team ? ownerOf(bot, team) : null;
  const editable = canShare(bot);
  // with sharing off a person can be taken off or the bot narrowed, never added or opened up
  const adding = editable && BOT_SHARING_ENABLED;
  const showGeneral = editable && (BOT_SHARING_ENABLED || access.everyone !== "none");
  const handsOver = mayChangeOwner(bot, team);
  const phone = phoneApp();

  useEffect(() => {
    if (!phone || embedded) return;
    wakeSystemControls();
    return () => wakeSystemControls();
  }, [phone, embedded]);

  useEffect(() => {
    if (embedded) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, [embedded]);
  useEffect(() => {
    if (!embedded && document.activeElement === document.body) dialogRef.current?.focus();
  }, [embedded, bot.access, bot.reportsTo, newOwner]);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  };
  const apply = (after: BotAccess, text: string) => run(async () => {
    await saveAccess(bot.id, after);
    onChanged({ before: access, after, text });
  });
  const handOver = (person: TeamPerson) => run(async () => {
    dispatch({ type: "botPatched", bot: await saveOwner(bot.id, person.email) });
    ownerChanged();
    setNewOwner(null);
  });

  const keepOwner = () => {
    setError("");
    setNewOwner(null);
  };

  const yourRow = !editable && team?.me && bot.yourAccess && bot.yourAccess !== "none"
    ? <PersonRow person={team.me} you data-share-yours trailing={null} /> : null;

  const peopleList = (
    <ul data-share-people className="flex flex-col">
      {owner && <PersonRow person={owner} you={owner.you === true} trailing={<span className="px-2 text-[13px] text-ink-secondary">{t("lookedAfter.badge")}</span>} />}
      {yourRow}
      {editable && Object.keys(access.people).sort((a, b) => nameOf(a, team).localeCompare(nameOf(b, team))).map((entry) => {
        const person = personOf(entry, team);
        return (
          <PersonRow key={entry} entry={entry} person={person} you={team?.me?.email === entry}
            trailing={<PersonMenu disabled={busy} label={t("botAccess.personMenu", { name: nameOf(entry, team) })}
              onMakeOwner={handsOver && person ? () => { setError(""); setNewOwner(person); } : undefined}
              makeOwnerLabel={person ? t("lookedAfter.make", { name: person.name }) : undefined}
              onRemove={() => void apply(withPerson(access, entry, null), t("botAccess.toast.removed", { name: nameOf(entry, team) }))} />} />
        );
      })}
    </ul>
  );

  if (embedded) {
    return (
      <div
        ref={dialogRef}
        tabIndex={-1}
        data-share-bot={bot.id}
        className="flex flex-col gap-5 px-4 pb-8 pt-2 text-ink outline-none"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented && newOwner) {
            event.stopPropagation();
            keepOwner();
          }
        }}
      >
        {newOwner ? (
          <div className="rounded-[26px] bg-(--m-ios-card,var(--color-menu))">
            <MakeOwner person={newOwner} bot={bot} busy={busy} error={error} onCancel={keepOwner} onConfirm={() => void handOver(newOwner)} />
          </div>
        ) : (
          <>
            {adding && team && (
              <div className="relative z-10 rounded-[26px] bg-(--m-ios-card,var(--color-menu)) px-3 py-1.5">
                <AddPerson team={team} access={access} owner={botOwner(bot)} disabled={busy}
                  onAdd={(person, level) => void apply(withPerson(access, person.email, level), t("botAccess.toast.addedPlain", { name: person.name }))} />
              </div>
            )}
            <section className="flex flex-col gap-2">
              <h3 className="px-4 text-[13px] font-semibold text-ink-secondary">{t("botAccess.people")}</h3>
              <div className="rounded-[26px] bg-(--m-ios-card,var(--color-menu)) px-4 py-2">
                {peopleList}
              </div>
              <p className="px-4 text-[13px] leading-[18px] text-ink-secondary">{t("botAccess.admins")}</p>
            </section>
            {showGeneral && (
              <section className="flex flex-col gap-2">
                <h3 className="px-4 text-[13px] font-semibold text-ink-secondary">{t("botAccess.general")}</h3>
                <div className="rounded-[26px] bg-(--m-ios-card,var(--color-menu)) px-4 py-3">
                  <GeneralAccess access={access} teamName={teamName} disabled={busy}
                    onChange={(everyone) => void apply({ everyone, people: access.people }, everyone === "none"
                      ? t("botAccess.toast.onlyAdded")
                      : t("botAccess.toast.everyoneUse", { team: teamName }))} />
                </div>
              </section>
            )}
            {error && <p role="alert" className="px-4 text-[13px] text-danger">{error}</p>}
          </>
        )}
      </div>
    );
  }

  const portalRoot = phone ? (document.querySelector?.(".dusk-mobile") ?? document.body) : document.body;
  const general = showGeneral && (
    <SettingsGroup label={t("botAccess.general")}>
      <div className={cn(SIMPLE_CARD, "px-2 py-1.5")}>
        <GeneralAccess access={access} teamName={teamName} disabled={busy}
          onChange={(everyone) => void apply({ everyone, people: access.people }, everyone === "none"
            ? t("botAccess.toast.onlyAdded")
            : t("botAccess.toast.everyoneUse", { team: teamName }))} />
      </div>
    </SettingsGroup>
  );
  return createPortal(
    <div
      data-phone-modal-layer={phone ? "" : undefined}
      data-settings-sheet
      data-settings-look="simple"
      className={cn("settings-scrim", phone ? "z-[80]" : "z-[60]")}
      style={phone ? { paddingTop: "max(var(--m-safe-top, 0px), 16px)", paddingBottom: "max(calc(var(--m-kb, 0px) + 12px), var(--m-safe-bottom, 0px), 16px)" } : undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onClick={(event) => {
        if (phone && event.target === event.currentTarget) onClose();
      }}
    >
      <div aria-hidden="true" className="settings-backdrop" style={compactBackdropStyle} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="share-bot-title" tabIndex={-1} data-share-bot={bot.id}
        className="settings-dialog" style={compactSheetStyle(480)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" && !event.defaultPrevented) {
            if (newOwner) keepOwner(); else onClose();
          }
          if (event.key === "Tab") trapTab(event, dialogRef.current);
        }}>
        {newOwner ? (
          <MakeOwner person={newOwner} bot={bot} busy={busy} error={error} onCancel={keepOwner} onConfirm={() => void handOver(newOwner)} dialog />
        ) : (
          <section className="settings-panel min-h-0">
            <button type="button" onClick={onClose} aria-label={t("common.close")} className="settings-close"><X size={14} /></button>
            <header className="settings-pane-header">
              <h2 id="share-bot-title" className="settings-pane-title min-w-0 truncate">{t("botAccess.title", { bot: bot.name })}</h2>
              {headerMenu}
            </header>
            {adding && team && (
              <div className="relative z-10 shrink-0 px-6 pb-1 pt-2">
                <AddPerson team={team} access={access} owner={botOwner(bot)} disabled={busy}
                  onAdd={(person, level) => void apply(withPerson(access, person.email, level), t("botAccess.toast.addedPlain", { name: person.name }))} />
              </div>
            )}
            <div className="settings-scroll">
              <div className="settings-pane" style={{ gap: 24, paddingTop: 12, paddingBottom: 12 }}>
                <SettingsGroup label={t("botAccess.people")} footnote={t("botAccess.admins")}>
                  <div className={cn(SIMPLE_CARD, "px-2")}>{peopleList}</div>
                </SettingsGroup>
                {general}
                {error && <p role="alert" className="m-0 px-3 text-[13px] leading-[18px] text-danger">{error}</p>}
              </div>
            </div>
            <footer className={cn("flex shrink-0 justify-end px-6 pb-5 pt-1", SIMPLE_BUTTONS)}>
              <button type="button" onClick={onClose} className="ui-button ui-button-primary">{t("common.done")}</button>
            </footer>
          </section>
        )}
      </div>
    </div>,
    portalRoot,
  );
}

function trapTab(event: React.KeyboardEvent, dialog: HTMLElement | null) {
  const controls = dialog?.querySelectorAll<HTMLElement>("input:enabled, button:enabled");
  if (!controls?.length) return;
  const first = controls[0]!, last = controls[controls.length - 1]!;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function MakeOwner({ person, bot, busy, error, onCancel, onConfirm, dialog = false }: {
  person: TeamPerson; bot: Bot; busy: boolean; error: string; onCancel: () => void; onConfirm: () => void; dialog?: boolean;
}) {
  if (dialog) {
    return (
      <div data-share-make-owner={person.email} className={cn("flex flex-col px-6 pb-5 pt-7", SIMPLE_BUTTONS)}>
        <h2 id="share-bot-title" className="settings-pane-title m-0 ps-2.5">{t("lookedAfter.makeTitle", { name: person.name, bot: bot.name })}</h2>
        <p className="m-0 mt-3 px-2.5 text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary">{t("lookedAfter.makeBody", { name: person.name, bot: bot.name })}</p>
        {error && <p role="alert" className="m-0 mt-3 px-2.5 text-[13px] leading-[18px] text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" autoFocus disabled={busy} onClick={onCancel} className="ui-button">{t("common.cancel")}</button>
          <button type="button" disabled={busy} onClick={onConfirm} className="ui-button ui-button-primary">{t("lookedAfter.make", { name: person.name })}</button>
        </div>
      </div>
    );
  }
  return (
    <div data-share-make-owner={person.email} className="px-5 pb-4 pt-4">
      <h2 id="share-bot-title" className="text-[17px] font-semibold">{t("lookedAfter.makeTitle", { name: person.name, bot: bot.name })}</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{t("lookedAfter.makeBody", { name: person.name, bot: bot.name })}</p>
      {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" autoFocus disabled={busy} onClick={onCancel} className="ui-button rounded-full px-4">{t("common.cancel")}</button>
        <button type="button" disabled={busy} onClick={onConfirm} className="ui-button ui-button-primary rounded-full px-4">{t("lookedAfter.make", { name: person.name })}</button>
      </div>
    </div>
  );
}

function PersonRow({ person, entry, you, trailing, ...data }: { person: TeamPerson | null; entry?: string; you: boolean; trailing: ReactNode; "data-share-yours"?: boolean }) {
  const name = person?.name ?? entry ?? "";
  return (
    <li className="flex min-h-[40px] shrink-0 items-center gap-3 py-1" data-share-person={person?.email ?? entry} {...data}>
      <EntryFace person={person} size={32} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-[18px] tracking-[0.015em] text-ink">{you ? t("botAccess.you", { name }) : name}</span>
        {person && <span className="block truncate text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary">{person.email}</span>}
      </span>
      <span className="min-w-0 shrink-0">{trailing}</span>
    </li>
  );
}

function GeneralAccess({ access, teamName, disabled, onChange }: {
  access: BotAccess; teamName: string; disabled: boolean; onChange: (everyone: BotAccessLevel) => void;
}) {
  const everyone = access.everyone !== "none";
  const hint = access.everyone === "view" ? t("botAccess.everyoneHint.view", { team: teamName })
    : access.everyone === "chat" ? t("botAccess.everyoneHint.chat", { team: teamName })
      : access.everyone === "edit" ? t("botAccess.everyoneHint.edit", { team: teamName }) : t("botAccess.onlyAddedHint");
  const only = t("botAccess.onlyAdded"), all = t("botAccess.everyoneUse", { team: teamName });
  return (
    <div className="flex items-center gap-3" data-share-general={access.everyone}>
      <span aria-hidden="true" className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-full", "bg-ink/[0.06] text-ink-secondary")}>
        {everyone ? <Users size={16} /> : <Lock size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="-ms-2 flex">
          <QuietMenu label={t("botAccess.general")} shown={everyone ? all : only} align="start" className="font-medium text-ink"
            items={[
              choiceItem("none", only, !everyone, () => { if (everyone) onChange("none"); }, { disabled }),
              choiceItem("everyone", all, everyone, () => { if (!everyone) onChange("chat"); }, { disabled: disabled || (!everyone && !BOT_SHARING_ENABLED) }),
            ]} />
        </div>
        <p className="text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary">{hint}</p>
      </div>
    </div>
  );
}

function AddPerson({ team, access, owner, disabled, onAdd }: {
  team: TeamPeople; access: BotAccess; owner: string | null; disabled: boolean; onAdd: (person: TeamPerson, level: GrantedLevel) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement | null>(null);
  const level = levelWhenAdded(access.everyone);
  const matches = useMemo(() => addablePeople(team, access, owner, query), [team, access, owner, query]);
  const current = Math.min(active, matches.length - 1);
  const showing = open && matches.length > 0;
  useEffect(() => {
    if (showing) listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [showing, current]);
  if (!level) return <p className="py-1 text-[13px] text-ink-secondary">{t("botAccess.everyoneEdits")}</p>;
  const add = (person: TeamPerson) => {
    if (disabled) return;
    onAdd(person, level);
    setQuery("");
    setActive(0);
    setOpen(false);
  };
  const move = (by: number) => {
    if (!open) { setOpen(true); return; }
    if (matches.length) setActive((current + by + matches.length) % matches.length);
  };
  return (
    <>
      <input value={query} placeholder={t("botAccess.addPlaceholder")} aria-label={t("botAccess.addPlaceholder")}
        role="combobox" aria-expanded={showing} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={showing ? `${listId}-${current}` : undefined}
        onChange={(event) => { setQuery(event.target.value); setActive(0); setOpen(true); }}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
          if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
          if (event.key === "Enter" && showing) { event.preventDefault(); add(matches[current]!); }
          if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); }
        }}
        className="w-full rounded-lg border border-transparent bg-transparent px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-focus focus:outline-none" />
      {open && (
        <ul ref={listRef} id={listId} role="listbox" onMouseDown={(event) => event.preventDefault()}
          className={cn(MENU_SHEET, "absolute inset-x-5 top-full max-h-[min(240px,40vh)] overflow-y-auto")}>
          {matches.length === 0 ? (
            <li className="px-2 py-1.5 text-[13px] text-ink-secondary">{query.trim() ? t("botAccess.noMatch") : t("botAccess.nobodyLeft")}</li>
          ) : matches.map((person, index) => (
            <li key={person.email} id={`${listId}-${index}`} role="option" aria-selected={index === current} data-share-suggestion={person.email}
              onMouseEnter={() => setActive(index)} onMouseDown={() => add(person)}
              className={cn("flex shrink-0 cursor-pointer items-center gap-3 rounded-md px-2 py-1", index === current && "bg-menu-hover")}>
              <EntryFace person={person} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] leading-[18px] text-ink">{person.name}</span>
                <span className="block truncate text-[12px] leading-4 text-ink-secondary">{person.email}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
