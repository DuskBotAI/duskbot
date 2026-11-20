import { t } from "@/lib/i18n";

/** The run's one quiet line at the foot of every step after the bring step: bringing in, then what came in, and notes
 * from another AI pasted on a step. */
export function BringStatus({ line, working = false }: { line: string | null; working?: boolean }) {
  if (!line && !working) return null;
  return (
    <p role="status" aria-live="polite" data-bring-status={working ? "working" : "done"}
      className="pointer-events-none fixed right-0 bottom-4 left-[var(--rail-beside,0px)] z-10 mx-auto flex w-fit max-w-[min(520px,calc(100%-32px))] items-center gap-2 rounded-[14px] bg-ink/[0.05] px-3 py-1.5 text-[12px] leading-4 text-ink-secondary">
      {working && <span aria-hidden="true" className="funnel-wait inline-block size-1.5 shrink-0 rounded-full bg-ink/60" />}
      <span className="text-pretty">{working ? t("bring.working") : line}</span>
    </p>
  );
}
