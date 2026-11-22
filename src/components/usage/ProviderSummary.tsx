import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { rowShare, usageRows, windowLabel, type EngineLimit } from "@/lib/limit-resets";
import { useUsageDisplay, type UsageDisplay } from "@/lib/usage-display";
import { EASE } from "@/lib/motion-presets";
import { Card as RowsCard } from "../ListRows";
import { ProviderMark } from "../ProviderIcons";

const DRIVER_MARK: Record<EngineLimit["driver"], string> = {
  claude: "claudeAgent",
  codex: "codex",
  grok: "grok",
  antigravity: "antigravityAgent",
  cursor: "cursorAgent",
  opencode: "opencodeGo",
};

/** "2d 4h", "3h 10m" or "12m" until a reset; null once it has passed or is unknown. */
export function resetDistance(at: number | null, now: number): string | null {
  if (at === null || at <= now) return null;
  const minutes = Math.max(1, Math.floor((at - now) / 60_000));
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/** A slim meter: neutral ink all the way, red only once the window is at its limit. */
function Meter({ percent, out, label }: { percent: number; out: boolean; label: string }) {
  const reduce = useReducedMotion();
  const share = Math.min(100, Math.max(0, percent)) / 100;
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}
      className="h-1 w-full overflow-hidden rounded-full bg-ink/[0.07]">
      <motion.div className={cn("h-full w-full origin-left rounded-full", out ? "bg-danger" : "bg-ink/70")}
        initial={reduce ? false : { scaleX: 0 }} animate={{ scaleX: Math.max(share, percent > 0 ? 0.015 : 0) }}
        transition={{ duration: 0.3, ease: EASE.out }} />
    </div>
  );
}

function ProviderCell({ limit, now, display }: { limit: EngineLimit; now: number; display: UsageDisplay }) {
  const rows = usageRows(limit);
  const lead = rows.find((row) => row.window === limit.window) ?? rows[0];
  if (!lead) return null;
  const rest = rows.filter((row) => row !== lead);
  const out = lead.tone === "out";
  const share = rowShare(lead, display);
  const when = resetDistance(lead.resetsAt, now);
  return (
    <div data-usage-provider={limit.engine} data-tone={lead.tone} className="flex min-w-0 flex-col gap-2 rounded-[9px] px-2.5 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <ProviderMark driverKind={DRIVER_MARK[limit.driver] ?? limit.driver} size={15} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] text-ink">{limit.name}</span>
        <span className="shrink-0 text-[12px] leading-4 text-ink-tertiary">{windowLabel(lead.window)}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        {out ? (
          <span className="text-[20px] font-medium leading-6 text-danger">{t("usage.summary.atLimit")}</span>
        ) : (
          <>
            <span className="text-[20px] font-medium leading-6 tabular-nums text-ink">{share}%</span>
            <span className="text-[13px] leading-[18px] text-ink-secondary">{t(display === "left" ? "usage.summary.left" : "usage.summary.used")}</span>
          </>
        )}
      </div>
      <Meter percent={share} out={out} label={t("nativeUsage.title", { engine: limit.name })} />
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[12px] leading-4 text-ink-secondary">
        {when && <span className="tabular-nums">{t("planUsage.resetsIn", { when })}</span>}
        {rest.map((row) => (
          <span key={row.window} data-usage-window={row.window} className={cn("tabular-nums", row.tone === "out" ? "text-danger" : "text-ink-tertiary")}>
            {windowLabel(row.window)} {row.tone === "out" ? t("usage.summary.atLimit") : `${rowShare(row, display)}%`}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Each signed-in AI plan at a glance: its mark, the share of its deciding window used or left, when that resets. */
export function ProviderSummary({ limits, now = Date.now() }: { limits: readonly EngineLimit[]; now?: number }) {
  const display = useUsageDisplay();
  if (!limits.length) return null;
  return (
    <RowsCard label={t("usage.summary.title")} footnote={t("settings.usage.footnote")} data-settings-block="usage">
      <div data-usage-cards="" className={cn("grid gap-1", limits.length > 1 && "sm:grid-cols-2")}>
        {limits.map((limit) => <ProviderCell key={limit.engine} limit={limit} now={now} display={display} />)}
      </div>
    </RowsCard>
  );
}
