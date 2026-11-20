import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Loader2, Trash2, X } from "../icons";
import type { CommandAllowRule, CommandAllowlistResponse } from "../../shared/command-allowlist";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { phoneApp } from "@/lib/store-app";
import { wakeSystemControls } from "@/lib/system-control";
import { dialogPrimaryCls, fieldLabelCls, footnoteCls, formBodyCls, formCloseCls, formHeaderCls, formSheetCls, formTitleCls, listCardCls, rowHintCls, textAreaCls, textFieldCls } from "./ui/GrokDialog";
import { friendlyError } from "@/lib/plain-error";

// Electron collects -webkit-app-region from layout boxes and ignores z-index, so the chat header's drag strip swallows
// clicks on top of it.
const overlayStyle = { WebkitAppRegion: "no-drag" } as CSSProperties;

/**
 * Mounted for one captured bot and thread, so switching conversations cannot redirect an in-flight save or reuse
 * another bot's folder.
 */
export function CommandAllowlistDialog({ botId, botName, threadId, onClose }: {
  botId: string;
  botName: string;
  threadId?: string;
  onClose: () => void;
}) {
  const { state } = useStore();
  const [data, setData] = useState<CommandAllowlistResponse | null>(null);
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const mounted = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const scopeId = useId();
  const exactId = useId();
  const basePath = `/api/bots/${encodeURIComponent(botId)}/command-allowlist`;
  const query = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
  const providerName = (id: string) => state.instances.find((instance) => instance.instanceId === id)?.displayName ?? id;
  const phone = phoneApp();

  useEffect(() => {
    if (!phone) return;
    wakeSystemControls();
    return () => wakeSystemControls();
  }, [phone]);

  useEffect(() => {
    mounted.current = true;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    // A drag-region click can blur the close button, and Bot settings then leaves Escape alone, so the key is taken
    // here first.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      mounted.current = false;
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api<CommandAllowlistResponse>(basePath + query, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setCwd(result.context.cwd ?? "");
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(friendlyError(cause));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [basePath, query, revision]);

  const save = async (rule?: CommandAllowRule) => {
    if (saving || !data || (!rule && (!command.trim() || !cwd.trim() || !data.supported))) return;
    setSaving(rule?.id ?? "add");
    setError(null);
    dialogRef.current?.focus();
    try {
      const result = await api<CommandAllowlistResponse>(
        basePath + (rule ? `/${encodeURIComponent(rule.id)}` : "") + query,
        rule ? { method: "DELETE" } : {
          method: "POST",
          body: JSON.stringify({ command, cwd: cwd.trim(), providerInstanceId: data.context.providerInstanceId }),
        },
      );
      if (!mounted.current) return;
      setData(result);
      if (!rule) setCommand("");
    } catch (cause) {
      if (mounted.current) setError(friendlyError(cause));
    } finally {
      if (mounted.current) {
        setSaving(null);
        closeRef.current?.focus();
      }
    }
  };

  // Portaled so the overlay comes after every drag region and is not trapped in the composer dock (pointer-events none,
  // z-index 2).
  const overlay = (
    <div
      data-thread-overlay
      data-phone-modal-layer={phone ? "" : undefined}
      style={phone ? { ...overlayStyle, paddingTop: "max(var(--m-safe-top, 0px), 16px)", paddingBottom: "max(calc(var(--m-kb, 0px) + 12px), var(--m-safe-bottom, 0px), 16px)" } : overlayStyle}
      className={cn("ui-dialog-scrim fixed inset-0 flex items-center justify-center p-4", phone ? "z-[80]" : "z-50")}
      onMouseDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}
      onClick={(event) => { if (phone && event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex='0']",
        );
        if (!controls?.length) return;
        const first = controls[0]!;
        const last = controls[controls.length - 1]!;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={scopeId}
        aria-busy={loading || Boolean(saving) || undefined}
        tabIndex={-1}
        className={cn(formSheetCls, phone ? "max-h-full!" : "max-h-[85dvh]", "max-w-[520px]", "focus-visible:outline-none!")}
      >
        <header className={formHeaderCls}>
          <h2 id={titleId} className={formTitleCls}>{t("commandAllowlist.title")}</h2>
          <button ref={closeRef} type="button" onMouseDown={(event) => event.stopPropagation()} onClick={onClose} aria-label={t("commandAllowlist.close")}
            className={formCloseCls}><X size={16} className="pointer-events-none" /></button>
        </header>
        <div className={cn(formBodyCls, "flex flex-col gap-3 pb-4")}>
          <p id={scopeId} className={cn(rowHintCls, "m-0 text-pretty")}>{t("commandAllowlist.forBot", { name: botName })}. {t("commandAllowlist.scope")}</p>
          {loading && <p role="status" className={cn(rowHintCls, "m-0 flex items-center gap-2")}>
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />{t("commandAllowlist.loading")}
          </p>}
          {error && <div role="alert" className="text-[12px] leading-4 text-danger">
            <p className="m-0">{error}</p>
            {!data && !loading && <button type="button" onClick={() => setRevision((value) => value + 1)}
              className="mt-1 cursor-pointer underline underline-offset-2">{t("commandAllowlist.retry")}</button>}
          </div>}
          {data && !loading && <>
            {data.rules.length ? <ul className={cn(listCardCls, "m-0 list-none p-0 py-1")}>
              {data.rules.map((rule) => <li key={rule.id} className="flex items-start gap-3 py-2.5 pl-3.5 pr-2.5">
                <div className="min-w-0 flex-1">
                  <pre tabIndex={0} className="m-0 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-[4px] font-mono text-[12px] leading-[18px] text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus">{rule.command}</pre>
                  <p className="m-0 mt-1 break-words text-[12px] leading-4 text-ink/56">{providerName(rule.providerInstanceId)} · <span className="break-all font-mono">{rule.cwd}</span></p>
                </div>
                <button type="button" disabled={Boolean(saving)} onClick={() => void save(rule)}
                  aria-label={t("commandAllowlist.removeAria", { command: rule.command })}
                  title={t(saving === rule.id ? "commandAllowlist.removing" : "commandAllowlist.remove")}
                  className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-ink/68 transition-[background-color,color] duration-[120ms] ease-[ease] enabled:hover:bg-ink/6 enabled:hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus disabled:cursor-default disabled:opacity-40">
                  {saving === rule.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                </button>
              </li>)}
            </ul> : <p className={cn(rowHintCls, "m-0 py-3 text-center")}>{t("commandAllowlist.empty")}</p>}
            {data.supported ? <form className="mt-2 flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <label className="flex flex-col gap-1"><span className={fieldLabelCls}>{t("commandAllowlist.command")} <span className="text-ink/40">({t("commandAllowlist.provider")}: {providerName(data.context.providerInstanceId)})</span></span>
                <textarea value={command} onChange={(event) => setCommand(event.target.value)} disabled={Boolean(saving)} required rows={2} spellCheck={false}
                  aria-describedby={exactId}
                  className={cn(textAreaCls, "resize-y font-mono text-[12px] tracking-normal")} />
                <span id={exactId} className={cn(fieldLabelCls, "block")}>{t("commandAllowlist.exact")}</span>
              </label>
              <label className="flex flex-col gap-1"><span className={fieldLabelCls}>{t("commandAllowlist.folder")}</span>
                <input value={cwd} onChange={(event) => setCwd(event.target.value)} disabled={Boolean(saving)} required spellCheck={false}
                  className={cn(textFieldCls, "font-mono text-[12px] tracking-normal")} />
              </label>
              <div className="flex justify-end pt-1">
                <button type="submit" disabled={Boolean(saving) || !command.trim() || !cwd.trim()} className={dialogPrimaryCls}>
                  {t(saving === "add" ? "commandAllowlist.adding" : "commandAllowlist.add")}
                </button>
              </div>
            </form> : <p className={cn(footnoteCls, "pl-0")}>{t("commandAllowlist.unsupported")}</p>}
          </>}
        </div>
      </div>
    </div>
  );
  const portalRoot = phone ? (document.querySelector?.(".dusk-mobile") ?? document.body) : document.body;
  return createPortal(overlay, portalRoot);
}
