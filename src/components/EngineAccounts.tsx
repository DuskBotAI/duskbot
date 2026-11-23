import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { Loader2, MoreHorizontal, Plus } from "../icons";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { LocaleKey } from "@/locales";
import { ConfirmDialog } from "./ConfirmDialog";
import { PixelIcon } from "./ui/PixelIcon";
import { ClaudeSignIn } from "./ClaudeSignIn";
import { DeviceSignIn, deviceSignInProvider } from "./DeviceSignIn";
import { ChatGptPlanStatus } from "./ChatGptPlanStatus";
import { EngineCard, engineReady, providerName, type EngineCardSummary } from "./EngineLibrary";
import { CommandRow, EngineSetup, EngineUpdateNotice, EngineWarningNotice } from "./EngineSetup";
import { MENU_SHEET } from "./menu-recipe";
import { useMenuMotion } from "./MenuMotion";
import { Card as RowsCard, FormDialog, FormField, NavRow, NoteRow, rowCls } from "./ListRows";
import { textFieldCls } from "./ui/GrokDialog";
import { friendlyError } from "@/lib/plain-error";

/** Providers whose accounts are listed together on one card, each signed in on its own. */
export type AccountGroup = "claude" | "chatgpt";

export function accountGroupOf(instance: InstanceInfo): AccountGroup | null {
  if (instance.readOnly || instance.access === "custom" || instance.access === "api") return null;
  if (instance.driverKind === "claudeAgent") return "claude";
  const method = instance.authentication?.method;
  return instance.snapshot.chatgptPlan === true || ((method === "device-code" || method === "browser-pkce") && deviceSignInProvider(instance.driverKind) === "codex")
    ? "chatgpt" : null;
}

type AccountState = "signedIn" | "signedOut" | "unknown" | "unavailable";

function accountState(instance: InstanceInfo): AccountState {
  if (instance.snapshot.state !== "available") return "unavailable";
  return instance.snapshot.authenticated === true ? "signedIn" : instance.snapshot.authenticated === false ? "signedOut" : "unknown";
}

const COPY: Record<AccountGroup, Record<"title" | "add", LocaleKey>> = {
  claude: { title: "accounts.claude", add: "accounts.addClaude" },
  chatgpt: { title: "accounts.chatgpt", add: "accounts.addChatgpt" },
};

/** What an account's menu offers. Only accounts added here can be removed; each provider's first account stays. */
export function accountActions(group: AccountGroup, instance: InstanceInfo): { signOut: boolean; remove: boolean } {
  return {
    signOut: accountState(instance) === "signedIn" && instance.authentication?.signOut === true && instance.snapshot.account?.method !== "api-key",
    remove: group === "claude" ? instance.instanceId !== "claude" && instance.claudeAccount?.isDefault !== true : instance.instanceId.startsWith("chatgpt-"),
  };
}

/** Why the account can't be removed yet: bots run on it, or new bots start on it. Null when nothing does. */
export function accountInUse(
  instance: Pick<InstanceInfo, "instanceId">,
  bots: ReadonlyArray<{ modelSelection: { instanceId: string } }>,
  defaultModel: { instanceId: string } | undefined,
): string | null {
  const usedBy = bots.filter((bot) => bot.modelSelection.instanceId === instance.instanceId).length;
  if (usedBy > 0) return t("accounts.inUse", { count: String(usedBy) });
  return defaultModel?.instanceId === instance.instanceId ? t("accounts.newBotModel") : null;
}

/** Ready while any account can run a turn: the same rule a single provider card uses. */
export function accountsReady(accounts: InstanceInfo[]): boolean {
  return accounts.some(engineReady);
}

