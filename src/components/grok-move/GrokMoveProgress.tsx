import { stepText } from "@/lib/grok-bot-move";
import { t } from "@/lib/i18n";
import type { GrokFoundBot, GrokMoveBotProgress, GrokMoveProgress } from "../../../shared/grok-move";
import { Check, CircleAlert } from "../../icons";
import { rowButtonCls } from "../ui/GrokDialog";
import { BotFace, Breath } from "./parts";

const failureText = (bot: GrokMoveBotProgress) => (bot.error ? t(`grokBotMove.failure.${bot.error}`) : bot.message ?? t("grokBotMove.failure.failed"));

function stateLine(bot: GrokMoveBotProgress, stopping: boolean): string {
  switch (bot.state) {
    case "queued": return stopping ? t("grokBotMove.progress.notStarted") : t("grokBotMove.progress.queued");
    case "moving": return stepText(bot.step);
    case "done": return bot.update ? t("grokBotMove.progress.updated") : t("grokBotMove.progress.done");
    case "stopped": return t("grokBotMove.progress.stopped");
    case "failed": return failureText(bot);
  }
}

/** One bot's line on the way: queued, moving with its step named, then done, stopped or failed with why. */
export function ProgressRow({ bot, found, stopping = false, onRetry }: { bot: GrokMoveBotProgress; found?: GrokFoundBot; stopping?: boolean; onRetry?: () => void }) {
  return (
    <li data-grok-row={bot.rosterId} data-grok-state={bot.state} className="flex min-w-0 items-center gap-3 px-2 py-2">
      {found ? <BotFace look={found.look} size={28} /> : <span aria-hidden="true" className="size-7 shrink-0 rounded-full bg-ink/[0.06]" />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium leading-[18px] text-ink">{bot.name}</span>
        <span className={bot.state === "failed" ? "text-pretty text-[12px] leading-4 text-danger" : "truncate text-[12px] leading-4 text-ink-secondary"}>{stateLine(bot, stopping)}</span>
      </span>
      <span className="grid min-w-5 shrink-0 place-items-center">
        {bot.state === "moving" && <Breath />}
        {bot.state === "done" && <Check size={15} aria-hidden="true" className="text-ink" />}
        {bot.state === "failed" && (onRetry
          ? <button type="button" data-grok-retry={bot.rosterId} onClick={onRetry} className={rowButtonCls}>{t("grokBotMove.progress.retry")}</button>
          : <CircleAlert size={15} aria-hidden="true" className="text-danger" />)}
      </span>
    </li>
  );
}

/** Screen 2: each chosen bot on its way, one at a time. Closing it leaves the move running. */
export function GrokMoveProgressView({ progress, found }: { progress: GrokMoveProgress; found: ReadonlyMap<string, GrokFoundBot> }) {
  const stopping = progress.state === "stopping";
  return (
    <div data-grok-screen="progress" className="flex flex-col gap-3">
      <div role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-label={t("grokBotMove.progress.count", { done: progress.done, total: progress.total })}
        className="h-1 overflow-hidden rounded-full bg-ink/[0.07]">
        <div className="h-full rounded-full bg-ink transition-[width] duration-300 ease-[var(--dusk-ease-out)] motion-reduce:transition-none" style={{ width: `${progress.total ? (100 * progress.done) / progress.total : 0}%` }} />
      </div>
      <p role="status" aria-live="polite" data-grok-count="" className="m-0 px-1 text-[12px] leading-4 text-ink-secondary">
        {stopping ? t("grokBotMove.progress.stopping") : t("grokBotMove.progress.count", { done: progress.done, total: progress.total })}
      </p>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {progress.bots.map((bot) => <ProgressRow key={bot.rosterId} bot={bot} found={found.get(bot.rosterId)} stopping={stopping} />)}
      </ul>
    </div>
  );
}
