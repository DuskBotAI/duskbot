import { useState } from "react";

import { Globe, Maximize } from "../../icons";
import { AttachmentPreviewDialog } from "@/components/AttachmentPreview";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useBrowserSnapshot } from "@/state/browser-snapshots";
import { browserDid, browserDoing, stretchSite, stretchState, type BrowserStep } from "./browser-step";
import { LiveCard, type LiveCardBot } from "./LiveCard";

const RECENT_STEPS = 3;

export function BrowserCard({ steps, bot, threadId, running, pictures = true }: {
  steps: readonly BrowserStep[];
  bot: LiveCardBot;
  threadId?: string;
  running: boolean;
  pictures?: boolean;
}) {
  const [large, setLarge] = useState(false);
  const [opened, setOpened] = useState(false);
  const stretchId = steps[0]!.id;
  const snapshot = useBrowserSnapshot({ botId: bot.id, threadId, stretchId }, pictures && (running || large));
  const state = stretchState(steps, running);
  const site = stretchSite(steps) ?? t("liveCard.browser.title");
  const newest = steps.at(-1)!;
  const earlier = running ? steps.slice(0, -1).slice(-RECENT_STEPS) : steps;
  const status = t(running ? "liveCard.running" : state === "done" ? "liveCard.done" : state === "failed" ? "liveCard.failed" : "liveCard.ended");
  const canExpand = snapshot !== null;
  const alt = t("liveCard.browser.snapshotAlt", { name: bot.name ?? "", site });
  return (
    <>
      <LiveCard
        bot={bot}
        kind="browser"
        state={state}
        meta={steps.length === 1 ? t("liveCard.browser.oneStep") : t("liveCard.browser.steps", { count: steps.length })}
        label={t("liveCard.browser.label", { site, status })}
        onOpenChange={setOpened}
        title={
          <span className="flex min-w-0 items-center gap-2 text-ink">
            {!running && !opened && snapshot && <img src={snapshot.src} alt="" data-live-card-thumb="" className="h-4 w-6 shrink-0 rounded-[3px] border border-edge object-cover object-left-top" />}
            {(running || opened || !snapshot) && <Globe size={13} className="shrink-0 text-ink-tertiary" aria-hidden="true" />}
            <span className="min-w-0 truncate">{site}</span>
          </span>
        }
      >
        <div className="flex flex-wrap items-start gap-2.5" data-live-card-browser={running ? "live" : "final"}>
          {pictures && (running || snapshot) && (
            <button
              type="button"
              disabled={!canExpand}
              onClick={() => setLarge(true)}
              aria-label={t("liveCard.browser.openLarge", { name: bot.name ?? "" })}
              className={cn(
                "relative w-[15rem] max-w-full shrink-0 overflow-hidden rounded-xl border border-edge bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                canExpand ? "cursor-pointer" : "cursor-default",
              )}
            >
              {snapshot
                ? <img src={snapshot.src} alt={alt} data-live-card-snapshot="" className="block max-h-48 w-full object-cover object-left-top" />
                : (
                  <span className="flex aspect-video w-full flex-col items-center justify-center gap-1.5 px-3 text-center text-[12px] leading-[16px] text-ink-tertiary" data-live-card-snapshot="waiting">
                    <Globe size={18} aria-hidden="true" />
                    {t("liveCard.browser.waiting")}
                  </span>
                )}
              {canExpand && (
                <span className="absolute end-1.5 top-1.5 flex size-6 items-center justify-center rounded-full border border-edge bg-card text-ink-secondary" aria-hidden="true">
                  <Maximize size={12} />
                </span>
              )}
            </button>
          )}
          <div className="min-w-[9rem] flex-1 space-y-1 py-0.5 text-[12px] leading-[18px]">
            {running && <p className="text-ink" role="status" data-live-card-now="">{browserDoing(newest)}</p>}
            {earlier.length > 0 && (
              <ol className={cn("space-y-0.5 text-ink-tertiary", !running && "max-h-40 overflow-auto text-ink-secondary")} aria-label={t("liveCard.browser.history")} tabIndex={running ? undefined : 0}>
                {earlier.map((step) => (
                  <li key={step.id} data-mid={step.id} className={cn("truncate", step.tool.ok === false && "text-danger")}>{browserDid(step)}</li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </LiveCard>
      {large && snapshot && <AttachmentPreviewDialog image={{ src: snapshot.src, name: site }} onClose={() => setLarge(false)} />}
    </>
  );
}
