import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { SidebarPopoverMenu } from "./SidebarPopoverMenu";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Check, Copy, Download, Maximize2, Search, WrapText, X } from "../icons";
import { isTableNumber, tableCsv, tableRowOrder, type TableSort } from "@/lib/table-data";
import { t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";
import { columnMinimums, fitsColumns } from "@/lib/table-fit";
import { cn } from "@/lib/cn";
import { phoneBridge } from "@/lib/phone-bridge";

export interface TableCell { text: string; content?: ReactNode; align?: TableAlign; vAlign?: "top" | "middle" | "bottom" }
export type TableAlign = "left" | "center" | "right" | "start" | "end";
export interface TableColumn extends TableCell { width?: number }
export interface RichTableProps {
  columns: TableColumn[];
  rows: TableCell[][];
  name?: string;
  expanded?: boolean;
  direction?: "rtl" | "ltr";
  headless?: boolean;
  /** A reply's table draws as a card; a table inside a card of its own (a widget) opts out. */
  card?: boolean;
}

/** The native modal supplies focus containment, Escape, an inert background and focus restoration. */
export function TableDialog(props: { title: string; onClose: () => void; children: ReactNode; returnFocus: HTMLElement | null }) {
  const phone = phoneBridge();
  const opened = useRef(false);
  useEffect(() => {
    if (!phone || opened.current) return;
    opened.current = true;
    phone.view({ kind: "page", title: props.title, body: <div className="px-3">{props.children}</div> }, props.onClose);
  }, []);
  return phone ? null : <ModalTableDialog {...props} />;
}

function ModalTableDialog({ title, onClose, children, returnFocus }: { title: string; onClose: () => void; children: ReactNode; returnFocus: HTMLElement | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); if (returnFocus?.isConnected) returnFocus.focus(); };
  }, [returnFocus]);
  return createPortal(
    <dialog ref={ref} aria-labelledby={id} onCancel={onClose} onClose={onClose}
      onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
      className="m-auto flex max-h-[94dvh] w-[min(96vw,1400px)] max-w-none flex-col overflow-hidden rounded-2xl border border-transparent bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/55">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-transparent px-4 py-3">
        <h2 id={id} className="min-w-0 truncate text-sm font-medium">{title}</h2>
        <button type="button" autoFocus onClick={onClose} className="table-action" aria-label={t("table.close")}><X size={16} /></button>
      </header>
      <div className="min-h-0 overflow-auto p-3 sm:p-5">{children}</div>
    </dialog>, document.body,
  );
}

const SMALL_TABLE_ROWS = 8;

/** The table card: the composer surface with a hairline edge and no footer. Its header row starts at the
 * top; the hover plate floats over the header's right end and takes no room. Only touch screens, where the plate is
 * always shown and its buttons keep 40px targets, give it a band of its own. */
/** A figure grok lines up on the right too: grouped digits, a currency sign, a percent, a unit like "pt". */
const READS_AS_NUMBER = /^[+\u2212-]?[$€£¥]?\d[\d,]*(?:\.\d+)?\s?(?:%|pt|pp|x|×|k|m|bn)?$/i;

/** Grok's card corner key: 24px white, a hairline and a small drop, as on its code blocks. */
const TABLE_PLATE_BUTTON = "composer-press inline-flex h-6 touch:h-10 items-center justify-center border border-transparent bg-composer text-ink/[0.66] hover:bg-[linear-gradient(rgb(28_28_28/0.06),rgb(28_28_28/0.06))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";
/** The table card: the chat card's tone, rounded 20, the header row from the top (the plate floats over its right end on
 * hover; touch keeps a band for the always-shown plate), and 6px under the last row so its corners clip cleanly. */
const TABLE_CARD = "group/table relative w-full overflow-hidden rounded-[20px] bg-(--chat-card) pb-1.5 pt-1 text-ink shadow-[0_2px_8px_var(--card-lift)] touch:pt-11";

