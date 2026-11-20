import { useState } from "react";
import { ArrowLeft } from "@/icons";
import { Link, useLocation } from "../lib/router";
import { Table, Td, Th } from "../ui/table";
import { useAdmin } from "./api";
import { RangePicker, duration, percent, rangeOf, type Range } from "./kit";
import { SURFACES, dimLabel, webQuery, type Surface } from "./Overview";
import { AdminHeader, Failed, Loading, SearchBox, n } from "./ui";

interface Row { key: string; visitors: number; signups: number; paid: number; pageviews?: number; conversion?: number | null; bounce?: number | null; visitMs?: number | null }
const TITLE: Record<string, string> = { channel: "channels", source: "sources", referrer: "referrers", campaign: "campaigns", keyword: "keywords", ref: "ref links", page: "pages", entry: "entry pages", exit: "exit pages", host: "hostnames",
  country: "countries", region: "regions", city: "cities", browser: "browsers", os: "operating systems", device: "devices", surface: "surfaces", goal: "goals" };
type Sort = "visitors" | "signups" | "trials" | "conversion" | "bounce" | "visitMs";
const SORTS: readonly Sort[] = ["visitors", "signups", "trials", "conversion", "bounce", "visitMs"];

/** one card's dimension as a full table: every row, sortable, with conversion, bounce and visit time */
export function DetailsPage({ dimension }: { dimension: string }) {
  const { query } = useLocation();
  const key = (query.get("range") ?? "30d") as Range["key"];
  const [range, setRange] = useState<Range>(() => rangeOf(["today", "7d", "30d", "90d"].includes(key) ? key : "30d"));
  const surface = (query.get("site") ?? "all") as Surface;
  const filters: Record<string, string> = {};
  for (const [k, v] of query) if (k.startsWith("f.")) filters[k.slice(2)] = v;
  const [sort, setSort] = useState<Sort>(() => SORTS.find((s) => s === query.get("sort")) ?? "visitors");
  const [q, setQ] = useState("");
  const { data, error, loading, reload } = useAdmin<{ rows: Row[] }>(`/web/${dimension}?${webQuery(range, surface, filters)}`);
  // the overview's own read, usually already kept: its trials per row
  const web = useAdmin<{ revenue?: { trials?: { cards: Record<string, Record<string, number>> } } }>(`/web?${webQuery(range, surface, filters)}&tz=${new Date().getTimezoneOffset()}`);
  const trials = web.data?.revenue?.trials?.cards[dimension] ?? {};
  const needle = q.trim().toLowerCase();
  const rows = (data?.rows ?? []).map((row) => ({ ...row, trials: trials[row.key] ?? 0 })).filter((row) => !needle || dimLabel(dimension, row.key).toLowerCase().includes(needle))
    .sort((a, b) => ((b[sort] ?? -1) as number) - ((a[sort] ?? -1) as number));
  const max = Math.max(1, ...rows.map((row) => row.visitors));
  const head = (id: Sort, label: string) => (
    <Th className="!text-end" aria-sort={sort === id ? "descending" : "none"}>
      <button type="button" onClick={() => setSort(id)} className={sort === id ? "font-medium text-ink" : "hover-link"}>{label}</button>
    </Th>
  );
  return (
    <>
      <Link to={`/admin?${query.toString()}`.replace(/\?$/, "")} className="text-link mb-4 inline-flex items-center gap-1.5 text-13"><ArrowLeft size={14} strokeWidth={1.75} aria-hidden /> overview</Link>
      <AdminHeader title={TITLE[dimension] ?? dimension} sub={`${surface === "all" ? "every surface" : SURFACES.find((s) => s.value === surface)?.label ?? surface}${Object.keys(filters).length ? `, filtered by ${Object.entries(filters).map(([k, v]) => `${k} ${dimLabel(k, v)}`).join(", ")}` : ""}`}
        action={<RangePicker value={range} onChange={setRange} />} />
      <div className="mb-4"><SearchBox value={q} onChange={setQ} label={`search ${TITLE[dimension] ?? dimension}`} placeholder="search" /></div>
      {error && <Failed error={error} retry={reload} />}
      {!data && loading && <Loading rows={10} />}
      {data && (
        <Table label={TITLE[dimension] ?? dimension}>
          <thead><tr><Th>{dimension}</Th>{head("visitors", "visitors")}{head("signups", "signups")}{head("trials", "trials")}{head("conversion", "conversion")}{head("bounce", "bounce")}{head("visitMs", "visit time")}</tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="hover-row">
                <Td className="relative min-w-[200px]">
                  <span className="absolute inset-y-1.5 left-0 rounded-[8px] bg-accent/12" style={{ width: `${(row.visitors / max) * 100}%` }} aria-hidden />
                  <span className="relative px-2 text-ink">{dimLabel(dimension, row.key)}</span>
                </Td>
                <Td className="text-end font-mono num">{n(row.visitors)}</Td>
                <Td className="text-end font-mono text-coral-deep num">{n(row.signups)}</Td>
                <Td className="text-end font-mono text-money num">{row.trials ? n(row.trials) : "-"}</Td>
                <Td className="text-end font-mono num">{percent(row.conversion ?? (row.visitors ? row.signups / row.visitors : null))}</Td>
                <Td className="text-end font-mono num">{percent(row.bounce ?? null)}</Td>
                <Td className="text-end font-mono num">{duration(row.visitMs ?? null)}</Td>
              </tr>
            ))}
            {!rows.length && <tr><Td colSpan={7} className="py-8 text-center text-ink-3">nothing here in this window.</Td></tr>}
          </tbody>
        </Table>
      )}
    </>
  );
}
