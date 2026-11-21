import { useId, useMemo, useState, type ReactNode } from "react";
import { cx, Segmented } from "../ui/kit";
import { Nil, Table, Td, Th } from "../ui/table";
import { ago } from "../lib/format";
import { useNow } from "../lib/now";
import { Link } from "../lib/router";
import { AnimatePresence } from "../ui/motion";
import { useAdmin } from "./api";
import { usd } from "./kit";
import { SidePanel } from "./sheet";
import { AdminHeader, DayBars, Failed, Loading, n, PartialNote, Section, stamp } from "./ui";

type Bucket = "trial" | "cancelling" | "paid" | "payment_problem" | "cancelled";
type Filter = Bucket | "all";
export interface SubscriberRow {
  accountId: string; handle: string; email: string | null; name: string | null; country: string | null;
  plan: string; bucket: Bucket; status: string; reason: string | null; monthlyCents: number;
  started: number; trialEndsAt: number | null; renewsAt: number | null;
  messages7d: number; messages: number; turns: number; turns7d: number; failed: number; engines: string[]; apps: number; routines: number; bots: number;
  lastActive: number | null; platforms: string[]; places: string[]; cloud: string | null;
  atRisk?: "dispute" | null;
}
const atRisk = (row: SubscriberRow) => row.atRisk ? <span data-at-risk={row.atRisk} className="inline-flex h-6 items-center whitespace-nowrap rounded-full bg-wash-pink px-2.5 text-12 text-ink">at risk: dispute</span> : null;
interface Launch { since: number; label: string; accounts: number; mrrCents: number; atRiskCents?: number; trial: number; paying: number; paymentProblem?: number; cancelling: number; cancelled: number; receivedCents?: number; collectedCents?: number }
interface Answer { now: number; filter: Filter; counts: Record<Filter, number>; rows: SubscriberRow[]; launch: Launch; partialBefore: number | null }
interface Count { key: string; count: number }
interface Detail {
  account: { id: string; handle: string; email: string | null; name: string | null; createdAt: number };
  row: SubscriberRow;
  daily: Array<{ day: string; sent: number; turns: number; failed: number }>;
  timeline: Array<{ at: number; kind: string; label: string }>;
  usage: { features: Count[]; engines: Count[]; failures: Count[] };
  reports: Array<{ id: string; source: string; description: string; appVersion: string; platform: string; status: string; fixedIn: string | null; receivedAt: number }>;
  cancel: Array<{ answer: string; expected: string | null; improve: string | null; offer: string | null; outcome: string; at: number }>;
}

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "trial", label: "trial" }, { value: "cancelling", label: "cancelling" }, { value: "paid", label: "paid" }, { value: "payment_problem", label: "payment problem" }, { value: "cancelled", label: "cancelled" }, { value: "all", label: "everyone" },
];
const WASH: Record<Bucket, string> = { trial: "bg-wash-sky", cancelling: "bg-wash-lemon", paid: "bg-wash-lime", payment_problem: "bg-wash-lilac", cancelled: "bg-wash-pink" };
const who = (row: { email: string | null; handle: string }) => row.email ?? row.handle;
const day = (t: number | null) => t ? stamp(t).slice(0, 10) : null;

type Key = "person" | "plan" | "status" | "started" | "ends" | "messages" | "turns" | "engines" | "setup" | "active" | "platform" | "where";
const COLUMNS: Array<{ key: Key; label: string; end?: boolean; value(row: SubscriberRow): string | number }> = [
  { key: "person", label: "person", value: (row) => who(row) },
  { key: "plan", label: "plan", value: (row) => row.plan },
  { key: "status", label: "status", value: (row) => row.status },
  { key: "started", label: "started", value: (row) => row.started },
  { key: "ends", label: "trial ends / renews", value: (row) => row.trialEndsAt ?? row.renewsAt ?? 0 },
  { key: "messages", label: "messages 7d / all", end: true, value: (row) => row.messages7d * 1e6 + row.messages },
  { key: "turns", label: "turns", end: true, value: (row) => row.turns },
  { key: "engines", label: "engines", value: (row) => row.engines.join(",") },
  { key: "setup", label: "bots · routines · apps", value: (row) => row.bots * 1e6 + row.routines * 1e3 + row.apps },
  { key: "active", label: "last active", value: (row) => row.lastActive ?? 0 },
  { key: "platform", label: "platform", value: (row) => row.platforms.join(",") },
  { key: "where", label: "bots run", value: (row) => `${row.places.join(",")}${row.cloud ?? ""}` },
];

