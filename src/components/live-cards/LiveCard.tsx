import { useEffect, useId, useState, type ReactNode } from "react";

import { Check, ChevronRight, Circle, X } from "../../icons";
import { cn } from "@/lib/cn";
import { BotAvatar } from "../Avatar";
import { WorkingMascot } from "../WorkingMascot";
import { WorkingDots } from "../WorkingIndicator";

export type LiveCardState = "running" | "done" | "failed" | "ended";
export type LiveCardBot = Parameters<typeof BotAvatar>[0]["bot"] & Parameters<typeof WorkingMascot>[0]["bot"];

const FOLD_MS = 300;

function useMountedThroughFold(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open || !mounted) return;
    const timer = setTimeout(() => setMounted(false), FOLD_MS);
    return () => clearTimeout(timer);
  }, [open, mounted]);
  return open || mounted;
}

export function LiveCard({ bot, state, title, meta, label, kind, children, onOpenChange }: {
  bot: LiveCardBot;
  state: LiveCardState;
  title: ReactNode;
  meta?: string;
  label: string;
  kind: string;
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const [opened, setOpened] = useState(false);
  const bodyId = useId();
  const running = state === "running";
  const open = running || opened;
  const bodyMounted = useMountedThroughFold(open);
  const peekMounted = useMountedThroughFold(running);
  const toggle = () => {
    if (running) return;
    setOpened(!opened);
    onOpenChange?.(!opened);
  };
  return (
    <div
      data-live-card={kind}
      data-live-card-state={state}
      data-live-card-open={open ? "" : undefined}
      className={cn("live-card relative max-w-full", open ? "w-[min(34rem,100%)]" : "w-fit", running && "dusk-card-in")}
      data-peeking={running ? "" : undefined}
    >
      {peekMounted && (
        <span className="live-card-peek pointer-events-none absolute left-3.5 top-0" data-ducked={running ? undefined : ""} aria-hidden="true">
          <WorkingMascot bot={bot} size={28} seed={kind} />
        </span>
      )}
      <div className={cn("relative overflow-hidden border border-edge bg-card text-[13px]", open ? "rounded-2xl" : "rounded-full")}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={label}
          aria-disabled={running || undefined}
          onClick={toggle}
          className={cn(
            "flex min-h-8 w-full min-w-0 items-center gap-2 px-3 py-1.5 text-start text-ink-secondary focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
            running ? "cursor-default" : "cursor-pointer hover:bg-raised hover:text-ink",
          )}
        >
          {!running && <span className="flex shrink-0" aria-hidden="true"><BotAvatar bot={bot} size={16} animated={false} /></span>}
          <span className={cn("min-w-0 truncate", open && "flex-1")}>{title}</span>
          {meta && <span className="shrink-0 text-[12px] tabular-nums text-ink-tertiary" data-live-card-meta="">{meta}</span>}
          <span className="flex shrink-0 items-center" aria-hidden="true">
            {running ? <WorkingDots size={3.5} className="text-accent-text" />
              : state === "done" ? <Check size={13} className="text-success" />
              : state === "failed" ? <X size={13} className="text-danger" />
              : <Circle size={11} className="text-ink-tertiary" />}
          </span>
          {!running && <ChevronRight size={13} className={cn("shrink-0 text-ink-tertiary transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} aria-hidden="true" />}
        </button>
        <div id={bodyId} className="live-card-fold" data-folded={open ? undefined : ""} inert={!open}>
          <div>
            {bodyMounted && <div className="border-t border-edge p-2">{children}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
