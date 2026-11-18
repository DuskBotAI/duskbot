import { useEffect, useState } from "react";

import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { formatElapsed } from "@/lib/working-time";
import { useCommandTail } from "@/state/command-tails";
import { useFullOutput } from "../ToolActivity";
import { commandState, commandText, type CommandStep } from "./command-step";
import { LiveCard, type LiveCardBot } from "./LiveCard";

const TITLE_FITS = 20;

function useElapsed(since: number, ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return Math.max(0, now - since);
}

export function CommandCard({ message, bot, threadId, live }: { message: CommandStep; bot: LiveCardBot; threadId?: string; live: boolean }) {
  const tool = message.tool;
  const state = commandState(tool, live);
  const running = state === "running";
  const [opened, setOpened] = useState(false);
  const tail = useCommandTail(running ? threadId : undefined, tool.itemId);
  const elapsed = useElapsed(message.at, running);
  const full = useFullOutput(opened && tool.clipped && threadId ? { threadId, messageId: message.id } : undefined, tool.output);
  const output = (full.output ?? tool.output)?.replace(/\s+$/, "");
  const command = commandText(tool.step);
  const whole = (command.length > TITLE_FITS || command.includes("\n")) && (
    <pre dir="ltr" tabIndex={0} className="mb-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-words px-1 font-mono text-[12px] leading-[18px] text-ink" data-live-card-command="">{command}</pre>
  );
  const meta = running ? formatElapsed(elapsed) : tool.ms !== undefined && tool.ms >= 1000 ? formatElapsed(tool.ms) : undefined;
  const status = t(running ? "liveCard.running" : state === "done" ? "liveCard.done" : state === "failed" ? "liveCard.failed" : "liveCard.ended");
  return (
    <LiveCard
      bot={bot}
      kind="command"
      state={state}
      meta={meta}
      label={t("liveCard.command.label", { command, status })}
      onOpenChange={setOpened}
      title={<span dir="ltr" className="font-mono text-[12px] text-ink"><span className="select-none text-ink-tertiary" aria-hidden="true">› </span>{command}</span>}
    >
      {whole}
      {running ? (
        <div className="flex max-h-[14.5rem] min-h-9 flex-col justify-end overflow-hidden rounded-xl bg-inset px-2.5 py-2" data-live-card-output="live">
          {tail.length > 0
            ? <pre dir="ltr" className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[18px] text-ink-secondary">{tail.join("\n")}</pre>
            : <p className="text-[12px] leading-[18px] text-ink-tertiary">{t("liveCard.command.quiet")}</p>}
        </div>
      ) : (
        <div className="space-y-1.5" data-live-card-output="final">
          {output
            ? <pre dir="ltr" tabIndex={0} className={cn("max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-inset px-2.5 py-2 font-mono text-[12px] leading-[18px]", state === "failed" ? "text-danger" : "text-ink-secondary")}>{output}</pre>
            : <p className="px-1 text-[12px] leading-[18px] text-ink-tertiary">{t(state === "ended" ? "liveCard.command.noResult" : "liveCard.command.noOutput")}</p>}
          {(full.state === "loading" || full.state === "failed") && <p className="px-1 text-[11px] text-ink-tertiary" role="status">{t(full.state === "loading" ? "toolDetail.loadingFull" : "toolDetail.partial")}</p>}
        </div>
      )}
    </LiveCard>
  );
}