export function RichTable({ columns, rows, name = t("table.title"), expanded = false, direction = "ltr", headless = false, card: asCard = true }: RichTableProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sort, setSort] = useState<TableSort>(null);
  const [wrap, setWrap] = useState(true);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const values = useMemo(() => rows.map((row) => row.map((cell) => cell.text)), [rows]);
  const order = useMemo(() => tableRowOrder(values, deferredQuery, sort), [values, deferredQuery, sort]);
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copyState]);
  const csv = () => tableCsv(columns.map((column) => column.text), order.map((index) => values[index]!));
  const copy = async () => {
    const result = await copyText(csv());
    if (result !== "empty") setCopyState(result);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv()], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name.replace(/\.(csv|tsv)$/i, "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 150) || "table"}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const status = copyState !== "idle" && <span role={copyState === "failed" ? "alert" : "status"} className="sr-only">{t(copyState === "failed" ? "table.copyFailed" : "table.copied")}</span>;
  const search = (className: string) => (
    <label className={className}>
      <Search size={13} aria-hidden="true" />
      <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("table.search")}
        placeholder={t("table.search")} className="w-full min-w-0 bg-transparent py-1 text-xs text-ink outline-none placeholder:text-ink-tertiary focus-visible:ring-1 focus-visible:ring-focus" />
    </label>
  );
  const phone = phoneBridge();
  const expand = (opener: HTMLElement | null) => {
    if (phone) return phone.view({ kind: "table", columns, rows, name });
    trigger.current = opener as HTMLButtonElement | null;
    setOpen(true);
  };
  const sortBy = (column: number) => setSort(sort?.column !== column ? { column, descending: false } : !sort.descending ? { column, descending: true } : null);
  const card = () => (
    <div data-table-card className={TABLE_CARD} dir="ltr">
      <div className="table-plate absolute end-1.5 top-1.5 z-20 flex items-center opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/table:opacity-100 has-[[aria-expanded=true]]:opacity-100 touch:end-1 touch:top-1 touch:opacity-100">
        {phone && <button type="button" data-table-expand="" className={cn(TABLE_PLATE_BUTTON, "me-1 w-10 rounded-[6px]")} aria-label={t("table.expand")} onClick={() => expand(null)}><Maximize2 size={14} /></button>}
        <button type="button" className={cn(TABLE_PLATE_BUTTON, "w-6 rounded-s-[6px] touch:w-10")} aria-label={t("table.copyPlain")} onClick={() => void copy()}>{copyState === "copied" ? <Check size={14} /> : <Icon name="copy" size={14} />}</button>
        <SidebarPopoverMenu grok items={[
          { key: "download", label: t("table.download"), icon: <Download size={14} aria-hidden="true" />, onSelect: download },
          { key: "expand", label: t("table.expand"), icon: <Maximize2 size={14} aria-hidden="true" />, onSelect: () => expand(document.activeElement as HTMLElement | null) },
        ]} ariaLabel={t("table.copyOptions")} placement="below" align="end" triggerClassName={cn(TABLE_PLATE_BUTTON, "-ms-px w-4 rounded-e-[6px] touch:w-8")} triggerLabel={t("table.copyOptions")}
          renderTrigger={() => <Icon name="chevron-down" size={12} />} />
      </div>
      {rows.length > SMALL_TABLE_ROWS && (
        <div className="flex items-center gap-2 px-4 pb-1.5 text-ink-tertiary">
          {search("flex min-w-24 flex-1 items-center gap-2")}
          <span role="status" className="shrink-0 text-[12px] tabular-nums">{t("table.count", { shown: order.length.toLocaleString(), total: rows.length.toLocaleString(), columns: columns.length })}</span>
        </div>
      )}
      <div className="contents" onClick={phone ? (event) => { if (!(event.target as Element).closest("button, a, input")) expand(null); } : undefined}>
        <TableViewport columns={columns} rows={rows} order={order} name={name} wrap={wrap} large={false} sort={sort} direction={direction} headless={headless} look="card" onSort={sortBy} />
      </div>
      {status}
    </div>
  );
  const surface = (large: boolean) => {
    if (asCard && !large) return card();
    const small = !large && rows.length <= SMALL_TABLE_ROWS;
    const actions = <>
        {!small && <button type="button" className="table-action" aria-label={t("table.wrap")} title={t("table.wrap")} aria-pressed={wrap} onClick={() => setWrap(!wrap)}><WrapText size={14} /></button>}
        <button type="button" className="table-action" aria-label={t("table.copy")} title={t("table.copy")} onClick={() => void copy()}>{copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}</button>
        <button type="button" className="table-action" aria-label={t("table.download")} title={t("table.download")} onClick={download}><Download size={14} /></button>
        {!large && <button type="button" className="table-action" aria-label={t("table.expand")} title={t("table.expand")} onClick={(event) => { trigger.current = event.currentTarget; setOpen(true); }}><Maximize2 size={14} /></button>}
    </>;
    return (
    <div className="rich-table w-fit min-w-[min(100%,var(--chat-prose-max))] max-w-full overflow-hidden rounded-xl border border-transparent bg-composer text-ink" dir="ltr">
      {!small && <div className="flex flex-wrap items-center gap-1 border-b border-transparent px-2 py-1.5">
        {search("flex min-w-24 flex-1 items-center gap-2 px-1 text-ink-secondary")}
        {actions}
      </div>}
      <TableViewport columns={columns} rows={rows} order={order} name={name} wrap={wrap} large={large} sort={sort} direction={direction} headless={headless}
        look="quiet" onSort={sortBy} />
      <footer className={small
        ? "flex items-center justify-end gap-0.5 border-t border-transparent px-1.5 py-1 text-[11px] text-ink-tertiary"
        : "flex flex-wrap items-center justify-between gap-2 border-t border-transparent px-3 py-2 text-[11px] text-ink-secondary"}>
        {!small && <span role="status">{t("table.count", { shown: order.length.toLocaleString(), total: rows.length.toLocaleString(), columns: columns.length })}</span>}
        {copyState !== "idle" && <span role={copyState === "failed" ? "alert" : "status"} className={small ? "me-auto ps-1.5" : undefined}>{t(copyState === "failed" ? "table.copyFailed" : "table.copied")}</span>}
        {small && actions}
      </footer>
    </div>
    );
  };
  return <><div hidden={open} className="chat-table">{surface(expanded)}</div>{open && <TableDialog title={name} returnFocus={trigger.current} onClose={() => setOpen(false)}>{surface(true)}</TableDialog>}</>;
}