function summaryFor(group: AccountGroup, accounts: InstanceInfo[]): EngineCardSummary {
  const signedIn = accounts.filter((instance) => accountState(instance) === "signedIn");
  const ready = accountsReady(accounts);
  const installed = accounts.some((instance) => instance.snapshot.state === "available");
  const subtitle = accounts.length > 1
    ? t("accounts.count", { count: String(accounts.length), signedIn: String(signedIn.length) })
    : signedIn[0]?.snapshot.account?.email ?? providerName(accounts[0]!);
  return {
    title: t(COPY[group].title),
    subtitle,
    ready,
    status: ready ? t("onboarding.engines.ready") : installed ? t("model.signInRequired") : t("onboarding.engines.needsSetup"),
    action: ready ? t("engines.library.manage") : installed ? t("accounts.signIn") : t("engines.library.setup"),
  };
}

function AccountMenu({ group, instance, onRename }: { group: AccountGroup; instance: InstanceInfo; onRename: () => void }) {
  const { state, dispatch, refreshInstances } = useStore();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<"signOut" | "remove" | null>(null);
  const menu = useMenuMotion(open);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { signOut: canSignOut, remove: canRemove } = accountActions(group, instance);
  const inUse = accountInUse(instance, state.bots, state.config?.defaultModelSelection);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const run = async (action: "signOut" | "remove") => {
    setConfirm(null);
    setBusy(true);
    setError(null);
    try {
      const path = `/api/instances/${encodeURIComponent(instance.instanceId)}${action === "signOut" ? "/auth/sign-out" : ""}`;
      const { instances } = await api(path, action === "signOut" ? { method: "POST" } : { method: "DELETE" });
      // The response is the confirmed state: a second request could fail and leave a stale row.
      if (Array.isArray(instances)) dispatch({ type: "instances", instances });
      else await refreshInstances().catch(() => {});
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  };

  const item = "ui-menu-row w-full text-left disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <div ref={menuRef} className="relative flex items-center gap-1">
      {canRemove && <button type="button" disabled={busy || inUse !== null} onClick={() => setConfirm("remove")}
        title={inUse ?? undefined}
        className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50">
        {t("accounts.remove")}
      </button>}
      <button type="button" onClick={() => setOpen((value) => !value)} disabled={busy} aria-haspopup="menu" aria-expanded={open}
        aria-label={t("accounts.menu", { name: instance.displayName })}
        className="flex size-8 items-center justify-center rounded-lg text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50">
        {busy ? <Loader2 size={14} className="animate-spin" /> : <MoreHorizontal size={16} />}
      </button>
      {menu.shown && (
        <div role="menu" {...menu.exitProps} className={cn("absolute right-0 top-full z-40 mt-1 w-[220px] origin-top-right overflow-hidden text-[13px]", MENU_SHEET, menu.className)}>
          <button type="button" role="menuitem" className={cn(item, "text-ink")} onClick={() => { setOpen(false); onRename(); }}>{t("accounts.rename")}</button>
          {canSignOut && <button type="button" role="menuitem" className={cn(item, "text-ink")} onClick={() => { setOpen(false); setConfirm("signOut"); }}>{t("accounts.signOut")}</button>}
          {canRemove && inUse && <p className="px-3 pb-1 pt-0.5 text-[11px] leading-snug text-ink-secondary">{inUse}</p>}
        </div>
      )}
      {error && <p role="alert" className="absolute right-0 top-full z-30 mt-1 w-[260px] rounded-lg bg-card p-2 text-[12px] text-danger shadow-lg">{error}</p>}
      <ConfirmDialog
        open={confirm === "signOut"}
        art={<PixelIcon name="key" size={28} />}
        title={t("accounts.signOutTitle", { name: instance.displayName })}
        body={t(instance.snapshot.chatgptPlan === true ? "confirm.signOutStopsWork" : "confirm.signOut")}
        confirmLabel={t("accounts.signOut")}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void run("signOut")}
      />
      <ConfirmDialog
        open={confirm === "remove"}
        art={<PixelIcon name="key" size={28} />}
        title={t("accounts.removeTitle", { name: instance.displayName })}
        body={t("confirm.accountRemove")}
        confirmLabel={t("accounts.remove")}
        tone="neutral"
        onCancel={() => setConfirm(null)}
        onConfirm={() => void run("remove")}
      />
    </div>
  );
}

