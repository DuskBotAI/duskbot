import { Check, CircleAlert, ExternalLink, TriangleAlert } from "../../icons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { KeyCheckView } from "./key-check-view";

const ACTION = "inline-flex cursor-pointer items-center gap-1 rounded-sm text-ink-secondary transition-colors hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:opacity-50";

/** What one provider call said about a pasted key, under its field: a title, one sentence and the fix it needs. */
export function KeyCheckNote({ view, keyHref, creditHref, onSaveAnyway, onUseModel, saveAnywayLabel, busy = false }: {
  view: KeyCheckView;
  keyHref?: string;
  creditHref?: string;
  onSaveAnyway?: () => void;
  onUseModel?: (model: string) => void;
  saveAnywayLabel?: string;
  busy?: boolean;
}) {
  const Icon = view.tone === "ok" ? Check : view.tone === "warn" ? TriangleAlert : CircleAlert;
  const link = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className={ACTION}>{label}<ExternalLink size={11} aria-hidden="true" /></a>
  );
  const actions = [
    view.outcome === "wrong_key" && keyHref && link(keyHref, t("keys.check.getKey")),
    view.outcome === "no_credit" && (creditHref ?? keyHref) && link((creditHref ?? keyHref)!, t("keys.check.addCredit")),
    view.outcome === "wrong_model" && view.suggestedModel && onUseModel && (
      <button key="model" type="button" data-key-check-use-model className={ACTION} disabled={busy} onClick={() => onUseModel(view.suggestedModel!)}>
        {t("keys.check.useModel", { model: view.suggestedModel })}
      </button>
    ),
    view.confirm && onSaveAnyway && (
      <button key="anyway" type="button" data-key-check-anyway className={ACTION} disabled={busy} onClick={onSaveAnyway}>
        {saveAnywayLabel ?? t("keys.check.saveAnyway")}
      </button>
    ),
  ].filter(Boolean);
  return (
    <div data-key-check={view.outcome} role={view.tone === "ok" ? "status" : "alert"} className="m-0 flex gap-1.5 text-[12px] leading-4">
      <Icon size={13} aria-hidden="true" className={cn("mt-px shrink-0", view.tone === "ok" ? "text-success" : view.tone === "warn" ? "text-warning" : "text-danger")} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className={cn(view.tone === "ok" ? "text-ink" : view.tone === "warn" ? "text-warning" : "text-danger")}>{view.title}</span>
        <span className="text-pretty text-ink-secondary">{view.line}</span>
        {actions.length > 0 && <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">{actions.map((action, index) => <span key={index}>{action}</span>)}</span>}
      </div>
    </div>
  );
}