/** "quiet" is the expanded table (no header fill, a faint zebra), "card" the table card in a reply: header names are
 * the sort buttons, rows are split by hairlines, and nothing else is drawn. */
type TableLook = "quiet" | "card";

function TableViewport({ columns, rows, order, name, wrap, large, sort, onSort, direction, headless = false, look = "quiet" }: RichTableProps & {
  order: number[]; wrap: boolean; large: boolean; sort: TableSort; onSort: (column: number) => void; look?: TableLook;
}) {
  const card = look === "card";
  const scroll = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLTableSectionElement>(null);
  const [headingHeight, setHeadingHeight] = useState(40);
  useEffect(() => {
    if (!heading.current) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setHeadingHeight(entry.target.getBoundingClientRect().height); });
    observer.observe(heading.current);
    return () => observer.disconnect();
  }, []);
  const virtual = order.length > 80;
  const minimums = useMemo(() => columnMinimums(columns.map((column) => column.text), rows.map((row) => row.map((cell) => cell.text))), [columns, rows]);
  // the width is read every resize but redraws only when it flips whether the columns fit: a side panel sliding open
  // resizes the chat every frame, and redrawing every table then cost a long frame at the slide's start
  const available = useRef<number | null>(null);
  const fitInput = useRef({ wrap, virtual, minimums });
  fitInput.current = { wrap, virtual, minimums };
  const [, redraw] = useState(0);
  useEffect(() => {
    const element = scroll.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const before = available.current;
      available.current = element.clientWidth || null;
      if (fitsColumns({ ...fitInput.current, available: before }) !== fitsColumns({ ...fitInput.current, available: available.current })) redraw((n) => n + 1);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fit = fitsColumns({ wrap, virtual, minimums, available: available.current });
  const widths = useMemo(() => columns.map((column, index) => column.width ?? Math.min(320, Math.max(140,
    Math.max(column.text.length, ...rows.slice(0, 100).map((row) => Math.min(40, row[index]?.text.length ?? 0))) * 7 + 40,
  ))), [columns, rows]);
  const numeric = useMemo(() => columns.map((_, index) => {
    const nonempty = rows.slice(0, 200).map((row) => row[index]?.text.trim() ?? "").filter(Boolean);
    return nonempty.length > 0 && nonempty.every((text) => isTableNumber(text) || READS_AS_NUMBER.test(text));
  }), [columns, rows]);
  const virtualizer = useVirtualizer({ count: order.length, getScrollElement: () => scroll.current, estimateSize: () => 42,
    getItemKey: (index) => order[index]!, overscan: 6, enabled: virtual, initialRect: { width: 800, height: 400 }, scrollMargin: headingHeight });
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [order]);
  useEffect(() => { virtualizer.measure(); }, [wrap, widths, virtualizer]);
  const items = virtual ? virtualizer.getVirtualItems() : order.map((id, index) => ({ key: id, index, start: 0, end: 0 }));
  const before = virtual && items.length ? Math.max(0, items[0]!.start - headingHeight) : 0;
  const after = virtual && items.length ? Math.max(0, virtualizer.getTotalSize() - items.at(-1)!.end + headingHeight) : 0;
  const alignment = (column: TableColumn, index: number) => column.align ?? (numeric[index] || direction === "rtl" ? "right" : "left");
  const sortLabel = (column: TableColumn, index: number) => t("table.sort", { column: column.text || index + 1 });
  const header = (column: TableColumn, index: number) => column.content ?? (column.text || t("table.column", { number: index + 1 }));
  const arrow = (index: number, className?: string) => sort?.column === index && sort.descending ? <ArrowDown size={12} className={className} /> : <ArrowUp size={12} className={cn(className, sort?.column !== index && !card && "opacity-35")} />;
  return <div ref={scroll} tabIndex={0} role="region" aria-label={name}
    className={cn("overflow-auto overscroll-x-contain focus-visible:outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-accent/60", card && !fit && "[mask-image:linear-gradient(90deg,#000_calc(100%-40px),transparent)]")}
    style={{ maxHeight: large ? "65dvh" : virtual || !wrap ? 400 : undefined }} data-fit={fit || undefined}>
    <table dir={direction} aria-label={name} aria-rowcount={order.length + 1} className={cn("w-full border-separate border-spacing-0 text-[14px]", fit ? "table-auto" : "table-fixed", card && "leading-5")} style={fit ? undefined : { minWidth: widths.reduce((a, b) => a + b, 0) }}>
      {!fit && <colgroup>{widths.map((width, index) => <col key={index} style={{ width }} />)}</colgroup>}
      <thead ref={heading} hidden={headless} className={cn("sticky top-0 z-10", card ? "bg-(--chat-card)" : "bg-composer")}><tr aria-rowindex={1}>
        {columns.map((column, index) => <th key={index} scope="col" aria-sort={sort?.column === index ? sort.descending ? "descending" : "ascending" : "none"}
          className={card ? "px-4 py-2.5 align-bottom font-semibold" : "h-10 border-b border-transparent px-3 py-2 font-medium"} style={{ textAlign: alignment(column, index) }}>
          <div className="break-words [overflow-wrap:anywhere]" style={fit ? { minWidth: minimums[index] } : undefined}>
            {card ? (
              // grok's table card names its columns and nothing more; sorting lives in the expanded table
              <span dir="auto">{header(column, index)}</span>
            ) : <>
              <span dir="auto">{header(column, index)}</span>
              <button type="button" className="table-action ms-1 inline-flex align-middle" aria-label={sortLabel(column, index)} title={sortLabel(column, index)} onClick={() => onSort(index)}>{arrow(index)}</button>
            </>}
          </div>
        </th>)}
      </tr></thead>
      <tbody>
        {before > 0 && <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: before, padding: 0 }} /></tr>}
        {items.map((item) => <tr key={item.key} data-index={item.index} ref={virtual ? virtualizer.measureElement : undefined} aria-rowindex={item.index + 2}
          className={card ? undefined : item.index % 2 ? "bg-ink/[0.03] hover:bg-raised/70" : "hover:bg-raised/70"}>
          {columns.map((column, index) => {
            const cell = rows[order[item.index]!]![index];
            return <td key={index} className={card ? "border-t border-transparent px-4 py-2.5 align-top tabular-nums" : "border-b border-transparent px-3 py-2.5 align-top tabular-nums"} style={{ textAlign: cell?.align ?? alignment(column, index), verticalAlign: cell?.vAlign }}>
              <div dir="auto" title={!wrap ? cell?.text : undefined} className={wrap ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere]" : "truncate"}>{cell?.content ?? cell?.text}</div>
            </td>;
          })}
        </tr>)}
        {after > 0 && <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: after, padding: 0 }} /></tr>}
      </tbody>
    </table>
    {order.length === 0 && <p className="p-8 text-center text-sm text-ink-secondary">{t(rows.length ? "table.noResults" : "table.empty")}</p>}
  </div>;
}
