import { cn } from "@/lib/cn";
import { openGrokMove, useGrokMoveSummary, type GrokMoveClient } from "@/lib/grok-bot-move";
import { t } from "@/lib/i18n";
import { GrokBotMark } from "../GrokBotMark";

type Summary = NonNullable<ReturnType<typeof useGrokMoveSummary>>;

/** What the entry points say of Grok Bot here, and what their button opens. */
export function grokEntry(summary: Summary): { line: string; action: string; result: boolean } | null {
  const { detection, last, waiting } = summary;
  if (!detection.available || !detection.found) return null;
  const live = detection.bots.filter((bot) => !bot.removed);
  if (!live.length) return null;
  const here = live.filter((bot) => bot.here).length;
  const left = live.length - here;
  const moved = last && last.state !== "undone";
  if (detection.running) return { line: t("grokBotMove.entry.running"), action: t("grokBotMove.entry.open"), result: false };
  if (waiting.waiting) {
    return { line: waiting.waiting === 1 ? t("grokBotMove.entry.waitingOne") : t("grokBotMove.entry.waiting", { count: waiting.waiting }), action: t("grokBotMove.entry.open"), result: true };
  }
  if (!left) return { line: here === 1 ? t("grokBotMove.entry.hereOne") : t("grokBotMove.entry.here", { count: here }), action: t("grokBotMove.entry.open"), result: Boolean(moved) };
  const line = live.length === 1 ? t("grokBotMove.entry.foundOne") : t("grokBotMove.entry.found", { count: live.length });
  return { line: here ? t("grokBotMove.entry.someHere", { line, count: here }) : line, action: t("grokBotMove.entry.move"), result: false };
}

const BUTTON = "ui-button ui-button-pill min-h-9 shrink-0 gap-1.5 px-3.5 text-[13px] transition-[background-color,transform] duration-150 ease-[ease] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none motion-reduce:active:scale-100";

/** Settings → General → Bring in from other apps: Grok Bot's row. Away from the desktop app, one line says why. */
export function GrokMoveRow({ local, client }: { local: boolean; client?: GrokMoveClient }) {
  const summary = useGrokMoveSummary(local, client);
  if (!local) {
    return <p data-grok-entry="notDesktop" className="m-0 px-1 text-pretty text-[12px] leading-4 text-ink-tertiary">{t("grokBotMove.notDesktop")}</p>;
  }
  const entry = summary && grokEntry(summary);
  if (!entry) return null;
  return (
    <div data-grok-entry="settings" className="flex min-w-0 items-center gap-3 rounded-[14px] bg-ink/[0.035] px-3 py-2.5 text-start">
      <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-app"><GrokBotMark size={16} /></span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14px] font-medium leading-5 text-ink">{t("grokBotMove.app")}</span>
        <span data-grok-entry-line="" className="text-pretty text-[12px] leading-4 text-ink-secondary">{entry.line}</span>
      </span>
      <button type="button" data-grok-entry-open="" onClick={() => openGrokMove(entry.result ? { at: "result" } : {})} className={BUTTON}>{entry.action}</button>
    </div>
  );
}

/** The welcome's bring step, when Grok Bot is on this Mac: its bots, one button away. */
export function GrokMoveCard({ local, client, className }: { local: boolean; client?: GrokMoveClient; className?: string }) {
  const summary = useGrokMoveSummary(local, client);
  const entry = summary && grokEntry(summary);
  if (!entry) return null;
  return (
    <div data-grok-entry="welcome" className={cn("flex flex-col gap-4 rounded-[20px] bg-ink/[0.035] p-5 text-start", className)}>
      <div className="flex min-w-0 items-start gap-3.5">
        <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-[13px] bg-app"><GrokBotMark size={22} /></span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[16px] font-medium leading-[22px] text-ink">{t("grokBotMove.entry.onThisMac")}</span>
          <span data-grok-entry-line="" className="text-pretty text-[14px] leading-5 text-ink-secondary">{entry.line}</span>
        </span>
      </div>
      <button type="button" data-grok-entry-open="" onClick={() => openGrokMove(entry.result ? { at: "result" } : {})}
        className="ui-button ui-button-pill ui-button-primary h-8 min-h-8 w-full gap-1.5 px-3.5 py-0 text-[13px] transition-[background-color,transform] duration-150 ease-[ease] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none motion-reduce:active:scale-100 sm:w-auto sm:self-start">
        {entry.action}
      </button>
    </div>
  );
}
