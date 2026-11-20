import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Copy } from "../../icons";
import { cn } from "@/lib/cn";
import type { TableCell, TableColumn } from "@/components/RichTable";
import { useCopyFeedback } from "@/lib/copy-text";
import { tableCsv } from "@/lib/table-data";
import { t } from "@/lib/i18n";
import { RoundButton } from "../RoundButton";
import { Sheet } from "../Sheet";
import { ViewerNote } from "./ViewerNote";

/** A reply's table full screen: it scrolls both ways under a header row and a first column that stay put. */
export function TableViewer({ columns, rows, name, open, onClose }: { columns: TableColumn[]; rows: TableCell[][]; name: string; open: boolean; onClose: () => void }) {
  const { state: copied, copy } = useCopyFeedback(tableCsv(columns.map((column) => column.text), rows.map((row) => row.map((cell) => cell.text))));
  const scroller = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState<{ right: boolean; moved: boolean }>({ right: false, moved: false });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const read = () => setMore((was) => {
      const right = Math.abs(el.scrollLeft) + el.clientWidth < el.scrollWidth - 1;
      const moved = was.moved || Math.abs(el.scrollLeft) > 4;
      return was.right === right && was.moved === moved ? was : { right, moved };
    });
    read();
    el.addEventListener("scroll", read, { passive: true });
    const resized = typeof ResizeObserver === "function" ? new ResizeObserver(read) : null;
    resized?.observe(el);
    return () => { el.removeEventListener("scroll", read); resized?.disconnect(); };
  }, []);
  return (
    <Sheet open={open} onClose={onClose} full label={name}
      title={<span className="flex items-baseline gap-2">{name}<span className="text-[13px] font-normal text-ink-tertiary tabular-nums">{t(rows.length === 1 ? "mobile.table.rows.one" : "mobile.table.rows", { count: rows.length })}</span></span>}
      trailing={<RoundButton label={copied === "copied" ? t("table.copied") : t("table.copyPlain")} onClick={copy}>
        {copied === "copied" ? <Check size={18} className="text-success" /> : <Copy size={18} />}
      </RoundButton>}
      bodyClassName="!overflow-hidden flex flex-col !pb-0">
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} data-table-viewer="" tabIndex={0} role="region" aria-label={name} className="table-viewer min-h-0 flex-1 overflow-auto overscroll-contain pb-[max(var(--m-safe-bottom),16px)] focus-visible:outline-none">
        <table data-selectable="" className="min-w-full border-separate border-spacing-0 text-[15px] leading-[1.45]">
          <thead><tr>{columns.map((column, index) => <th key={index} scope="col" className="whitespace-nowrap px-4 py-2.5 text-start font-semibold" style={{ textAlign: column.align as "left" | undefined }}>{column.content ?? column.text}</th>)}</tr></thead>
          <tbody>{rows.map((row, r) => <tr key={r}>{columns.map((column, c) => {
            const cell = row[c];
            return <td key={c} className="px-4 py-2.5 align-top tabular-nums" style={{ textAlign: (cell?.align ?? column.align) as "left" | undefined }}>
              <div dir="auto" className="w-max max-w-[16rem] whitespace-pre-wrap break-words">{cell?.content ?? cell?.text}</div>
            </td>;
          })}</tr>)}</tbody>
        </table>
      </div>
      <div aria-hidden="true" data-table-more={more.right || undefined}
        className={cn("table-viewer-edge pointer-events-none absolute inset-y-0 end-0 w-12", more.right ? "opacity-100" : "opacity-0")} />
      {more.right && !more.moved && <div role="note" className="table-viewer-hint pointer-events-none absolute inset-x-0 bottom-[calc(var(--m-safe-bottom)+20px)] flex justify-center">
        <span className="flex h-9 items-center gap-1 rounded-full bg-ink px-4 text-[14px] font-medium text-app shadow-[0_4px_16px_rgb(0_0_0/0.16)]">
          {t("mobile.table.moreColumns", { count: columns.length })}<ChevronRight size={16} aria-hidden="true" />
        </span>
      </div>}
      </div>
      <ViewerNote show={copied !== "idle"} text={copied === "failed" ? t("table.copyFailed") : t("mobile.viewer.copied")} failed={copied === "failed"} />
    </Sheet>
  );
}
