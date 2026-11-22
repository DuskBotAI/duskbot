import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "../icons";
import { cn } from "@/lib/cn";
import { activeLocale, documentLanguage, t } from "@/lib/i18n";
import { listenLiveFrames } from "@/lib/live-events";
import { formatTokens, hasFiniteCost, headlineTokens } from "@/lib/usage";
import { fetchTraces, formatCost, formatDuration, traceRootTitle, USAGE_PERIODS, usageExportHref, usagePeriodRange, type UsagePeriod } from "@/lib/usage-trace";
import { api, useStore } from "@/state/store";
import type { LocaleKey } from "@/locales";
import type { TraceList, TraceRootSummary } from "../../shared/usage-trace";
import { BotAvatar } from "./Avatar";
import { PlanUsage } from "./PlanUsage";
import { SettingsSelect } from "./SettingsSelect";
import { Card as RowsCard, ItemRow, NavRow, NoteRow, RowText, rowCls } from "./ListRows";
import { TraceView } from "./usage/TraceView";
import { LiveBadge, modelName, totalsStats } from "./usage/TraceWaterfall";
import { friendlyError } from "@/lib/plain-error";
import { ArtState } from "./ui/Art";

export type UsageGroupBy = "bot" | "model" | "user" | "day" | "engine" | "routine" | "department";
const OTHER_GROUPINGS: readonly UsageGroupBy[] = ["model", "user", "department", "day", "engine", "routine"];

export interface UsageGroup {
  key: string;
  label: string;
  turns: number;
  input: number;
  output: number;
  cachedInput: number;
  costUsd: number | null;
}

interface UsageSummary {
  groupBy: UsageGroupBy;
  groups: UsageGroup[];
}

const GROUP_LABEL_KEYS: Record<UsageGroupBy, LocaleKey> = {
  bot: "usage.history.byBot",
  model: "usage.history.byModel",
  user: "usage.history.byUser",
  day: "usage.history.byDay",
  engine: "usage.history.byEngine",
  routine: "usage.history.byRoutine",
  department: "usage.history.byDepartment",
};

const PERIOD_LABEL_KEYS: Record<UsagePeriod, LocaleKey> = {
  today: "usage.page.today",
  week: "usage.page.week",
  month: "usage.history.thisMonth",
  lastMonth: "usage.history.lastMonth",
  days30: "usage.history.last30Days",
};

const LIVE_REFRESH_MS = 2_000;

export function usageGroupLabel(groupBy: UsageGroupBy, group: Pick<UsageGroup, "key" | "label">): string {
  if (groupBy === "routine") return group.key === "manual" ? t("usage.history.notRoutine") : group.label;
  if (groupBy === "department") return group.label || t("usage.history.noDepartment");
  if (groupBy !== "user") return group.label;
  if (group.key === "owner") return t("usage.history.owner");
  if (group.key === "bot") return t("usage.history.botToBot");
  if (group.key === "upkeep") return t("usage.history.upkeep");
  if (group.key.startsWith("routine:")) return t("usage.history.routine", { name: group.label.replace(/^Routine: /, "") });
  return group.label;
}

function useUsageGroups(range: { from: string; to: string }, groupBy: UsageGroupBy, version: number): UsageSummary | null {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  useEffect(() => {
    let current = true;
    void api(`/api/usage?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&groupBy=${groupBy}`)
      .then((next: UsageSummary) => { if (current) setSummary(next); })
      .catch(() => { if (current) setSummary(null); });
    return () => { current = false; };
  }, [range.from, range.to, groupBy, version]);
  return summary;
}

