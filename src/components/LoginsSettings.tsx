import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { ArtState } from "./ui/Art";
import { Loader2 } from "../icons";

import type { LoginBots, LoginSummary, OnePasswordStatus, OnePasswordVault } from "../../shared/logins";
import { t } from "@/lib/i18n";
import { addLogin, changeLogin, connectOnePassword, deleteLogin, disconnectOnePassword, grantVault, listLogins, refreshOnePassword } from "@/lib/logins";
import { relativeTime } from "@/lib/memory";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { usePlaceLook } from "@/lib/place-look";
import { useStore, type ConfigStatus } from "@/state/store";
import { LoginBotPicker, LoginForm } from "./LoginForm";
import { PlaceMark } from "./PlaceMark";
import { SavedSecretDialog, useSavedSecrets } from "./SavedSecretsSettings";
import type { SavedSecretSummary } from "../../shared/saved-secrets";
import { ItemRow, NavRow, NoteRow, SwitchRow } from "./ListRows";
import { Card, SettingsGroup, SettingsRows, SIMPLE_CARD } from "./SettingsPrimitives";
import { DialogPane, GrokDialog, mdPrimaryCls, mdSecondaryCls, textFieldCls } from "./ui/GrokDialog";
import { cn } from "@/lib/cn";
import { Icon } from "./Icon";
import { useWindowPlace, windowPlaceMark } from "./WindowPlaceTitle";
import { siteIconUrl } from "@/lib/site-icon";
import { friendlyError } from "@/lib/plain-error";

// Security: a row never shows the password, which no route returns.

const SOURCE_KEYS = {
  card: "settings.logins.source.card",
  settings: "settings.logins.source.settings",
  "1password": "settings.logins.source.1password",
} as const;


type VaultRequest = { kind: "login" | "onepassword"; nonce: number };
let vaultRequest: VaultRequest | null = null;
const vaultWatchers = new Set<() => void>();
const subscribeVault = (watch: () => void) => { vaultWatchers.add(watch); return () => { vaultWatchers.delete(watch); }; };
function requestVault(kind: VaultRequest["kind"]) {
  vaultRequest = { kind, nonce: (vaultRequest?.nonce ?? 0) + 1 };
  for (const watch of Array.from(vaultWatchers)) watch();
}

/** Grok's black New item pill in the Vault's header, and its menu: a login, or a 1Password vault. */
export function VaultNewItem() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", key, true); };
  }, [open]);
  const pick = (kind: VaultRequest["kind"]) => { setOpen(false); requestVault(kind); };
  const item = "relative flex min-h-[30px] w-full cursor-pointer items-center gap-2 px-3.5 py-1.5 text-start text-[13px] leading-[18px] text-ink before:pointer-events-none before:absolute before:inset-y-0 before:inset-x-1.5 before:rounded-[10px] hover:before:bg-ink/[0.06] focus-visible:outline-none focus-visible:before:bg-ink/[0.06]";
  return (
    <div ref={root} className="relative" data-vault-new="">
      <button type="button" aria-label={t("settings.vault.newItem")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
        className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-full bg-ink px-3 text-[13px] leading-[18px] text-app hover:bg-ink/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        {t("settings.vault.newItem")}<Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div role="menu" aria-label={t("settings.vault.newItem")} className="absolute end-0 top-[calc(100%+4px)] z-10 flex min-w-[200px] flex-col gap-0.5 rounded-2xl bg-menu py-1.5 shadow-(--shadow-popover)">
          <button type="button" role="menuitem" aria-label={t("settings.logins.add")} className={item} onClick={() => pick("login")}><Icon name="key" size={16} className="relative" /><span className="relative">{t("settings.logins.add")}</span></button>
          <button type="button" role="menuitem" aria-label={t("settings.logins.onePassword.title")} className={item} onClick={() => pick("onepassword")}><Icon name="vault" size={16} className="relative" /><span className="relative">{t("settings.logins.onePassword.title")}</span></button>
        </div>
      )}
    </div>
  );
}

type VaultTab = "all" | "saved" | "secrets" | "onepassword";

/** Remove beside a Vault item a bot's last use may have found wrong: a second press removes it for good. */
function CheckRemove({ label, confirming, disabled, onPress }: { label: string; confirming: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <button type="button" data-vault-remove="" disabled={disabled} onClick={onPress}
      aria-label={confirming ? t("settings.secrets.removeConfirm") : t("settings.secrets.removeFor", { label })}
      className={cn("me-1 inline-flex h-7 shrink-0 cursor-pointer items-center rounded-full px-2.5 text-[13px] leading-[18px] text-ink-secondary hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:cursor-default",
        confirming && "bg-danger text-danger-ink hover:bg-danger hover:text-danger-ink")}>
      {confirming ? t("settings.secrets.removeConfirm") : t("settings.secrets.remove")}
    </button>
  );
}

