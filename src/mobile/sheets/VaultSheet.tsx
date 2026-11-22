import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, KeyRound, Plus } from "../../icons";
import { t } from "@/lib/i18n";
import { deleteLogin, listLogins } from "@/lib/logins";
import { systemDialogs } from "@/lib/system-dialog";
import { api, useStore } from "@/state/store";
import type { LoginBots, LoginSummary } from "../../../shared/logins";
import type { SavedSecretSummary } from "../../../shared/saved-secrets";
import { Sheet } from "../Sheet";
import { SheetPush } from "../SheetPush";
import { EmptyState } from "../Illustration";
import { haptic } from "../haptics";
import type { SheetPageProps } from "./registry";

type VaultEntry = { kind: "login"; value: LoginSummary } | { kind: "secret"; value: SavedSecretSummary };

/** What the list shows: the skeleton only before the first answer, so a reload keeps the rows in place. */
export function vaultView(input: { loaded: boolean; loading: boolean; error: boolean; count: number }): "skeleton" | "list" | "empty" | "error" {
  if (input.count > 0) return "list";
  if (!input.loaded && input.loading) return "skeleton";
  if (input.error) return "error";
  return input.loading ? "skeleton" : "empty";
}

function VaultTile() {
  return <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-ink-secondary"><KeyRound size={20} /></span>;
}

