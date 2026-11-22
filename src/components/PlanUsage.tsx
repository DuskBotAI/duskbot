import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "../icons";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { SIMPLE_CARD } from "./SettingsPrimitives";
import { Card as RowsCard, ItemRow, NoteRow, rowCls } from "./ListRows";
import { UsageSummaryCard } from "./CloudUsageMeter";
import { formatPlanSpend, type PlanSpend } from "@/lib/plan-spend";
import { friendlyError } from "@/lib/plain-error";
import { ArtState } from "./ui/Art";
import { shownShare, useUsageDisplay, type UsageDisplay } from "@/lib/usage-display";

interface PlanWindow {
  available: boolean;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

interface PlanExtra {
  label: string;
  remainingPercent: number;
  usedPercent: number;
  resetsAt: string | null;
  spend?: PlanSpend;
}

interface PlanModelUsage {
  name: string;
  windows: PlanExtra[];
}

interface PlanProvider {
  id: string;
  name: string;
  driver: string;
  plan: string | null;
  ok: boolean;
  error: string | null;
  fiveHour: PlanWindow;
  weekly: PlanWindow;
  extra: PlanExtra[];
  models?: PlanModelUsage[];
}

interface PlanUsageReport {
  fetchedAt: string;
  providers: PlanProvider[];
}

function formatResetDistance(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at) || at <= now) return null;
  const minutes = Math.floor((at - now) / 60_000);
  if (minutes < 1) return "less than a minute";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

function dueResetDeadlines(report: PlanUsageReport, now: number, seen: Set<string>): string[] {
  const due: string[] = [];
  for (const provider of report.providers) {
    if (!provider.ok) continue;
    const stamps = [
      provider.fiveHour.available ? provider.fiveHour.resetsAt : null,
      provider.weekly.available ? provider.weekly.resetsAt : null,
      ...provider.extra.map((extra) => extra.resetsAt),
      ...(provider.models ?? []).flatMap((model) => model.windows.map((entry) => entry.resetsAt)),
    ];
    for (const resetsAt of stamps) {
      if (!resetsAt || seen.has(resetsAt) || due.includes(resetsAt)) continue;
      const at = Date.parse(resetsAt);
      if (Number.isFinite(at) && at <= now) due.push(resetsAt);
    }
  }
  return due;
}

function usageTone(used: number): string {
  if (used >= 90) return "bg-danger";
  if (used >= 70) return "bg-warning";
  return "bg-success";
}

function windowLabel(label: string): string {
  if (label === "5-hour") return t("planUsage.fiveHour");
  if (label === "Weekly") return t("planUsage.weekly");
  if (label === "Monthly") return t("planUsage.monthly");
  if (label === "Monthly spend") return t("planUsage.monthlySpend");
  return label;
}

function providerLabel(provider: Pick<PlanProvider, "name">): string {
  const normalized = provider.name.trim().toLowerCase();
  if (normalized === "chatgpt plan") return t("planUsage.provider.chatgptPlan");
  if (normalized === "claude (api key)") return t("planUsage.provider.claudeApiKey");
  return provider.name;
}

function providerError(provider: Pick<PlanProvider, "error">): string | null {
  const message = provider.error?.trim();
  if (!message) return null;
  const signIn = /^Sign in again in (.+)$/i.exec(message);
  return signIn ? t("planUsage.signInAgain", { provider: providerLabel({ name: signIn[1]! }) }) : message;
}

/** "32% used", or "68% left" for someone who reads their usage as what remains. */
function shareLine(usedPercent: number, display: UsageDisplay): string {
  const percent = shownShare(usedPercent, display);
  return display === "left" ? t("planUsage.left", { remaining: percent }) : t("planUsage.used", { used: percent });
}

function WindowRow({
  label,
  window,
  now,
  display,
  detail,
}: {
  label: string;
  window: PlanWindow;
  now: number;
  display: UsageDisplay;
  detail?: string;
}) {
  const when = window.available ? formatResetDistance(window.resetsAt, now) : null;
  const used = window.usedPercent ?? 0;
  const headline = window.usedPercent == null ? null : shareLine(window.usedPercent, display);
  const share = shownShare(used, display);
  return (
    <div className={cn(rowCls, "items-start")}>
      <div data-row-title="" className="w-20 shrink-0 text-[13px] leading-[18px] text-ink">{label}</div>
      {window.available && headline ? (
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-end gap-x-2 text-[13px] leading-[18px] text-ink-secondary">
            <span className="tabular-nums text-ink">{headline}</span>
            {detail && <span data-plan-spend className="text-[12px] tabular-nums">{detail}</span>}
            {when && <span className="text-[12px]">{t("planUsage.resetsIn", { when })}</span>}
          </div>
          <div
            className="mt-1 h-1 overflow-hidden rounded-full bg-ink/[0.06]"
            role="meter"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={share}
          >
            <div className={cn("h-full rounded-full", usageTone(used))} style={{ width: `${share}%` }} />
          </div>
        </div>
      ) : (
        <div className="min-w-0 flex-1 text-end text-[13px] leading-[18px] text-ink-secondary">{t("planUsage.notReported")}</div>
      )}
    </div>
  );
}