/** "needs checking", after a hint, for an item a bot's last use may have found wrong. */
const checkTag = (marked: number | undefined) => marked === undefined ? null : <span className="text-danger" data-vault-needs-check=""> · {t("settings.vault.needsCheck")}</span>;

/** One Vault item as Grok draws it: a 24px tile, the name, one grey line, a chevron; ink 6% on hover. */
function VaultRow({ tile, title, hint, detail, onClick, disabled, label }: {
  tile: ReactNode; title: ReactNode; hint: ReactNode; detail?: string; onClick?: () => void; disabled?: boolean; label?: string;
}) {
  const body = (
    <>
      <span aria-hidden="true" className="flex w-[30px] shrink-0 justify-center">{tile}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium leading-[18px] text-ink">{title}</span>
        <span className="truncate text-[12px] leading-4 text-ink-secondary">{hint}</span>
      </span>
      {onClick && <Icon name="chevron-right" size={12} className="shrink-0 text-ink/[0.56]" />}
    </>
  );
  const cls = "flex min-h-[50px] w-full items-center gap-3 rounded-md p-2 text-start";
  return onClick
    ? <button type="button" title={detail} aria-label={label} disabled={disabled} onClick={onClick} className={cn(cls, "cursor-pointer hover:bg-ink/[0.06] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus disabled:cursor-default")}>{body}</button>
    : <div title={detail} className={cls}>{body}</div>;
}

function KeyTile() {
  return <span className="flex size-6 items-center justify-center rounded-md border border-transparent bg-app text-ink/[0.68]"><Icon name="key" size={14} /></span>;
}

/** A login's site as Grok's rounded tile: the site's own icon once it loads, its first letter on a faint fill until
 * then or when the site has none. */
function SiteTile({ site }: { site: string }) {
  const icon = siteIconUrl(site.replace(/^www\./, ""));
  const [loaded, setLoaded] = useState<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const shown = loaded === site;
  return (
    <span aria-hidden="true" className={cn("relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border-[0.5px] border-transparent text-[12px] font-medium uppercase text-ink-secondary", !shown && "bg-ink/[0.04]")}>
      {!shown && site.replace(/^www\./, "").charAt(0)}
      {icon && missing !== site && (
        <img src={icon} alt="" width={16} height={16} draggable={false} decoding="async" onLoad={() => setLoaded(site)} onError={() => setMissing(site)}
          className={cn("absolute size-4 object-contain", !shown && "opacity-0")} />
      )}
    </span>
  );
}

function vaultPlaceOf(
  place: ReturnType<typeof useWindowPlace>,
  config: Pick<ConfigStatus, "cloudHome" | "team"> | null | undefined,
  color?: unknown,
): ReturnType<typeof windowPlaceMark> | null {
  if (place) return windowPlaceMark(place, config?.team?.name, color);
  if (config?.team?.name) return { kind: "team", name: config.team.name, color: color ?? null };
  if (config?.cloudHome) return { kind: "cloud", name: t("cloudSetup.myCloud"), color: color ?? null };
  return null;
}