export function GroupBars({ groupBy, groups }: { groupBy: UsageGroupBy; groups: readonly UsageGroup[] }) {
  const { state } = useStore();
  const top = [...groups].sort((a, b) => headlineTokens(b) - headlineTokens(a)).slice(0, 6);
  const max = Math.max(...top.map(headlineTokens), 0);
  if (!top.length || max <= 0) return <ArtState data-art-state="where" art="coins" title={t("empty.where.title")} className="py-6">{t("empty.where.hint")}</ArtState>;
  return (
    <ul className="contents">
      {top.map((group) => {
        const bot = groupBy === "bot" ? state.bots.find((item) => `bot:${item.id}` === group.key) : undefined;
        return (
          <li key={group.key} className={cn(rowCls, "grid grid-cols-[minmax(0,9rem)_1fr_auto] text-[13px] leading-[18px]")} title={t("usage.page.turns", { count: String(group.turns) })}>
            <span className="flex min-w-0 items-center gap-2 text-ink">
              {bot && <BotAvatar bot={bot} state="idle" size={18} animated={false} />}
              <span className="truncate">{groupBy === "model" ? modelName(group.label, state.instances) : usageGroupLabel(groupBy, group)}</span>
            </span>
            <span className="h-1 overflow-hidden rounded-full bg-ink/[0.06]">
              <span className="block h-full rounded-full bg-ink/40" style={{ width: `${Math.max(2, (headlineTokens(group) / max) * 100)}%` }} />
            </span>
            <span className="min-w-[4.5rem] text-end tabular-nums text-ink-secondary">
              {formatTokens(headlineTokens(group))}
              {hasFiniteCost(group.costUsd) && group.costUsd > 0 && ` · ${formatCost(group.costUsd)}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function WhereItWent({ range, version }: { range: { from: string; to: string }; version: number }) {
  const [other, setOther] = useState<UsageGroupBy>("model");
  const byBot = useUsageGroups(range, "bot", version);
  const byOther = useUsageGroups(range, other, version);
  return (
    <>
      <RowsCard label={t("usage.page.where")}>
        {byBot ? <GroupBars groupBy="bot" groups={byBot.groups} /> : <NoteRow>{t("common.checking")}</NoteRow>}
      </RowsCard>
      <RowsCard label={t(GROUP_LABEL_KEYS[other])} action={(
        <div role="tablist" aria-label={t("usage.history.groupBy")} className="flex flex-wrap justify-end gap-0.5">
          {OTHER_GROUPINGS.map((option) => (
            <button key={option} type="button" role="tab" aria-selected={other === option} onClick={() => setOther(option)}
              className="cursor-pointer rounded-md px-1.5 py-px text-[12px] leading-4 text-ink-secondary hover:text-ink aria-selected:bg-ink/[0.06] aria-selected:text-ink focus-visible:outline-2 focus-visible:outline-focus">
              {t(GROUP_LABEL_KEYS[option])}
            </button>
          ))}
        </div>
      )}>
        {byOther?.groupBy === other ? <GroupBars groupBy={other} groups={byOther.groups} /> : <NoteRow>{t("common.checking")}</NoteRow>}
      </RowsCard>
    </>
  );
}

function startedLabel(at: number): string {
  return new Date(at).toLocaleString(documentLanguage(activeLocale()), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function RunRow({ root, onOpen }: { root: TraceRootSummary; onOpen: () => void }) {
  const { state } = useStore();
  const title = traceRootTitle(root);
  return (
    <li>
      <button type="button" onClick={onOpen} className={cn(rowCls, "grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] text-start hover:bg-ink/[0.035] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus")} data-testid="usage-run">
        <span className="flex w-[38px] shrink-0 -space-x-1.5 sm:w-[74px]">
          {root.bots.slice(0, 4).map((entry, index) => {
            const bot = state.bots.find((item) => item.id === entry.id);
            return bot
              ? <span key={entry.id} className={cn("rounded-full ring-2 ring-card", index > 1 && "hidden sm:block")}><BotAvatar bot={bot} state="idle" size={20} animated={false} /></span>
              : <span key={entry.id} className={cn("flex size-5 items-center justify-center rounded-full bg-raised text-[10px] font-semibold text-ink-secondary ring-2 ring-card", index > 1 && "hidden sm:flex")}>{entry.name.slice(0, 1).toUpperCase()}</span>;
          })}
        </span>
        <span className="min-w-0">
          <span data-row-title="" className="block truncate text-[13px] leading-[18px] text-ink">{title}</span>
          <span data-row-hint="" className="block truncate text-[12px] leading-4 text-ink-secondary">{startedLabel(root.startedAt)} · {root.bots.map((bot) => bot.name).join(", ")}</span>
        </span>
        <span className="flex items-center gap-3 text-[13px] leading-[18px] tabular-nums text-ink-secondary">
          {root.running && <LiveBadge />}
          {root.errors > 0 && <span className="rounded-md bg-danger/12 px-1.5 py-0.5 text-[12px] font-medium text-danger">{t("trace.groupErrors", { count: String(root.errors) })}</span>}
          {root.timed ? <span className="hidden min-w-[3.5rem] text-right sm:inline">{formatDuration(root.durationMs)}</span>
            : <span className="hidden rounded bg-raised px-1.5 text-[11px] sm:inline">{t("trace.notTimed")}</span>}
          <span className="min-w-[3.5rem] text-end text-ink-secondary">{formatCost(root.costUsd)}</span>
          <ChevronRight size={14} className="text-ink-tertiary" />
        </span>
      </button>
    </li>
  );
}

/** The Usage page: a period's totals, where the money went, and every run as a trace. */
export function UsageSection() {
  const [period, setPeriod] = useState<UsagePeriod>("month");
  const range = useMemo(() => usagePeriodRange(period), [period]);
  const [list, setList] = useState<TraceList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<{ id: string; at: number } | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let current = true;
    void fetchTraces(range)
      .then((next) => { if (current) { setList(next); setError(null); } })
      .catch((cause) => { if (current) setError(friendlyError(cause)); });
    return () => { current = false; };
  }, [range, version]);

  useEffect(() => listenLiveFrames({
    onFrame: (frame) => {
      if (frame.kind !== "runtime" || pending.current) return;
      const type = (frame.event as { type?: string } | undefined)?.type;
      if (type !== "turn.started" && type !== "turn.completed") return;
      pending.current = setTimeout(() => { pending.current = null; setVersion((value) => value + 1); }, LIVE_REFRESH_MS);
    },
    onMissedFrames: () => setVersion((value) => value + 1),
  }), []);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);

  const more = () => {
    if (!list?.next) return;
    void fetchTraces(range, list.next).then((page) => setList((current) => current ? { ...page, roots: [...current.roots, ...page.roots] } : page));
  };
  const untimed = list?.roots.some((root) => !root.timed);

  return (
    <div className="flex flex-col gap-5" data-testid="usage-page">
      <RowsCard>
        <div className={cn(rowCls, "flex-wrap")}>
          <RowText title={t("usage.history.period")} />
          <SettingsSelect data-settings-select="usage-period" value={period} onChange={(event) => { setPeriod(event.target.value as UsagePeriod); setOpen(null); }} aria-label={t("usage.history.period")}>
            {USAGE_PERIODS.map((option) => <option key={option} value={option}>{t(PERIOD_LABEL_KEYS[option])}</option>)}
          </SettingsSelect>
          <a href={usageExportHref(range)} download className="ui-button">{t("usage.history.export")}</a>
        </div>
        {error && <NoteRow tone="danger">{error}</NoteRow>}
      </RowsCard>
      {open ? (
        <TraceView id={open.id} at={open.at} actions={(
          <button type="button" onClick={() => setOpen(null)} className="ui-button">{t("trace.back")}</button>
        )} />
      ) : (
        <>
          <section data-testid="usage-totals" className="contents">
            <RowsCard label={t("settings.s2.usage.totals")}>
              {list ? totalsStats(list.totals, t("trace.stat.time")).map((item) => (
                <div key={item.label} title={item.hint} className="contents">
                  <ItemRow title={item.label} value={<span className={cn("tabular-nums", "tone" in item && item.tone === "danger" && "text-danger")}>{item.value}</span>} />
                </div>
              )) : <NoteRow>{t("common.checking")}</NoteRow>}
            </RowsCard>
          </section>
          <WhereItWent range={range} version={version} />
          <section aria-label={t("usage.page.runs")} className="contents">
            <RowsCard label={t("usage.page.runs")} footnote={untimed ? t("usage.page.untimedNote") : undefined}>
              {list && !list.roots.length && <ArtState data-art-state="runs" art="receipt" title={t("empty.runs.title")} className="py-6">{t("empty.runs.hint")}</ArtState>}
              <ul className="contents">
                {list?.roots.map((root) => <RunRow key={root.id} root={root} onOpen={() => setOpen({ id: root.id, at: root.startedAt })} />)}
              </ul>
              {list?.next !== undefined && <NavRow drill={false} title={t("usage.page.more")} onClick={more} />}
            </RowsCard>
          </section>
        </>
      )}
      <PlanUsage />
    </div>
  );
}