interface TrialTotals { active: number; cancelling: number; mrrAtStake: number; ended: number; converted: number; conversion: number | null }
/** the free trials in one line, over the revenue page's money: what is running, what it is worth, and how many finished trials paid */
export function TrialsSummary() {
  const { data } = useAdmin<{ trials: TrialTotals }>("/subscribers?filter=trial", 60_000);
  const t = data?.trials;
  const items: Array<[string, string]> = t ? [["running", n(t.active)], ["cancelling", n(t.cancelling)], ["mrr at stake", usd(t.mrrAtStake, true)],
    ["trial to paid", t.conversion === null ? "-" : `${Math.round(t.conversion * 100)}%`], ["trials over", n(t.ended)]] : [];
  return (
    <section aria-label="free trials" className="mb-6 flex min-h-[46px] flex-wrap items-center gap-x-6 gap-y-2 rounded-[18px] bg-wash-sky px-4 py-2.5">
      <Link to="/admin/subscribers" className="text-link text-13 text-ink">free trials</Link>
      {items.map(([label, value]) => (
        <span key={label} className="flex items-baseline gap-1.5"><span className="font-mono text-15 text-ink num">{value}</span><span className="text-12 text-ink-2">{label}</span></span>
      ))}
    </section>
  );
}

/** the launch cohort in one line: what will bill, who is where in the trial, and what was taken */
function LaunchStrip({ launch }: { launch: Launch }) {
  const items: Array<[string, string]> = [["mrr", usd(launch.mrrCents, true)], ...(launch.paymentProblem ? [["at risk", `${usd(launch.atRiskCents ?? 0, true)}/mo (${n(launch.paymentProblem)})`] as [string, string]] : []),
    ["trial", n(launch.trial)], ["paying", n(launch.paying)], ["cancelling", n(launch.cancelling)],
    ["cancelled", n(launch.cancelled)], ["received", usd(launch.receivedCents ?? launch.collectedCents ?? 0, true)]];
  return (
    <section aria-label="launch cohort" className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[18px] bg-card px-4 py-2.5">
      <span className="text-13 text-ink-2">launch cohort <span className="text-ink-3">· {launch.label} · {n(launch.accounts)} accounts</span></span>
      {items.map(([label, value]) => (
        <span key={label} className="flex items-baseline gap-1.5"><span className="font-mono text-15 text-ink num">{value}</span><span className="text-12 text-ink-3">{label}</span></span>
      ))}
    </section>
  );
}

function Counts({ title, rows, empty }: { title: string; rows: Count[]; empty: string }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-13 font-medium text-ink">{title}</h3>
      {rows.length ? <ul className="flex flex-col gap-1 text-13">{rows.map((row) => <li key={row.key} className="flex justify-between gap-3"><span className="min-w-0 truncate text-ink-2">{row.key}</span><span className="font-mono text-ink num">{n(row.count)}</span></li>)}</ul>
        : <p className="text-13 text-ink-3">{empty}</p>}
    </div>
  );
}

