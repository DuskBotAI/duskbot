import { useState } from "react";

import { cn } from "@/lib/cn";
import { PixelIcon } from "../ui/PixelIcon";
import { t } from "@/lib/i18n";
import { upperFirst } from "@/lib/lower-first";
import { reportsUsage, rowShare, usageRows, useEngineLimits, windowLabel, type EngineLimit } from "@/lib/limit-resets";
import { shownShare, useUsageDisplay } from "@/lib/usage-display";
import { NEAR_LIMIT_PERCENT } from "../../../shared/limit-reset";
import { Icon } from "../Icon";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function relative(at: number, now: number): string {
  const left = Math.max(0, at - now);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const when = left >= DAY ? format.format(Math.round(left / DAY), "day")
    : left >= HOUR ? format.format(Math.round(left / HOUR), "hour")
      : format.format(Math.max(1, Math.round(left / MINUTE)), "minute");
  return when;
}

/** "Resets in 4 days", or with its window "Weekly limit resets in 4 days": Grok's relative reset line. */
export function resetsIn(at: number, now = Date.now(), window?: Parameters<typeof windowLabel>[0]): string {
  const when = relative(at, now);
  return window ? upperFirst(t("nativeUsage.windowResets", { window: windowLabel(window), when })) : t("nativeUsage.resets", { when });
}

/** The window's reset line, or just its name when the reset time is unknown. */
function windowLine(window: Parameters<typeof windowLabel>[0], resetsAt: number | null, now: number): string {
  return resetsAt !== null && resetsAt > now ? resetsIn(resetsAt, now, window) : windowName(window);
}

/** Grok's 4px meter: a 6% ink track and the switch blue fill, red only at the limit. */
export function UsageBar({ share, warn, className }: { share: number; warn?: boolean; className?: string }) {
  return (
    <div aria-hidden="true" data-usage-meter="" className={cn("h-1 overflow-hidden rounded-full bg-ink/[0.06]", className)}>
      <div className={cn("h-full rounded-full", warn ? "bg-danger" : "bg-accent-border")} style={{ width: `${Math.min(100, Math.max(0, share))}%` }} />
    </div>
  );
}

function windowName(window: Parameters<typeof windowLabel>[0]) {
  return upperFirst(t("nativeUsage.windowLimit", { window: windowLabel(window) }));
}

/** One engine as Grok's weekly usage card: the deciding window large, any other window as a compact meter under it. On a
 * phone it is Grok's phone anatomy instead: the name over a stack of segments, the share used or left beside its reset
 * on a thick bar, then one segment per other window. */
