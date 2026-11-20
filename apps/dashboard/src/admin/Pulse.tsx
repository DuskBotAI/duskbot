import type { ReactNode } from "react";
import { ChartNoAxesColumn, ChartNoAxesCombined, CircleAlert, CircleCheck, Cloud, Gauge, Inbox, Repeat } from "@/icons";
import { cx } from "../ui/kit";
import { ago } from "../lib/format";
import { Link } from "../lib/router";
import { useNow } from "../lib/now";
import { useAdmin, type EventRow, type Health, type Overview } from "./api";
import { percent } from "./kit";
import { n } from "./ui";

interface Rate { n: number; of: number }
interface RetentionAnswer { cohorts: Array<{ size: number; d1: Rate | null; d7: Rate | null }> }
const I = { size: 14, strokeWidth: 1.75 } as const;

function Tile({ to, label, icon, wash, value, children, loading }: { to: string; label: string; icon: ReactNode; wash: string; value: ReactNode; children?: ReactNode; loading?: boolean }) {
  return (
    <Link to={to} className={cx("group flex min-w-0 flex-col rounded-[20px] px-4 py-3.5 transition-[filter] duration-150 hover:brightness-[0.98]", wash)}>
      <span className="flex items-center gap-1.5 text-13 text-ink-2"><span aria-hidden className="text-ink-3">{icon}</span>{label}<span aria-hidden className="ms-auto text-ink-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">open</span></span>
      {loading ? <span className="skeleton mt-2 block h-7 w-16" aria-hidden /> : <span className="mt-1 truncate font-mono text-[24px] font-medium leading-8 tracking-[-0.04em] text-ink num">{value}</span>}
      <span className="mt-0.5 min-h-[19px] truncate text-12 text-ink-3">{loading ? "" : children}</span>
    </Link>
  );
}

function Spark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <svg viewBox={`0 0 ${values.length * 6} 20`} className="ms-2 inline-block h-3.5 w-16 align-[-2px]" aria-hidden>
      {values.map((v, i) => <rect key={i} x={i * 6 + 1} y={20 - Math.max(1.5, (v / max) * 20)} width={4} height={Math.max(1.5, (v / max) * 20)} rx={1} fill={v ? "var(--viz-renewal)" : "var(--track)"} />)}
    </svg>
  );
}

/** the other admin pages in one glance each: a number, a line, and a way in */
export function PulseGrid({ overview }: { overview: { data: Overview | null; error: unknown } }) {
  const now = useNow(60_000);
  const health = useAdmin<Health>("/health", 60_000);
  const retention = useAdmin<RetentionAnswer>("/retention");
  const events = useAdmin<{ counts: Array<{ name: string; count: number }>; events: EventRow[] }>("/events?days=1&limit=3", 60_000);
  const o = overview.data, h = health.data;
  const problems = h ? [!h.database.ok && "database", !(h.analytics.ok && !h.analytics.failed) && "analytics", h.errors.service.hour > 0 && "errors", h.backup.configured && h.backup.ok === false && "backup", ...h.checks.filter((c) => !c.ok).map((c) => c.name)].filter((x): x is string => !!x) : [];
  const rate = (key: "d1" | "d7") => {
    const list = (retention.data?.cohorts ?? []).map((c) => c[key]).filter((r): r is Rate => !!r);
    const of = list.reduce((s, r) => s + r.of, 0);
    return of ? list.reduce((s, r) => s + r.n, 0) / of : null;
  };
  const running = o ? o.clouds.find((c) => c.state === "running")?.count ?? 0 : 0;
  const todayEvents = events.data ? events.data.counts.reduce((s, c) => s + c.count, 0) : 0;
  const latest = events.data?.events[0];
  return (
    <section aria-label="everything else at a glance" className="grid grid-cols-2 gap-2">
      <Tile to="/admin/waitlist" label="waitlist" icon={<Inbox {...I} />} wash="bg-wash-lemon" loading={!o && !overview.error} value={o?.totals.waitlist === null ? "-" : n(o?.totals.waitlist)}>
        {o && (o.totals.waitlist === null ? "not connected" : <>{n(o.series.waitlist.slice(-7).reduce((a, b) => a + b, 0))} this week<Spark values={o.series.waitlist.slice(-14)} /></>)}
      </Tile>
      <Tile to="/admin/clouds" label="clouds" icon={<Cloud {...I} />} wash="bg-wash-sky" loading={!o && !overview.error} value={n(o?.totals.clouds)}>
        {o && `${n(running)} running · ${n(o.totals.paying)} paying`}
      </Tile>
      <Tile to="/admin/health" label="health" icon={problems.length ? <CircleAlert {...I} /> : <Gauge {...I} />} wash={problems.length ? "bg-wash-pink" : "bg-wash-lime"} loading={!h && !health.error}
        value={h ? (problems.length ? `${problems.length} to check` : "all good") : "-"}>
        {h && (problems.length ? <span className="text-bad">{problems.join(", ")}</span> : <span className="inline-flex items-center gap-1"><CircleCheck size={12} strokeWidth={2} className="text-good" aria-hidden />up {Math.round(h.service.uptimeSec / 3600)}h, no errors this hour</span>)}
      </Tile>
      <Tile to="/admin/retention" label="came back" icon={<Repeat {...I} />} wash="bg-wash-lilac" loading={!retention.data && !retention.error} value={percent(rate("d1"))}>
        {retention.data && `next day · ${percent(rate("d7"))} in week 2`}
      </Tile>
      <Tile to="/admin/product" label="using the app" icon={<ChartNoAxesCombined {...I} />} wash="bg-wash-sky" loading={!o && !overview.error} value={n(o?.totals.appWau)}>
        {o && `this week · ${n(o.bots.bots)} bots, ${n(o.bots.turns30d)} replies in 30d`}
      </Tile>
      <Tile to="/admin/events" label="events today" icon={<ChartNoAxesColumn {...I} />} wash="bg-wash-pink" loading={!events.data && !events.error} value={n(todayEvents)}>
        {latest ? `latest: ${latest.name.replace(/_/g, " ")}, ${ago(latest.at, now)}` : "nothing yet today"}
      </Tile>
    </section>
  );
}