function SubscriberSheet({ id, onClose }: { id: string; onClose(): void }) {
  const { data, error, reload } = useAdmin<Detail>(`/subscribers/${encodeURIComponent(id)}`);
  const titleId = useId();
  const row = data?.row;
  return (
    <SidePanel label="subscriber" titleId={titleId} onClose={onClose} wide>
      {error && <div className="mt-4"><Failed error={error} retry={reload} /></div>}
      {!data && !error && <div className="mt-4"><Loading rows={6} /></div>}
      {data && row && (
        <div className="mt-2 flex flex-col gap-6">
          <div>
            <h2 id={titleId} className="truncate text-20 font-medium tracking-[-0.02em] text-ink">{who(data.account)}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-13 text-ink-3">
              <span className={cx("inline-flex h-6 items-center rounded-full px-2.5 text-12 text-ink", WASH[row.bucket])}>{row.status}</span>
              {atRisk(row)}
              <span>{row.plan} · {usd(row.monthlyCents)}/mo</span>
              {row.country && <span>· {row.country}</span>}
              <span>· {row.platforms.join(", ") || "no app yet"} · {row.places.join(", ") || "no bots yet"}{row.cloud ? ` (cloud ${row.cloud})` : ""}</span>
            </p>
            {row.reason && <p className="mt-2 rounded-[14px] bg-wash-pink px-3 py-2 text-13 text-ink">why they left: {row.reason}</p>}
          </div>
          <div className="rounded-[18px] bg-card p-4">
            <DayBars title="messages sent a day, last 30 days" days={data.daily.map((d) => d.day)} values={data.daily.map((d) => d.sent)} height={80} />
            <p className="mt-2 text-12 text-ink-3">{n(row.messages7d)} this week · {n(row.messages)} in all · {n(row.turns)} bot turns, {n(row.failed)} failed · {row.bots} bots, {row.routines} routines, {row.apps} apps</p>
          </div>
          <Section title="what happened">
            <ol className="flex flex-col gap-1.5">
              {data.timeline.map((step, i) => (
                <li key={`${step.at}-${i}`} className="flex gap-3 text-13"><time className="t-id w-[124px] shrink-0 text-ink-3">{stamp(step.at)}</time><span className="text-ink">{step.label}</span></li>
              ))}
            </ol>
          </Section>
          <div className="grid grid-cols-3 gap-5 max-sm:grid-cols-1">
            <Counts title="engines signed in" rows={data.usage.engines} empty="none yet" />
            <Counts title="features used" rows={data.usage.features} empty="none yet" />
            <Counts title="what went wrong" rows={data.usage.failures} empty="nothing reported" />
          </div>
          <Section title="their feedback">
            {data.cancel.map((item) => (
              <p key={item.at} className="mb-2 rounded-[14px] bg-card px-3 py-2 text-13 text-ink">{item.outcome === "cancelled" ? "cancel survey" : `cancel flow, ${item.outcome}`}, {day(item.at)}: <b className="font-medium">{item.answer}</b>{item.offer ? ` · offered: ${item.offer}` : ""}{item.expected ? ` · expected: ${item.expected}` : ""}{item.improve ? ` · improve: ${item.improve}` : ""}</p>
            ))}
            {data.reports.map((report) => (
              <div key={report.id} className="mb-2 rounded-[14px] bg-card px-3 py-2">
                <p className="text-12 text-ink-3">{report.source} · v{report.appVersion} · {day(report.receivedAt)} · {report.status}{report.fixedIn ? ` in ${report.fixedIn}` : ""}</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-13 text-ink">{report.description}</p>
              </div>
            ))}
            {!data.cancel.length && !data.reports.length && <p className="text-13 text-ink-3">no feedback or reports from them.</p>}
          </Section>
        </div>
      )}
    </SidePanel>
  );
}

