import { use, useState } from "react";

import { ChevronRight } from "../../icons";
import { LiveToolsContext } from "@/hooks/use-live-tool-ids";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { CommandCard } from "./CommandCard";
import { COMMAND_STACK_MAX, commandState, commandSteps } from "./command-step";
import type { LiveCardBot } from "./LiveCard";

export function CommandRows({ messages, bot, threadId, liveIds }: { messages: readonly Message[]; bot: LiveCardBot; threadId?: string; liveIds?: ReadonlySet<string> }) {
  const fromContext = use(LiveToolsContext);
  const live = liveIds ?? fromContext;
  const steps = commandSteps(messages);
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const card = (step: (typeof steps)[number]) => (
    <div key={step.id} className="contents" data-mid={step.id}>
      <CommandCard message={step} bot={bot} threadId={threadId} live={live.has(step.id)} />
    </div>
  );
  const running = (step: (typeof steps)[number]) => commandState(step.tool, live.has(step.id)) === "running";
  const ended = steps.filter((step) => !running(step));
  const folded = ended.length > COMMAND_STACK_MAX;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5" data-command-rows={steps.length}>
      {folded && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-h-8 max-w-full cursor-pointer items-center gap-2 rounded-full border border-edge bg-card px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <span className="flex shrink-0" aria-hidden="true"><BotAvatar bot={bot} size={16} animated={false} /></span>
          <span className="min-w-0 truncate">{t("liveCard.command.many", { count: ended.length })}</span>
          <ChevronRight size={13} className={cn("shrink-0 text-ink-tertiary transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} aria-hidden="true" />
        </button>
      )}
      {folded ? [open && ended.map(card), steps.filter(running).map(card)] : steps.map(card)}
    </div>
  );
}
