import { useId, useState, type ReactNode } from "react";
import { Search } from "@/icons";
import { Button, cx, Skeleton } from "../ui/kit";
import { Modal } from "../ui/controls";
import { Link, useLocation } from "../lib/router";
import type { FunnelStep } from "./api";
import { m, SPRING, usePill } from "../ui/motion";

export const n = (value: number | null | undefined) => value === null || value === undefined ? "-" : value.toLocaleString("en-US");
export const pct = (part: number, whole: number) => whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : "-";
export const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export function stamp(t: number | null | undefined) {
  if (!t) return "-";
  const d = new Date(t);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
}

export function AdminHeader({ title, sub, action, tabs }: { title: string; sub?: ReactNode; action?: ReactNode; tabs?: ReactNode }) {
  return (
    <>
      <header className={cx("flex flex-wrap items-end justify-between gap-4", tabs ? "mb-5" : "mb-8 max-sm:mb-6")}>
        <div className="min-w-0">
          <h1 className="text-[32px] font-medium leading-[1.1] tracking-[-0.04em] text-ink max-sm:text-[26px]">{title}</h1>
          {sub && <div className="mt-1.5 text-14 text-ink-3">{sub}</div>}
        </div>
        {action}
      </header>
      {tabs}
    </>
  );
}