/** everyone with a subscription, built to watch the trial flow: who is in a trial and how far along, who pays, who is leaving and why */
export function SubscribersPage() {
  const [filter, setFilter] = useState<Filter>("trial");
  const [sort, setSort] = useState<{ key: Key; down: boolean }>({ key: "started", down: true });
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading, reload } = useAdmin<Answer>(`/subscribers?filter=${filter}`, 60_000);
  const now = useNow(60_000);
  const rows = useMemo(() => {
    const column = COLUMNS.find((c) => c.key === sort.key)!;
    return [...(data?.rows ?? [])].sort((a, b) => {
      const x = column.value(a), y = column.value(b);
      const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return sort.down ? -order : order;
    });
  }, [data, sort]);
  const by = (key: Key) => setSort((before) => ({ key, down: before.key === key ? !before.down : key !== "person" && key !== "plan" }));
  const cell = (row: SubscriberRow, key: Key): ReactNode => {
    switch (key) {
      case "person": return <span className="block max-w-[240px]"><span className="block truncate text-14 text-ink">{who(row)}</span><span className="block truncate text-12 text-ink-3">{row.country ?? "somewhere"}{row.email ? ` · ${row.handle}` : ""}</span></span>;
      case "plan": return <span className="text-13">{row.plan}<span className="block text-12 text-ink-3">{usd(row.monthlyCents)}/mo</span></span>;
      case "status": return <span><span className={cx("inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-12 text-ink", WASH[row.bucket])}>{row.status}</span>{row.atRisk && <span className="mt-1 block">{atRisk(row)}</span>}{row.reason && <span className="mt-0.5 block max-w-[200px] truncate text-12 text-ink-3" title={row.reason}>{row.reason}</span>}</span>;
      case "started": return <span className="t-id whitespace-nowrap text-ink-2">{day(row.started)}</span>;
      case "ends": return <span className="t-id whitespace-nowrap text-ink-2">{day(row.trialEndsAt ?? row.renewsAt) ?? <Nil />}</span>;
      case "messages": return <span className="font-mono num">{n(row.messages7d)} <span className="text-ink-3">/ {n(row.messages)}</span></span>;
      case "turns": return <span className="whitespace-nowrap font-mono num">{n(row.turns)}{row.failed ? <span className="block text-12 text-bad">{n(row.failed)} failed</span> : null}</span>;
      case "engines": return row.engines.length ? <span className="text-13 text-ink-2">{row.engines.join(", ")}</span> : <Nil />;
      case "setup": return row.bots + row.routines + row.apps ? <span className="whitespace-nowrap font-mono text-13 num">{row.bots} · {row.routines} · {row.apps}</span> : <Nil />;
      case "active": return <span className="whitespace-nowrap text-13 text-ink-3">{row.lastActive ? ago(row.lastActive, now) : <Nil />}</span>;
      case "platform": return row.platforms.length ? <span className="text-13 text-ink-2">{row.platforms.join(", ")}</span> : <Nil />;
      case "where": return row.places.length ? <span className="whitespace-nowrap text-13 text-ink-2">{row.places.join(", ")}{row.cloud ? <span className="block text-12 text-ink-3">cloud {row.cloud}</span> : null}</span> : <Nil />;
    }
  };
  return (
    <>
      <AdminHeader title="subscribers" sub="everyone with a subscription: where they are in the trial, what they do in the app, and why they left" />
      {data && <LaunchStrip launch={data.launch} />}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Segmented<Filter> label="show" value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ value: f.value, label: data ? `${f.label} ${n(data.counts[f.value])}` : f.label }))} />
      </div>
      <PartialNote before={data?.partialBefore} />
      {error && <Failed error={error} retry={reload} />}
      {!data && loading && <Loading />}
      {data && (rows.length ? (
        <Table label="subscribers">
          <thead><tr>{COLUMNS.map((column) => (
            <Th key={column.key} className={column.end ? "!text-end" : undefined} aria-sort={sort.key === column.key ? (sort.down ? "descending" : "ascending") : undefined}>
              <button type="button" onClick={() => by(column.key)} className="hover:text-ink">{column.label}{sort.key === column.key ? (sort.down ? " ↓" : " ↑") : ""}</button>
            </Th>
          ))}</tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.accountId} className="hover-row cursor-pointer" tabIndex={0} onClick={() => setOpen(row.accountId)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(row.accountId); }} aria-label={`open ${who(row)}`}>
                {COLUMNS.map((column) => <Td key={column.key} className={column.end ? "text-end" : undefined}>{cell(row, column.key)}</Td>)}
              </tr>
            ))}
          </tbody>
        </Table>
      ) : <p className="rounded-[18px] bg-card px-4 py-6 text-center text-13 text-ink-2">no {filter === "all" ? "subscribers" : `${FILTERS.find((f) => f.value === filter)?.label ?? filter} subscribers`} right now.</p>)}
      <AnimatePresence>{open && <SubscriberSheet key={open} id={open} onClose={() => setOpen(null)} />}</AnimatePresence>
    </>
  );
}