function RenameForm({ instance, onDone }: { instance: InstanceInfo; onDone: () => void }) {
  const { dispatch } = useStore();
  const [name, setName] = useState(instance.displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const next = name.trim();
    if (!next || next === instance.displayName) return onDone();
    setSaving(true);
    setError(null);
    try {
      const { instances } = await api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, { method: "PATCH", body: JSON.stringify({ displayName: next }) });
      if (Array.isArray(instances)) dispatch({ type: "instances", instances });
      onDone();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <FormDialog data-panel-modal="rename-account" title={t("accounts.rename")} busy={saving} canSave={Boolean(name.trim())}
      error={error ?? undefined} onSave={save} onClose={onDone}>
      <FormField label={t("accounts.nameLabel")}>
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus disabled={saving}
          aria-label={t("accounts.nameLabel")} className={textFieldCls} />
      </FormField>
    </FormDialog>
  );
}

function AccountRow({ group, instance, signingIn, onSignIn, onSignInDone }: {
  group: AccountGroup;
  instance: InstanceInfo;
  signingIn: boolean;
  onSignIn: () => void;
  onSignInDone: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const state = accountState(instance);
  const account = instance.snapshot.account;
  // This server cannot run the provider's sign-in (a remote browser for a local-only flow): say why, offer nothing.
  const blocked = instance.snapshot.authenticationUnavailableReason;
  const detail = blocked && state !== "signedIn" ? blocked : state === "signedIn"
    ? account?.method === "api-key" ? t("accounts.apiKey") : [account?.email, account?.organization].filter(Boolean).join(" · ") || t("accounts.signedIn")
    : state === "signedOut" ? t("accounts.notSignedIn")
    : state === "unknown" ? t("accounts.unknown")
    : instance.snapshot.reason ?? t("onboarding.engines.needsSetup");

  return (
    <li data-account={instance.instanceId} data-account-state={state} className={cn(rowCls, "flex-col items-stretch gap-1.5")}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", state === "signedIn" ? "bg-success" : state === "signedOut" ? "bg-warning" : "bg-ink-tertiary")} />
        <div className="min-w-0 flex-1">
          <div data-row-title="" className="truncate text-[13px] leading-[18px] text-ink" title={instance.displayName}>{instance.displayName}</div>
          <div data-row-hint="" className="truncate text-[12px] leading-4 text-ink-secondary" title={detail}>{detail}</div>
        </div>
        {state !== "signedIn" && state !== "unavailable" && !blocked && !signingIn && (
          <button type="button" onClick={onSignIn} className={state === "signedOut" ? "ui-button ui-button-primary" : "ui-button"}>
            {t("accounts.signIn")}
          </button>
        )}
        <AccountMenu group={group} instance={instance} onRename={() => setRenaming(true)} />
      </div>
      <AnimatePresence>{renaming && <RenameForm key="rename-form" instance={instance} onDone={() => setRenaming(false)} />}</AnimatePresence>
      {signingIn && (
        <div className="ps-4">
          {group === "claude"
            ? <>
              <ClaudeSignIn instanceId={instance.instanceId} autoStart onDone={onSignInDone} />
              {/* the terminal way, as one row: the command with copy (and open, where a terminal can be) */}
              {instance.claudeAccount?.signInCommand && <CommandRow command={instance.claudeAccount.signInCommand} actionLabel={t("engineSetup.openSignIn")} compact />}
            </>
            : <DeviceSignIn instanceId={instance.instanceId} provider="codex" browserPkce={instance.authentication?.method === "browser-pkce"} autoStart onDone={onSignInDone} />}
        </div>
      )}
      {group === "chatgpt" && state === "signedIn" && instance.snapshot.chatgptPlan && (
        <div className="ps-4"><ChatGptPlanStatus instanceId={instance.instanceId} welcome={false} /></div>
      )}
    </li>
  );
}

/** Names a new account and hands its id back, so the caller can start its sign-in at once. */
export function AddAccount({ label, endpoint, extra, folder: offerFolder = false, onAdded }: {
  label: string;
  endpoint: string;
  extra?: Record<string, unknown>;
  folder?: boolean;
  onAdded: (instanceId: string, displayName: string) => void;
}) {
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    const displayName = name.trim();
    if (saving || !displayName) return;
    setSaving(true);
    setError(null);
    try {
      const body = { displayName, ...extra, ...(offerFolder && folder.trim() ? { configDir: folder.trim() } : {}) };
      const created = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
      if (Array.isArray(created.instances)) dispatch({ type: "instances", instances: created.instances });
      setOpen(false);
      setName("");
      setFolder("");
      if (typeof created.instanceId === "string") {
        const added = Array.isArray(created.instances)
          ? (created.instances as InstanceInfo[]).find((entry) => entry.instanceId === created.instanceId)
          : undefined;
        onAdded(created.instanceId, added?.displayName ?? displayName);
      }
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <NavRow data-add-account-row={endpoint} icon={Plus} title={label} drill={false} onClick={() => setOpen(true)} />
      <AnimatePresence>{open && (
        <FormDialog key="add-account" data-panel-modal="add-account" title={label} description={offerFolder ? t("settings.s2.accounts.folderHint") : undefined}
          saveLabel={t("accounts.addSubmit")} canSave={Boolean(name.trim())} busy={saving} error={error ?? undefined}
          onSave={add} onClose={() => { setOpen(false); setError(null); }}>
          <div data-add-account={endpoint} className="contents">
            <FormField label={t("accounts.nameLabel")}>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("accounts.namePlaceholder")} maxLength={80} autoFocus required disabled={saving} className={textFieldCls} />
            </FormField>
            {offerFolder && (
              <FormField label={t("settings.s2.accounts.folder")}>
                <input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="~/.claude-work" maxLength={4096} spellCheck={false} disabled={saving}
                  aria-label={t("accounts.folderToggle")} className={cn(textFieldCls, "font-mono text-[12px]")} />
              </FormField>
            )}
          </div>
        </FormDialog>
      )}</AnimatePresence>
    </>
  );
}