export function UsageMeterCard({ limit, now = Date.now() }: { limit: EngineLimit; now?: number }) {
  const display = useUsageDisplay();
  const rows = usageRows(limit);
  const lead = rows.find((row) => row.window === limit.window) ?? rows[0];
  if (!lead) return null;
  const rest = rows.filter((row) => row !== lead);
  const title = t("nativeUsage.title", { engine: limit.name });
  const segment = "max-sm:rounded-[4px] max-sm:bg-menu max-sm:px-4 max-sm:first:rounded-t-[16px] max-sm:last:rounded-b-[16px]";
  return (
    <div data-usage-card={limit.engine} role="group" aria-label={title} className="flex flex-col max-sm:gap-2">
      <div aria-hidden="true" className="px-4 text-[14px] font-[600] leading-5 text-ink/60 sm:hidden">{title}</div>
      <div className="flex flex-col rounded-[12px] bg-menu px-3 pb-2.5 pt-2.5 outline-[0.5px] outline-offset-[-0.5px] outline-transparent [outline-style:solid] max-sm:gap-0.5 max-sm:rounded-none max-sm:bg-transparent max-sm:p-0 max-sm:outline-0">
        <div data-usage-segment="" className={cn("flex flex-col", segment, "max-sm:pb-4 max-sm:pt-3.5")}>
          <div className="text-[13px] leading-[18px] tracking-[-0.08px] text-ink max-sm:hidden">{title}</div>
          <div className="mt-1 flex items-baseline gap-1 max-sm:mt-0 max-sm:flex-wrap">
            {lead.tone === "out" ? (
              <span className="text-[17px] leading-6 tracking-normal text-ink max-sm:text-[26px] max-sm:font-medium max-sm:leading-8">{t("nativeUsage.atLimit")}</span>
            ) : (
              <>
                <span className="text-[17px] leading-6 tracking-normal text-ink tabular-nums max-sm:text-[26px] max-sm:font-medium max-sm:leading-8 max-sm:tracking-normal">{rowShare(lead, display)}%</span>
                <span className="text-[13px] leading-[18px] text-ink/[0.56] max-sm:text-[16px] max-sm:leading-[22px]">{t(display === "left" ? "nativeUsage.left" : "nativeUsage.used")}</span>
              </>
            )}
            <span className="ms-auto shrink-0 text-[14px] leading-5 text-ink-secondary sm:hidden">{windowLine(lead.window, lead.resetsAt, now)}</span>
          </div>
          <UsageBar share={rowShare(lead, display)} warn={lead.tone !== "fine"} className="mt-2 max-sm:mt-3 max-sm:h-[18px] max-sm:rounded-[5px] max-sm:bg-ink/[0.05] max-sm:[&>div]:rounded-[5px]" />
          <div className="mt-1.5 text-[11px] leading-[14px] tracking-[0.07px] text-ink-secondary max-sm:hidden">
            {windowLine(lead.window, lead.resetsAt, now)}
          </div>
        </div>
        {rest.map((row) => (
          <div key={row.window} data-usage-window={row.window} data-usage-segment="" className={cn("mt-3 flex flex-col max-sm:mt-0 max-sm:min-h-[52px] max-sm:justify-center max-sm:gap-2 max-sm:py-3", segment)}>
            <UsageBar share={rowShare(row, display)} warn={row.tone !== "fine"} className="max-sm:order-1 max-sm:h-1.5" />
            <div className="mt-1.5 flex items-baseline justify-between gap-3 text-[11px] leading-[14px] tracking-[0.07px] text-ink-secondary max-sm:mt-0 max-sm:text-[15px] max-sm:leading-5 max-sm:tracking-normal">
              <span className="min-w-0 truncate max-sm:text-ink">{windowLine(row.window, row.resetsAt, now)}</span>
              <span className="shrink-0 tabular-nums">{row.tone === "out" ? t("nativeUsage.atLimit") : t(display === "left" ? "nativeUsage.percentLeft" : "nativeUsage.percentUsed", { percent: rowShare(row, display) })}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The panel row under the model: "Usage", its window and reset, the share used or left on the right, then the meter. */
export function UsageMeterRow({ engine }: { engine: string | undefined }) {
  const limit = useEngineLimits().find((candidate) => candidate.engine === engine);
  const display = useUsageDisplay();
  if (!reportsUsage(limit)) return null;
  const rows = usageRows(limit);
  const lead = rows.find((row) => row.window === limit.window) ?? rows[0];
  if (!lead) return null;
  const hint = windowLine(lead.window, lead.resetsAt, Date.now());
  return (
    <div data-panel-row="usage" className="flex flex-col gap-1.5 rounded-lg px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <div data-usage-title="" className="text-[13px] leading-[18px] tracking-[0.015em] text-ink">{t("nativeUsage.rowTitle")}</div>
          <div className="truncate text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary">{hint}</div>
        </div>
        <span className={cn("shrink-0 text-[13px] leading-[18px] tabular-nums", lead.tone === "out" ? "text-danger" : "text-ink-secondary")}>
          {lead.tone === "out" ? t("nativeUsage.atLimit") : t(display === "left" ? "nativeUsage.percentLeft" : "nativeUsage.percentUsed", { percent: rowShare(lead, display) })}
        </span>
      </div>
      <UsageBar share={rowShare(lead, display)} warn={lead.tone === "out"} />
    </div>
  );
}

const dismissed = new Set<string>();
const dismissKey = (limit: EngineLimit) => `${limit.engine}:${limit.resetsAt ?? ""}`;

/** Grok's composer-dock usage warning, shown near or at the engine's limit until dismissed for that reset. */
export function UsageBanner({ engine, onSeeUsage }: { engine: string | undefined; onSeeUsage: () => void }) {
  const limit = useEngineLimits().find((candidate) => candidate.engine === engine);
  const display = useUsageDisplay();
  const [, setHidden] = useState(0);
  if (!reportsUsage(limit) || dismissed.has(dismissKey(limit))) return null;
  const used = Math.round(limit.usedPercent ?? 0);
  if (!limit.blocked && used < NEAR_LIMIT_PERCENT) return null;
  const now = Date.now();
  const out = limit.blocked || used >= 100;
  const reset = limit.resetsAt !== null && limit.resetsAt > now ? resetsIn(limit.resetsAt, now) : null;
  return (
    <div role="status" data-usage-banner={out ? "danger" : "warning"}
      className={cn("flex items-center gap-2.5 rounded-[14px] py-2 pe-2 ps-3", out ? "bg-danger/[0.07]" : "bg-ink/[0.04]")}>
      <PixelIcon name={out ? "batteryFull" : "battery"} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-[18px] tracking-[-0.08px] text-ink">
          {out ? t("nativeUsage.banner.out", { engine: limit.name })
            : t(display === "left" ? "nativeUsage.banner.nearLeft" : "nativeUsage.banner.near", { engine: limit.name, percent: shownShare(used, display) })}
        </div>
        {reset && <div className="text-[13px] leading-[18px] tracking-[-0.08px] text-ink-secondary">{reset}</div>}
      </div>
      <button type="button" data-usage-see="" onClick={onSeeUsage}
        className="h-7 shrink-0 cursor-pointer rounded-full bg-ink/[0.07] px-3 text-[12px] font-medium leading-4 text-ink transition-colors duration-[120ms] ease-out hover:bg-ink/[0.11] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus">
        {t("nativeUsage.banner.see")}
      </button>
      <button type="button" aria-label={t("nativeUsage.banner.dismiss")} title={t("nativeUsage.banner.dismiss")}
        onClick={() => { dismissed.add(dismissKey(limit)); setHidden((count) => count + 1); }}
        className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink/[0.56] transition-colors duration-[120ms] ease-out hover:bg-ink/[0.06] hover:text-ink-secondary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus">
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
