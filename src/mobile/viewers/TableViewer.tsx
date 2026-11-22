import { useContext, useDeferredValue, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, Copy, Download, Search } from "../../icons";
import { cn } from "@/lib/cn";
import type { TableCell, TableColumn } from "@/components/RichTable";
import { useCopyFeedback } from "@/lib/copy-text";
import { downloadTableCsv, numericColumns, SEARCHABLE_TABLE_ROWS, tableCsv, tableRowOrder, type TableSort } from "@/lib/table-data";
import { CELL_PADDING_PX, columnMinimums, fitsColumns } from "@/lib/table-fit";
import { t } from "@/lib/i18n";
import { phoneBridge } from "@/lib/phone-bridge";
import { useChrome } from "../chrome";
import { isGlassDark, safeInsetPx, useGlassPill } from "../native-glass";
import { PlatformContext } from "../platform";
import { RoundButton } from "../RoundButton";
import { Sheet } from "../Sheet";
import { ViewerNote } from "./ViewerNote";

/** Arrows as text after a no-break space, so one never wraps onto a line of its own: a browser may break before an icon. */
const SORT_MARK = { ascending: "\u00A0↑", descending: "\u00A0↓", none: "\u00A0↑" } as const;

/** A reply's table full screen. Its columns fit the screen when their words do; otherwise it scrolls sideways under a
 * first column that stays put. Tapping a column's name sorts by it, and a long table can be searched. */