/** One card for a provider's accounts: who is signed in, one button for whoever is not, and one way to add another. */
export function AccountsCard({ group, accounts, advanced, bare = false }: { group: AccountGroup; accounts: InstanceInfo[]; advanced?: ReactNode; bare?: boolean }) {
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const primary = accounts[0]!;
  const installed = accounts.some((instance) => instance.snapshot.state === "available");
  const policy = accounts.find((instance) => instance.policy)?.policy;
  return (
    <EngineCard instance={primary} summary={summaryFor(group, accounts)} bare={bare}>
      {policy && <RowsCard><NoteRow><span className="text-ink">{t("policy.managedBy", { organization: policy.organizationName })}</span> · {policy.reason}</NoteRow></RowsCard>}
      {!installed ? <EngineSetup instance={primary} unframed rows={bare} /> : (
        <RowsCard>
          <ul data-accounts={group} className="contents">
            {accounts.map((instance) => (
              <AccountRow key={instance.instanceId} group={group} instance={instance}
                signingIn={signingIn === instance.instanceId}
                onSignIn={() => setSigningIn(instance.instanceId)}
                onSignInDone={() => setSigningIn((current) => current === instance.instanceId ? null : current)} />
            ))}
          </ul>
          {!primary.snapshot.authenticationUnavailableReason && <AddAccount label={t(COPY[group].add)} endpoint={`/api/instances/${group}-accounts`} folder={group === "claude"} onAdded={setSigningIn} />}
        </RowsCard>
      )}
      {(primary.snapshot.update || primary.snapshot.warning) && (
        <RowsCard>
          {primary.snapshot.update && <EngineUpdateNotice update={primary.snapshot.update} instance={primary} quiet rows />}
          {primary.snapshot.warning && <EngineWarningNotice warning={primary.snapshot.warning} rows />}
        </RowsCard>
      )}
      {advanced}
    </EngineCard>
  );
}