/** the views inside one admin page, as links so each has its own address */
export function Tabs({ label, items }: { label: string; items: Array<{ to: string; label: string }> }) {
  const { path } = useLocation();
  const line = usePill();
  return (
    <nav aria-label={label} className="scroll-x mb-8 flex gap-1 max-sm:mb-6">
      {items.map((item) => {
        const active = path === item.to;
        return (
          <Link key={item.to} to={item.to} aria-current={active ? "page" : undefined}
            className={cx("relative inline-flex h-10 shrink-0 items-center px-3 text-14", active ? "font-medium text-ink" : "text-ink-3 hover-link")}>
            {item.label}
            {active && <m.span layoutId={line} transition={SPRING} className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-ink" aria-hidden />}
          </Link>
        );
      })}
    </nav>
  );
}

/** a number with its label; the number is mono so columns of them line up */
export function Tile({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "good" | "warn" | "bad" }) {
  return (
    <div className="min-w-0 rounded-[18px] bg-card px-4 py-3.5">
      <div className="truncate text-13 text-ink-3">{label}</div>
      <div className={cx("mt-1 truncate text-[24px] font-medium leading-8 num", typeof value === "string" && /^[\d,.%$+-]+$/.test(value) ? "font-mono tracking-[-0.03em]" : "tracking-[-0.035em]", tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-ink")}>{value}</div>
      {note && <div className="mt-0.5 truncate text-12 text-ink-3">{note}</div>}
    </div>
  );
}

/** daily bars with a label and total; the values get a screen-reader table */
export function DayBars({ title, days, values, tone = "accent", height = 96 }: { title: string; days: string[]; values: number[]; tone?: "accent" | "ink"; height?: number }) {
  const max = Math.max(1, ...values), total = values.reduce((a, b) => a + b, 0);
  const [hover, setHover] = useState<number | null>(null);
  const at = hover ?? values.length - 1;
  return (
    <figure className="min-w-0">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-13 text-ink-2">{title}</span>
        <span className="t-meta num">{hover === null ? `${n(total)} total` : `${days[at]} · ${n(values[at] ?? 0)}`}</span>
      </figcaption>
      <svg viewBox={`0 0 ${values.length * 10} ${height}`} preserveAspectRatio="none" className="draw-in mt-2 block w-full" style={{ height }} aria-hidden onMouseLeave={() => setHover(null)}>
        {values.map((v, i) => {
          const h = v === 0 ? 1.5 : Math.max(3, (v / max) * (height - 4));
          return (
            <g key={days[i]} onMouseEnter={() => setHover(i)}>
              <rect x={i * 10} y={0} width={10} height={height} fill="transparent" />
              <rect x={i * 10 + 1.5} y={height - h} width={7} height={h} rx={1.5} fill={v === 0 ? "var(--track)" : tone === "accent" ? "var(--accent)" : "var(--heat-2)"} opacity={hover === null || hover === i ? 1 : 0.45} />
            </g>
          );
        })}
      </svg>
      <div className="mt-1.5 flex justify-between t-meta !text-[11.5px]" aria-hidden><span>{days[0]?.slice(5)}</span><span>{days.at(-1)?.slice(5)}</span></div>
      <div className="sr-only"><table><caption>{title} per day</caption><tbody>{days.map((day, i) => <tr key={day}><th scope="row">{day}</th><td>{values[i]}</td></tr>)}</tbody></table></div>
    </figure>
  );
}

/** the funnel as one strip: each step's count, a bar against the first signup step, and conversion from the step before */
export function FunnelStrip({ steps }: { steps: FunnelStep[] }) {
  const signups = steps.find((step) => step.id === "signup")?.count ?? 0;
  return (
    <ol className="grid grid-cols-7 gap-1.5 overflow-hidden rounded-[20px] max-xl:grid-cols-4 max-sm:grid-cols-2" aria-label="funnel">
      {steps.map((step, i) => {
        const prev = steps[i - 1];
        const base = step.id === "site" ? Math.max(step.count, 1) : Math.max(signups, 1);
        return (
          <li key={step.id} className="flex min-w-0 flex-col bg-card px-4 pb-4 pt-3.5 max-xl:last:col-span-2 max-sm:last:col-span-2">
            <span className="t-meta truncate">{i + 1}. {step.label}</span>
            <span className="mt-2 font-mono text-[26px] font-medium leading-8 tracking-[-0.04em] text-ink num">{n(step.count)}</span>
            <span className="mt-0.5 text-12 text-ink-3 num">{prev ? <>{pct(step.count, prev.count)} <span className="text-ink-4">of {prev.label}</span></> : "in the window"}</span>
            <span className="mt-3 h-1.5 overflow-hidden rounded-full bg-track" aria-hidden>
              <span className="bar-fill block h-full w-full rounded-full bg-accent" style={{ transform: `scaleX(${Math.min(1, step.count / base)})` }} />
            </span>
            {step.total !== step.count && <span className="mt-2 text-12 text-ink-4 num">{n(step.total)} of all signups</span>}
          </li>
        );
      })}
    </ol>
  );
}

const TONES: Record<string, "good" | "warn" | "bad" | "quiet" | "accent"> = { trial: "accent",
  running: "good", active: "good", synced: "good", ok: "good", paid: "good",
  provisioning: "accent", checkout: "quiet", sleeping: "quiet", stopped: "quiet", destroyed: "quiet", ended: "quiet", pending: "quiet", not_configured: "quiet", cancelled: "warn",
  payment_problem: "warn", suspended: "warn", behind: "warn", destroying: "warn", error: "bad", failed: "bad", refunded: "warn",
};
/** a status in words with a small square; colour is never the only signal */
export function Status({ value, label }: { value: string; label?: string }) {
  const tone = TONES[value] ?? "quiet";
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-13 text-ink-2">
      <span className={cx("inline-block size-[7px] shrink-0 rounded-[2px]", tone === "good" ? "bg-good" : tone === "warn" ? "bg-warn" : tone === "bad" ? "bg-bad" : tone === "accent" ? "bg-accent" : "bg-ink-4")} aria-hidden />
      {label ?? value.replace(/_/g, " ")}
    </span>
  );
}

export function SearchBox({ value, onChange, label, placeholder, id }: { value: string; onChange(value: string): void; label: string; placeholder?: string; id?: string }) {
  const fallback = useId();
  const inputId = id ?? fallback;
  return (
    <div className="relative w-full max-w-[360px] max-sm:max-w-none">
      <label htmlFor={inputId} className="sr-only">{label}</label>
      <Search size={16} strokeWidth={1.75} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-4" aria-hidden />
      <input id={inputId} type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} className="field !h-10 !ps-10 !text-14" data-admin-search />
    </div>
  );
}

export function Pager({ offset, limit, total, onChange }: { offset: number; limit: number; total: number; onChange(offset: number): void }) {
  if (total <= limit) return null;
  return (
    <nav aria-label="pages" className="mt-4 flex items-center justify-between gap-3">
      <span className="t-meta num">{n(offset + 1)} to {n(Math.min(offset + limit, total))} of {n(total)}</span>
      <div className="flex gap-2">
        <Button size="sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>previous</Button>
        <Button size="sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>next</Button>
      </div>
    </nav>
  );
}

export function Loading({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="loading" className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-11" />)}
    </div>
  );
}

export function Failed({ error, retry }: { error: { message: string }; retry(): void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-[18px] bg-card px-4 py-3 text-14 text-bad">
      <span className="min-w-0 flex-1">{error.message}</span>
      <Button size="sm" onClick={retry}>try again</Button>
    </div>
  );
}

/** a read that hit its event limit: what it covers, so a short count is never read as a drop */
export function PartialNote({ before }: { before: number | null | undefined }) {
  if (!before) return null;
  return <p role="status" className="mb-3 rounded-[14px] bg-wash-lemon px-4 py-2.5 text-13 text-ink">too many events to read them all: counts start at {stamp(before)} utc, earlier events are left out.</p>;
}

export function Section({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cx("mt-10 first:mt-0", className)}>
      <div className="mb-3 flex min-h-9 flex-wrap items-center justify-between gap-3">
        <h2 id={id} className="text-16 font-medium tracking-[-0.02em] text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** a destructive or disruptive action: the person types the thing's name before the button arms */
export function ConfirmAction({ open, onClose, title, body, word, action, danger, onConfirm }: { open: boolean; onClose(): void; title: string; body: ReactNode; word: string; action: string; danger?: boolean; onConfirm(): Promise<void> }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const close = () => { if (!busy) { setTyped(""); setError(null); onClose(); } };
  const run = async () => {
    setBusy(true); setError(null);
    try { await onConfirm(); setTyped(""); onClose(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={close} title={title}
      footer={<><Button variant="ghost" onClick={close} disabled={busy}>keep it</Button><Button variant={danger ? "danger" : "primary"} disabled={typed.trim() !== word || busy} aria-busy={busy} onClick={() => void run()}>{busy ? "working" : action}</Button></>}>
      <div>{body}</div>
      <label htmlFor={id} className="mt-4 block text-13 text-ink-2">type <span className="t-id text-ink">{word}</span> to confirm</label>
      <input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className="field mt-1.5 font-mono !text-14" aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined}
        onKeyDown={(e) => { if (e.key === "Enter" && typed.trim() === word && !busy) void run(); }} />
      {error && <p id={`${id}-error`} role="alert" className="mt-2 text-13 text-bad">{error}</p>}
    </Modal>
  );
}