export function TableViewer({ columns, rows, name, direction = "ltr", open, onClose }: {
  columns: TableColumn[];
  rows: TableCell[][];
  name: string;
  direction?: "rtl" | "ltr";
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sort, setSort] = useState<TableSort>(null);
  const values = useMemo(() => rows.map((row) => row.map((cell) => cell.text)), [rows]);
  const order = useMemo(() => tableRowOrder(values, deferredQuery, sort), [values, deferredQuery, sort]);
  const csv = useMemo(() => tableCsv(columns.map((column) => column.text), order.map((index) => values[index]!)), [columns, order, values]);
  const { state: copied, copy } = useCopyFeedback(csv);
  const minimums = useMemo(() => columnMinimums(columns.map((column) => column.text), values), [columns, values]);
  const numeric = useMemo(() => numericColumns(columns.length, values), [columns, values]);

  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null);
  const [view, setView] = useState({ width: null as number | null, more: false, scrolled: false, moved: false });
  useEffect(() => {
    const el = scrollerEl;
    if (!el) return;
    const read = () => setView((was) => {
      const width = el.clientWidth || null;
      const left = Math.abs(el.scrollLeft);
      const more = left + el.clientWidth < el.scrollWidth - 1;
      const scrolled = left > 1;
      const moved = was.moved || left > 4;
      return was.width === width && was.more === more && was.scrolled === scrolled && was.moved === moved ? was : { width, more, scrolled, moved };
    });
    read();
    el.addEventListener("scroll", read, { passive: true });
    const resized = typeof ResizeObserver === "function" ? new ResizeObserver(read) : null;
    resized?.observe(el);
    if (el.firstElementChild) resized?.observe(el.firstElementChild);
    return () => { el.removeEventListener("scroll", read); resized?.disconnect(); };
  }, [scrollerEl]);
  const fit = fitsColumns({ wrap: true, virtual: false, minimums, available: view.width });

  const alignment = (column: TableColumn, index: number) => column.align ?? (numeric[index] || direction === "rtl" ? "right" : "left");
  const sortBy = (column: number) => {
    phoneBridge()?.haptic("selection");
    setSort(sort?.column !== column ? { column, descending: false } : !sort.descending ? { column, descending: true } : null);
  };
  const rowCount = (count: number) => t(count === 1 ? "mobile.table.rows.one" : "mobile.table.rows", { count: count.toLocaleString() });
  const download = () => downloadTableCsv(name, csv);
  const systemBar = useChrome() !== null;
  const glass = useContext(PlatformContext)?.glass;
  const showHint = open && view.more && !view.moved && copied === "idle";
  const hintText = t("mobile.table.moreColumns", { count: columns.length });
  const nativeHint = useGlassPill(
    glass,
    "bottom",
    showHint
      ? {
          id: "table-hint",
          text: hintText,
          trailingSymbol: direction === "rtl" ? "chevron.left" : "chevron.right",
          offset: Math.round(safeInsetPx("bottom") + 20),
          dark: isGlassDark(),
        }
      : null,
  );

  return (
    <Sheet open={open} onClose={onClose} full label={name}
      title={systemBar ? name : <span className="flex min-w-0 items-baseline gap-2"><span className="truncate">{name}</span><span className="shrink-0 text-[13px] font-normal text-ink-tertiary tabular-nums">{rowCount(rows.length)}</span></span>}
      actions={[
        { key: "download", label: t("table.download"), symbol: "square.and.arrow.down", onPress: download },
        { key: "copy", label: copied === "copied" ? t("table.copied") : t("table.copyPlain"), symbol: copied === "copied" ? "checkmark" : "doc.on.doc", onPress: () => void copy() },
      ]}
      trailing={<div className="flex items-center gap-2">
        <RoundButton label={t("table.download")} onClick={download}><Download size={18} /></RoundButton>
        <RoundButton label={copied === "copied" ? t("table.copied") : t("table.copyPlain")} onClick={copy}>
          {copied === "copied" ? <Check size={18} className="text-success" /> : <Copy size={18} />}
        </RoundButton>
      </div>}
      bodyClassName="!overflow-hidden flex flex-col !pb-0">
      {rows.length > SEARCHABLE_TABLE_ROWS && <div className="shrink-0 px-4 pb-3">
        <label className="flex h-11 items-center gap-2 rounded-full bg-menu px-4 text-ink-secondary">
          <Search aria-hidden size={19} />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("table.search")} placeholder={t("table.search")}
            className="h-full min-w-0 flex-1 border-0 bg-transparent text-[16px] text-ink placeholder:text-ink-tertiary" />
          {deferredQuery.trim() && <span role="status" className="shrink-0 text-[13px] tabular-nums text-ink-tertiary">{rowCount(order.length)}</span>}
        </label>
      </div>}
      <div className="relative flex min-h-0 flex-1 flex-col" dir={direction}>
        <div ref={setScrollerEl} data-table-viewer="" data-fit={fit || undefined} data-scrolled={view.scrolled || undefined} tabIndex={0} role="region" aria-label={name}
          className="table-viewer min-h-0 flex-1 overflow-auto overscroll-contain pb-[max(var(--m-safe-bottom),16px)] focus-visible:outline-none">
          <table className={cn("border-separate border-spacing-0 text-[15px] leading-[1.45]", fit ? "w-full table-auto" : "w-max min-w-full")}>
            <thead><tr>{columns.map((column, index) => {
              const sorted = sort?.column === index;
              const align = alignment(column, index);
              return <th key={index} scope="col" aria-sort={sorted ? sort.descending ? "descending" : "ascending" : "none"} className="px-0 align-bottom" style={{ textAlign: align }}>
                <button type="button" onClick={() => sortBy(index)} style={fit ? { minWidth: minimums[index]! + CELL_PADDING_PX } : undefined}
                  className={cn("block w-full px-3.5 py-2.5 text-[13px] leading-[1.35] font-medium text-balance [text-align:inherit] in-[th:first-child]:ps-4 in-[th:last-child]:pe-4", sorted ? "text-ink" : "text-ink-secondary", !fit && "inline-block w-auto max-w-[16rem] align-bottom")}>
                  <span dir="auto" className="break-words [overflow-wrap:anywhere]">{column.content ?? (column.text || t("table.column", { number: index + 1 }))}</span>
                  <span aria-hidden className={cn(!sorted && "opacity-35")}>{SORT_MARK[sorted ? sort.descending ? "descending" : "ascending" : "none"]}</span>
                </button>
              </th>;
            })}</tr></thead>
            <tbody data-selectable="">{order.map((rowIndex) => <tr key={rowIndex}>{columns.map((column, index) => {
              const cell = rows[rowIndex]![index];
              return <td key={index} className="border-t border-(--table-line) px-3.5 py-3 align-top tabular-nums first:ps-4 last:pe-4" style={{ textAlign: cell?.align ?? alignment(column, index) }}>
                <div dir="auto" className={cn("whitespace-pre-wrap break-words [overflow-wrap:anywhere] [&_code]:[overflow-wrap:anywhere]", !fit && "inline-block max-w-[16rem] align-top")}>{cell?.content ?? cell?.text}</div>
              </td>;
            })}</tr>)}</tbody>
          </table>
          {order.length === 0 && <p className="px-6 py-10 text-center text-[15px] text-ink-secondary">{t(rows.length ? "table.noResults" : "table.empty")}</p>}
        </div>
        <div aria-hidden="true" data-table-more={view.more || undefined}
          className={cn("table-viewer-edge pointer-events-none absolute inset-y-0 end-0 w-12", view.more ? "opacity-100" : "opacity-0")} />
        {view.more && !view.moved && <div role="note" className={cn(nativeHint ? "sr-only" : "table-viewer-hint pointer-events-none absolute inset-x-0 bottom-[calc(var(--m-safe-bottom)+20px)] flex justify-center")}>
          <span className="flex h-9 items-center gap-1 rounded-full bg-ink px-4 text-[14px] font-medium text-app shadow-[0_4px_16px_rgb(0_0_0/0.16)]">
            {hintText}<ChevronRight size={16} className="rtl:-scale-x-100" aria-hidden="true" />
          </span>
        </div>}
      </div>
      <ViewerNote show={copied !== "idle"} text={copied === "failed" ? t("table.copyFailed") : t("mobile.viewer.copied")} failed={copied === "failed"} />
    </Sheet>
  );
}