function usePlanUsage() {
  const [report, setReport] = useState<PlanUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const refreshedDeadlines = useRef(new Set<string>());

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError("");
    try {
      const data = await api<PlanUsageReport>(refresh ? "/api/plan-usage?refresh=1" : "/api/plan-usage");
      setReport(data);
      setNow(Date.now());
    } catch (cause) {
      setError(friendlyError(cause, t("planUsage.fetchError")));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!report) return;
    const due = dueResetDeadlines(report, now, refreshedDeadlines.current);
    if (due.length === 0) return;
    for (const deadline of due) refreshedDeadlines.current.add(deadline);
    void load(true);
  }, [report, now, load]);

  return { report, loading, error, now, load };
}

/** The budget of a plan with no weekly window, to stand in for the weekly figure. */
export function monthlySpend(report: Pick<PlanUsageReport, "providers"> | null): { provider: PlanProvider; budget: PlanExtra } | null {
  for (const provider of report?.providers ?? []) {
    const budget = provider.ok && !provider.weekly.available ? provider.extra.find((extra) => extra.label === "Monthly spend") : undefined;
    if (budget) return { provider, budget };
  }
  return null;
}

export function busiestWeekly(report: Pick<PlanUsageReport, "providers"> | null): { provider: PlanProvider; used: number } | null {
  let busiest: { provider: PlanProvider; used: number } | null = null;
  for (const provider of report?.providers ?? []) {
    const used = provider.ok && provider.weekly.available ? provider.weekly.usedPercent : null;
    if (used !== null && (!busiest || used > busiest.used)) busiest = { provider, used };
  }
  return busiest;
}

export function PlanUsageSummary() {
  const { report, now } = usePlanUsage();
  const display = useUsageDisplay();
  if (!report) return null;
  const busiest = busiestWeekly(report);
  const spending = busiest ? null : monthlySpend(report);
  if (spending) {
    const name = providerLabel(spending.provider);
    const used = Math.round(Math.min(100, Math.max(0, spending.budget.usedPercent)));
    return <UsageSummaryCard kind="plan" title={t("settings.simple.billing.monthlySpend", { provider: name })} usedPercent={used} label={`${name}: ${shareLine(used, display)}`}
      note={spending.budget.spend ? formatPlanSpend(spending.budget.spend) : null} />;
  }
  if (!busiest) {
    return <section data-usage-summary="own-ai" className={cn(SIMPLE_CARD, "px-3 py-2 text-[13px] leading-[18px] text-ink-secondary")}>{t("settings.simple.billing.ownAi")}</section>;
  }
  const percent = Math.round(Math.min(100, Math.max(0, busiest.used)));
  const when = formatResetDistance(busiest.provider.weekly.resetsAt, now);
  const name = providerLabel(busiest.provider);
  return (
    <UsageSummaryCard kind="plan" title={t("settings.simple.billing.weekly", { provider: name })} usedPercent={percent} label={`${name}: ${shareLine(percent, display)}`}
      note={when ? t("planUsage.resetsIn", { when }) : null} />
  );
}

export function PlanUsage() {
  const { report, loading, error, now, load } = usePlanUsage();
  const display = useUsageDisplay();
  const refresh = (
    <button type="button" onClick={() => void load(true)} disabled={loading} aria-label={t("planUsage.refresh")} title={t("planUsage.refresh")}
      className="-my-1 flex size-6 cursor-pointer items-center justify-center rounded-md text-ink-secondary hover:bg-ink/[0.035] hover:text-ink focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50">
      {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
    </button>
  );

  return (
    <div data-plan-usage="" className="flex flex-col gap-5">
      <RowsCard label={t("planUsage.title")} action={refresh}>
        {loading && !report && <NoteRow>{t("planUsage.loading")}</NoteRow>}
        {error && <NoteRow tone="danger">{error}</NoteRow>}
        {report && report.providers.length === 0 && <ArtState data-art-state="plan-usage" art="coins" title={t("empty.planUsage.title")} className="py-6">{t("empty.planUsage.hint")}</ArtState>}
        {report?.providers.filter((provider) => !provider.ok).map((provider) => (
          <ItemRow key={provider.id} title={providerLabel(provider)} hint={<span className="text-danger">{providerError(provider)}</span>} />
        ))}
      </RowsCard>
      {report?.providers.filter((provider) => provider.ok).map((provider) => (
        <RowsCard key={provider.id} label={provider.plan ? `${providerLabel(provider)} · ${provider.plan}` : providerLabel(provider)}>
          <WindowRow label={t("planUsage.fiveHour")} window={provider.fiveHour} now={now} display={display} />
          <WindowRow label={t("planUsage.weekly")} window={provider.weekly} now={now} display={display} />
          {provider.extra.map((extra, index) => (
            <WindowRow
              key={`${extra.label}-${index}`}
              label={windowLabel(extra.label)}
              now={now}
              display={display}
              detail={extra.spend ? formatPlanSpend(extra.spend) : undefined}
              window={{ available: true, remainingPercent: extra.remainingPercent, usedPercent: extra.usedPercent, resetsAt: extra.resetsAt }}
            />
          ))}
          {(provider.models ?? []).flatMap((model) => model.windows.map((entry, index) => (
            <WindowRow
              key={`${model.name}-${entry.label}-${index}`}
              label={model.name}
              now={now}
              display={display}
              detail={windowLabel(entry.label)}
              window={{ available: true, remainingPercent: entry.remainingPercent, usedPercent: entry.usedPercent, resetsAt: entry.resetsAt }}
            />
          )))}
        </RowsCard>
      ))}
    </div>
  );
}