export function VaultSheet({ open, onClose }: SheetPageProps<"vault">) {
  const { state, dispatch } = useStore();
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [selected, setSelected] = useState<VaultEntry | null>(null);
  const lastSelected = useRef<VaultEntry | null>(null);
  if (selected) lastSelected.current = selected;
  const shown = selected ?? lastSelected.current;
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const deleting = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const requestVersion = useRef(0);
  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const [logins, secrets] = await Promise.all([listLogins(), api<{ secrets?: SavedSecretSummary[] }>("/api/saved-secrets")]);
      if (version === requestVersion.current) setLoaded(true);
      if (version === requestVersion.current) setEntries([...logins.logins.map((value): VaultEntry => ({ kind: "login", value })), ...(secrets.secrets ?? []).map((value): VaultEntry => ({ kind: "secret", value }))]);
    } catch { if (version === requestVersion.current) { setError(t("mobile.vault.loadError")); haptic("error"); } }
    finally { if (version === requestVersion.current) setLoading(false); }
  }, []);
  useEffect(() => { if (open) { setSelected(null); setConfirming(false); void load(); } return () => { requestVersion.current++; }; }, [open, load]);
  useEffect(() => { if (!confirming) return; const timer = window.setTimeout(() => setConfirming(false), 3000); return () => window.clearTimeout(timer); }, [confirming]);
  const who = (bots: LoginBots) => {
    if (bots === "all") return t("mobile.vault.allBots");
    if (!bots.length) return t("mobile.vault.noBots");
    return t("mobile.vault.botAccess", { names: bots.map((id) => state.bots.find((bot) => bot.id === id)?.name ?? t("mobile.vault.unknownBot")).join(", ") });
  };
  const title = (entry: VaultEntry) => entry.kind === "login" ? entry.value.site : entry.value.label;
  const account = (entry: VaultEntry) => entry.kind === "login" ? entry.value.username || t("mobile.vault.noAccount") : t("mobile.vault.secret");
  const addLogin = () => { dispatch({ type: "toggleAppSettings", open: true, section: "logins" }); onClose(); };
  const view = vaultView({ loaded, loading, error: Boolean(error), count: entries.length });
  const back = () => { setSelected(null); setConfirming(false); setError(null); };
  const remove = async () => {
    if (!selected || deleting.current || selected.kind === "login" && selected.value.source === "1password") return;
    const dialogs = systemDialogs();
    if (dialogs) {
      const outcome = await dialogs.alert({
        title: t("mobile.vault.delete"),
        message: title(selected),
        confirmLabel: t("mobile.vault.delete"),
        cancelLabel: t("common.cancel"),
        tone: "danger",
      });
      if (outcome !== "confirm") return;
    } else if (!confirming) {
      setConfirming(true);
      return;
    }
    deleting.current = true;
    setBusy(true);
    setError(null);
    try {
      if (selected.kind === "login") await deleteLogin(selected.value.id);
      else await api(`/api/saved-secrets/${encodeURIComponent(selected.value.id)}`, { method: "DELETE" });
      setEntries((current) => current.filter((entry) => !(entry.kind === selected.kind && entry.value.id === selected.value.id)));
      back();
    } catch { setError(t("mobile.vault.deleteError")); haptic("error"); }
    finally { deleting.current = false; setBusy(false); setConfirming(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} full title={t("mobile.vault.title")}>
      <div className="px-3 pt-2">
        {view === "skeleton" ? <div role="status" aria-label={t("mobile.vault.loading")}>{[0, 1, 2].map((key) => <div key={key} aria-hidden className="flex min-h-[84px] items-center gap-3 px-3 py-3"><span className="size-10 shrink-0 rounded-full bg-ink/[0.06]" /><span className="flex-1 space-y-2"><span className="block h-4 w-2/5 rounded-full bg-ink/[0.06]" /><span className="block h-3 w-3/5 rounded-full bg-ink/[0.05]" /></span></div>)}</div>
          : view === "list" ? <>
            <ul data-settings-card="" className="flex flex-col gap-[2px] overflow-hidden rounded-[16px] [&>*]:bg-menu [&_.mobile-row]:rounded-none">{entries.map((entry) => <li key={`${entry.kind}:${entry.value.id}`}><button type="button" onClick={() => { setSelected(entry); setConfirming(false); setError(null); }} className="mobile-row flex min-h-[84px] w-full items-center gap-3 rounded-2xl px-3 py-3 text-left"><VaultTile /><span className="min-w-0 flex-1"><span dir="auto" className="block truncate text-[16px] font-semibold text-ink">{title(entry)}</span><span dir="auto" className="mt-0.5 block truncate text-[14px] font-medium text-ink-secondary">{account(entry)}</span><span className="block truncate text-[14px] text-ink-secondary">{who(entry.value.bots)}</span></span><ChevronRight aria-hidden size={18} className="shrink-0 text-ink-tertiary" /></button></li>)}</ul>
            <button type="button" onClick={addLogin} className="mobile-row mt-1 flex min-h-14 w-full items-center gap-3 rounded-2xl px-3 text-left text-[16px] font-semibold text-ink"><span aria-hidden className="flex size-10 items-center justify-center rounded-full bg-ink/[0.06]"><Plus size={20} /></span>{t("mobile.vault.addLogin")}</button>
          </>
          : view === "empty" ? <EmptyState art="key" title={t("mobile.vault.empty")} body={t("mobile.vault.emptyHint")} action={{ label: t("mobile.vault.addLogin"), onClick: addLogin, icon: <Plus aria-hidden size={18} /> }} className="pt-16" />
          : <EmptyState tone="error" art="key" title={t("mobile.vault.loadErrorTitle")} body={t("mobile.vault.loadErrorBody")} action={{ label: t("mobile.vault.retry"), onClick: () => void load() }} className="pt-16" />}
        {error && !selected && view === "list" && <p role="alert" className="px-3 py-4 text-[15px] text-danger">{error}</p>}
      </div>
      <SheetPush open={Boolean(selected)} onClose={back} title={shown ? title(shown) : undefined}>
        {shown && (
          <div className="px-3 pt-2">
            <div className="flex flex-col gap-5 px-3 pt-3">
              <VaultTile />
              <div><h2 className="text-[14px] font-medium text-ink-secondary">{t("mobile.vault.account")}</h2><p dir="auto" className="mt-1 break-words text-[16px] text-ink">{account(shown)}</p></div>
              <div><h2 className="text-[14px] font-medium text-ink-secondary">{t("mobile.vault.access")}</h2><p className="mt-1 text-[16px] text-ink">{who(shown.value.bots)}</p></div>
              {shown.kind === "login" && shown.value.source === "1password" ? <p className="text-[14px] text-ink-secondary">{t("mobile.vault.readOnly")}</p> : <button type="button" disabled={busy} onClick={() => void remove()} className="mobile-press min-h-12 rounded-full bg-danger/10 px-5 text-[16px] font-semibold text-danger disabled:opacity-40">{confirming ? t("mobile.vault.confirmDelete") : t("mobile.vault.delete")}</button>}
            </div>
            {error && <p role="alert" className="px-3 py-4 text-[15px] text-danger">{error}</p>}
          </div>
        )}
      </SheetPush>
    </Sheet>
  );
}