export function LoginsSettings() {
  const { state } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const windowPlace = useWindowPlace();
  const placeLook = usePlaceLook();
  const bots = state.bots.map((bot) => ({ id: bot.id, name: bot.name }));
  const [logins, setLogins] = useState<LoginSummary[] | null>(null);
  const [onePassword, setOnePassword] = useState<OnePasswordStatus>({ connected: false });
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [site, setSite] = useState("");
  const [addBots, setAddBots] = useState<LoginBots>("all");
  const [addExact, setAddExact] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editBots, setEditBots] = useState<LoginBots>("all");
  const [editExact, setEditExact] = useState(false);
  const [removeTotp, setRemoveTotp] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<VaultTab>("all");
  const [query, setQuery] = useState("");
  const saved_secrets = useSavedSecrets(ownerOrAdmin === true);
  const [openSecret, setOpenSecret] = useState<SavedSecretSummary | null>(null);
  const [removingSecret, setRemovingSecret] = useState<string | null>(null);
  const [connectNonce, setConnectNonce] = useState(0);
  const request = useSyncExternalStore(subscribeVault, () => vaultRequest, () => vaultRequest);
  const [seen, setSeen] = useState(request?.nonce ?? 0);
  if (request && request.nonce !== seen) {
    setSeen(request.nonce);
    if (request.kind === "login") { setEditing(null); setDeleting(null); setAdding(true); }
    else setConnectNonce(request.nonce);
  }

  const load = async () => {
    try {
      const answer = await listLogins();
      setLogins(answer.logins);
      setOnePassword(answer.onePassword ?? { connected: false });
      setError(null);
    }
    catch (cause) { setError(friendlyError(cause, t("settings.logins.loadError"))); }
  };
  useEffect(() => { if (ownerOrAdmin) void load(); }, [ownerOrAdmin]);

  if (ownerOrAdmin === false) {
    return <Card subtitle={t("settings.logins.adminOnly")} />;
  }

  const botNames = (value: LoginBots) => {
    if (value === "all") return t("settings.logins.allBots");
    const names = value.flatMap((id) => bots.find((bot) => bot.id === id)?.name ?? []);
    return names.length ? names.join(", ") : t("settings.logins.noBots");
  };
  const startEdit = (login: LoginSummary) => {
    setAdding(false);
    setDeleting(null);
    setRemoveTotp(false);
    setEditBots(login.bots);
    setEditExact(login.exactHost);
    setEditing(login.id);
  };
  const removeSecret = async (secret: SavedSecretSummary) => {
    if (removingSecret !== secret.id) { setRemovingSecret(secret.id); return; }
    setBusy(true);
    try { await saved_secrets.remove(secret); setRemovingSecret(null); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    if (deleting !== id) { setDeleting(id); return; }
    setBusy(true);
    try { await deleteLogin(id); setDeleting(null); setEditing(null); await load(); }
    catch (cause) { setError(friendlyError(cause, t("settings.logins.deleteError"))); }
    finally { setBusy(false); }
  };

  const loginForm = (title: string, onClose: () => void, form: ReactNode) => (
    <DialogPane.Provider value={false}>
      <GrokDialog data-panel-modal="login" title={title} description={t("logins.private")} onClose={onClose}>{form}</GrokDialog>
    </DialogPane.Provider>
  );
  const editingLogin = logins?.find((login) => login.id === editing);
  const saved = (logins ?? []).filter((login) => login.source !== "1password");
  const fromVaults = (logins ?? []).filter((login) => login.source === "1password");
  const secrets = saved_secrets.secrets ?? [];
  const tabs: Array<{ id: VaultTab; label: string; count: number }> = [
    { id: "all", label: t("settings.vault.all"), count: (logins?.length ?? 0) + secrets.length },
    { id: "saved", label: t("settings.section.logins"), count: saved.length },
    { id: "secrets", label: t("settings.vault.secrets"), count: secrets.length },
    ...(onePassword.connected || fromVaults.length ? [{ id: "onepassword" as const, label: t("settings.logins.onePassword.title"), count: fromVaults.length }] : []),
  ];
  const words = query.trim().toLowerCase();
  const shown = (tab === "saved" ? saved : tab === "onepassword" ? fromVaults : tab === "secrets" ? [] : logins ?? [])
    .filter((login) => !words || `${login.site} ${login.username} ${login.hosts.join(" ")}`.toLowerCase().includes(words));
  const shownSecrets = (tab === "all" || tab === "secrets" ? secrets : []).filter((secret) => !words || secret.label.toLowerCase().includes(words));
  const ready = (logins !== null || error !== null) && saved_secrets.secrets !== null;
  const nothing = ready && logins !== null && logins.length === 0 && secrets.length === 0;
  const secretHint = (secret: SavedSecretSummary) => [botNames(secret.bots),
    secret.lastUsedAt ? t("settings.logins.used", { when: relativeTime(secret.lastUsedAt) }) : t("settings.logins.neverUsed")].join(" · ");
  // nothing until the list is in: a frame that fills a moment later reads as "empty" first
  if (!ready) return null;
  const vaultPlace = vaultPlaceOf(windowPlace, state.config, placeLook?.color);

  return (
    <>
      <section data-settings-block="logins" aria-label={t("settings.section.logins")} className="flex scroll-mt-4 flex-col gap-4">
        {vaultPlace && (
          <p data-vault-place="" className="flex items-start gap-1.5 px-2.5 text-[12px] leading-4 text-ink-secondary">
            <PlaceMark place={vaultPlace} size={16} />
            <span className="min-w-0">
              <span className="font-medium text-ink" dir="auto">{vaultPlace.name}</span>
              {" · "}
              {t("settings.vault.placeOnly")}
            </span>
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div role="tablist" aria-label={t("settings.section.logins")} className="flex items-center gap-1">
            {tabs.map((entry) => (
              <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} data-vault-tab={entry.id} onClick={() => setTab(entry.id)}
                className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[13px] leading-[18px] text-ink-secondary hover:text-ink aria-selected:bg-ink/[0.06] aria-selected:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus">
                {entry.label}<span className={cn("min-w-[1ch] text-ink/[0.56] tabular-nums", !ready && "invisible")}>{entry.count}</span>
              </button>
            ))}
          </div>
          <label className="flex h-8 w-[160px] max-w-full items-center gap-2 rounded-full border border-transparent bg-ink/[0.04] ps-[7px] pe-2 text-ink-secondary">
            <Icon name="search" size={14} />
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("settings.vault.search")} placeholder={t("settings.vault.search")}
              className="h-full min-w-0 flex-1 border-0! bg-transparent p-0 text-[13px] leading-[18px] text-ink outline-none placeholder:text-ink-secondary [&::-webkit-search-cancel-button]:hidden" />
          </label>
        </div>
        {nothing ? <ArtState data-art-state="vault" art="key" title={t("settings.docs.vault.empty")}>{t("settings.docs.vault.emptyBody")}</ArtState> : <>
          <div aria-busy={!ready || busy} className={SIMPLE_CARD}>
            {ready && logins !== null && shown.length + shownSecrets.length === 0 && <NoteRow>{words ? t("settings.vault.noMatch") : t("settings.vault.noneHere")}</NoteRow>}
            {ready && !!shown.length && (
              <ul className="flex flex-col" data-logins-list>
                {shown.map((login) => {
                  const details = [t(SOURCE_KEYS[login.source]), botNames(login.bots),
                    login.lastUsedAt ? t("settings.logins.used", { when: relativeTime(login.lastUsedAt) }) : t("settings.logins.neverUsed")].join(" · ");
                  const hosts = signInHostsLine(login);
                  const title = <span dir="ltr">{login.site}{login.hasTotp && <span className="font-normal text-ink-secondary"> · {t("settings.logins.twoFactor")}</span>}</span>;
                  const hint = <span dir="auto">{login.username || t("settings.logins.noUsername")}{hosts && <span data-login-hosts> · {hosts}</span>}{checkTag(login.needsCheck)}</span>;
                  return (
                    <li key={login.id} className="flex items-center" data-login-row={login.site} data-login-detail={details}>
                      <div className="min-w-0 flex-1">
                        <VaultRow tile={<SiteTile site={login.site} />} title={title} hint={hint} detail={details}
                          {...(login.source === "1password" ? {} : { onClick: () => startEdit(login), disabled: busy, label: t("settings.logins.changeFor", { site: login.site }) })} />
                      </div>
                      {login.needsCheck !== undefined && login.source !== "1password" &&
                        <CheckRemove label={login.site} confirming={deleting === login.id && !editing} disabled={busy} onPress={() => { setEditing(null); void remove(login.id); }} />}
                    </li>
                  );
                })}
              </ul>
            )}
            {ready && !!shownSecrets.length && (
              <ul className="flex flex-col" data-saved-secrets="">
                {shownSecrets.map((secret) => (
                  <li key={secret.id} className="flex items-center" data-saved-secret={secret.label}>
                    <div className="min-w-0 flex-1">
                      <VaultRow tile={<KeyTile />} title={secret.label} hint={<>{secretHint(secret)}{checkTag(secret.needsCheck)}</>} onClick={() => setOpenSecret(secret)} label={secret.label} />
                    </div>
                    {secret.needsCheck !== undefined && <CheckRemove label={secret.label} confirming={removingSecret === secret.id} disabled={busy} onPress={() => void removeSecret(secret)} />}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p data-settings-footnote="" className="-mt-2 px-2 text-[12px] leading-4 text-ink/[0.56]">{t("settings.vault.footnote")}</p>
        </>}
        {(error ?? saved_secrets.error) && (
          <div className="flex items-center justify-between gap-2 px-3">
            <p role="alert" className="m-0 text-[12px] leading-4 text-danger">{error ?? saved_secrets.error}</p>
            {logins === null && error && <button type="button" className="ui-button shrink-0" onClick={() => void load()}>{t("common.tryAgain")}</button>}
          </div>
        )}
      </section>
      <AnimatePresence>{openSecret && <SavedSecretDialog key="saved-secret" secret={openSecret} hint={secretHint(openSecret)} onClose={() => setOpenSecret(null)}
        onRemove={async () => { await saved_secrets.remove(openSecret); setOpenSecret(null); }} />}</AnimatePresence>
      <AnimatePresence>{adding && loginForm(t("settings.logins.add"), () => setAdding(false),
        <LoginForm site={{ value: site, onChange: setSite }} compact submitLabel={t("settings.logins.save")} autoFocus
          onCancel={() => setAdding(false)}
          onSubmit={async (fields) => {
            await addLogin(site, fields, addBots, addExact);
            setAdding(false);
            setSite("");
            setAddBots("all");
            setAddExact(false);
            await load();
          }}>
          <ExactHostChoice checked={addExact} onChange={setAddExact} label={t("settings.logins.exactHost")} />
          <LoginBotPicker value={addBots} onChange={setAddBots} bots={bots} />
        </LoginForm>,
      )}</AnimatePresence>
      <AnimatePresence>{editingLogin && loginForm(editingLogin.site, () => setEditing(null),
        <>
          <LoginForm username={false} replacing compact submitLabel={t("settings.logins.saveChange")} autoFocus
            onCancel={() => setEditing(null)}
            onSubmit={async (fields) => {
              await changeLogin(editingLogin.id, { password: fields.password, totp: fields.totp, removeTotp, bots: editBots, ...(editExact === editingLogin.exactHost ? {} : { exactHost: editExact }) });
              setEditing(null);
              await load();
            }}>
            {editingLogin.hasTotp && <div className="-mx-2"><SwitchRow title={t("settings.logins.removeTotp")} checked={removeTotp} onChange={() => setRemoveTotp(!removeTotp)} /></div>}
            <ExactHostChoice checked={editExact} onChange={setEditExact}
              label={t("settings.logins.exactHostFor", { hosts: editingLogin.hosts.join(", "), site: editingLogin.site })} />
            <LoginBotPicker value={editBots} onChange={setEditBots} bots={bots} />
          </LoginForm>
          <div className="mt-3 flex justify-start">
            <button type="button" className={cn(mdSecondaryCls, deleting === editingLogin.id && "bg-danger text-danger-ink enabled:hover:bg-danger")} disabled={busy}
              onClick={() => void remove(editingLogin.id)}
              aria-label={deleting === editingLogin.id ? t("settings.logins.deleteConfirm") : t("settings.logins.deleteFor", { site: editingLogin.site })}>
              {deleting === editingLogin.id ? t("settings.logins.deleteConfirm") : t("settings.logins.delete")}
            </button>
          </div>
        </>,
      )}</AnimatePresence>
      <OnePasswordConnection status={onePassword} disabled={logins === null} bots={bots} botNames={botNames} openNonce={connectNonce}
        onChange={async (next) => { setOnePassword(next); await load(); }} />
    </>
  );
}

/** Where a login signs in beyond its site's own pages, or that it is kept to those hosts. */
function signInHostsLine(login: LoginSummary): string | null {
  if (login.exactHost) return t("settings.logins.onlyOn", { hosts: login.hosts.join(", ") });
  const elsewhere = login.hosts.filter((host) => host !== login.site);
  return elsewhere.length ? t("settings.logins.signsInOn", { hosts: elsewhere.join(", ") }) : null;
}

function ExactHostChoice({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="flex items-start gap-2 text-[13px] leading-[18px] text-ink">
      <input type="checkbox" name="exactHost" className="mt-[2px]" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function VaultAccess({ vault, bots, botNames, disabled, onChange }: {
  vault: OnePasswordVault;
  bots: ReadonlyArray<{ id: string; name: string }>;
  botNames: (value: LoginBots) => string;
  disabled: boolean;
  onChange: (status: OnePasswordStatus) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<LoginBots>(vault.bots);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try { await onChange(await grantVault(vault.id, value)); setEditing(false); }
    catch (cause) { setError(friendlyError(cause, t("settings.logins.onePassword.error"))); }
    finally { setBusy(false); }
  };
  return (
    <li className="flex flex-col" data-vault={vault.title}>
      <NavRow title={vault.title} hint={t("settings.logins.onePassword.vaultUse", { count: String(vault.items), who: botNames(vault.bots) })}
        disabled={disabled || busy} aria-expanded={editing} aria-label={t("settings.logins.onePassword.changeVault", { vault: vault.title })}
        onClick={() => { setValue(vault.bots); setEditing(!editing); }} />
      {editing && (
        <div className="flex flex-col gap-2 px-2 pb-2 pt-1">
          <LoginBotPicker value={value} onChange={setValue} bots={bots} disabled={busy} />
          {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="ui-button" disabled={busy} onClick={() => setEditing(false)}>{t("logins.cancel")}</button>
            <button type="button" className="ui-button ui-button-primary" disabled={busy} onClick={() => void save()}>{t("settings.logins.saveChange")}</button>
          </div>
        </div>
      )}
    </li>
  );
}

function OnePasswordConnection({ status, disabled, bots, botNames, onChange, openNonce }: {
  openNonce: number;
  status: OnePasswordStatus;
  disabled: boolean;
  bots: ReadonlyArray<{ id: string; name: string }>;
  botNames: (value: LoginBots) => string;
  onChange: (status: OnePasswordStatus) => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"connect" | "refresh" | "disconnect" | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // New item → 1Password opens the token dialog; nothing about 1Password shows until it is connected.
  const [seenNonce, setSeenNonce] = useState(openNonce);
  if (openNonce !== seenNonce) { setSeenNonce(openNonce); if (!status.connected) setConnecting(true); }
  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<OnePasswordStatus>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try { await onChange(await work()); if (kind === "connect") { setToken(""); setConnecting(false); } }
    catch (cause) { setError(friendlyError(cause, t("settings.logins.onePassword.error"))); }
    finally { setBusy(null); }
  };
  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim()) void run("connect", () => connectOnePassword(token.trim()));
  };
  const tokenDialog = <AnimatePresence>{connecting && (
    <DialogPane.Provider value={false}>
      <GrokDialog data-panel-modal="onepassword" title={t("settings.logins.onePassword.title")} description={t("settings.w6c.logins.onePasswordGuide")} onClose={() => setConnecting(false)}>
        <form className="flex flex-col gap-3" onSubmit={connect}>
          <input name="onePasswordToken" type="password" autoComplete="off" spellCheck={false} maxLength={8192} value={token} data-autofocus
            onChange={(event) => setToken(event.target.value)} disabled={disabled || busy !== null}
            aria-label={t("settings.logins.onePassword.token")} placeholder={t("settings.logins.onePassword.token")}
            className={textFieldCls} />
          {error && <p role="alert" className="m-0 text-[12px] leading-4 text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={mdSecondaryCls} onClick={() => setConnecting(false)}>{t("common.cancel")}</button>
            <button type="submit" className={mdPrimaryCls} disabled={disabled || busy !== null || !token.trim()}>
              {busy === "connect" && <Loader2 size={13} className="animate-spin" />}{t("settings.logins.onePassword.connect")}
            </button>
          </div>
        </form>
      </GrokDialog>
    </DialogPane.Provider>
  )}</AnimatePresence>;
  if (!status.connected) return tokenDialog;
  return (
    <SettingsGroup label={t("settings.logins.onePassword.title")} block="onepassword">
      <section aria-label={t("settings.logins.onePassword.title")} data-onepassword>
        <SettingsRows>
          <>
              <ItemRow title={t("settings.logins.onePassword.title")}
                hint={t("settings.logins.onePassword.connected", { vaults: (status.vaults ?? []).map((vault) => vault.title).join(", ") || "-", count: String(status.items ?? 0) })} />
              {status.error && <NoteRow tone="danger">{status.error}</NoteRow>}
              {!!status.vaults?.length && (
                <ul className="flex flex-col" aria-label={t("settings.logins.onePassword.vaults")}>
                  {status.vaults.map((vault) => <VaultAccess key={vault.id} vault={vault} bots={bots} botNames={botNames} disabled={disabled} onChange={onChange} />)}
                </ul>
              )}
              <NavRow drill={false} disabled={disabled || busy !== null} title={t("settings.logins.onePassword.refresh")}
                value={busy === "refresh" ? <Loader2 size={13} className="animate-spin" /> : undefined} onClick={() => void run("refresh", refreshOnePassword)} />
              <NavRow drill={false} disabled={disabled || busy !== null} title={t("settings.logins.onePassword.disconnect")} onClick={() => void run("disconnect", disconnectOnePassword)} />
          </>
        </SettingsRows>
        {error && !connecting && <p role="alert" className="mt-2 px-3 text-[12px] leading-4 text-danger">{error}</p>}
      </section>
    </SettingsGroup>
  );
}
