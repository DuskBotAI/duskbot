import Papa from "papaparse";

export const TABLE_FILE_MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 200;
const MAX_CELLS = 500_000;

export interface TextTable { headers: string[]; rows: string[][] }
export type TableSort = { column: number; descending: boolean } | null;

export function tableDelimiter(name: string): "," | "\t" | null {
  return /\.csv$/i.test(name) ? "," : /\.tsv$/i.test(name) ? "\t" : null;
}

/** Strings stay strings: leading zeroes and long IDs must never be coerced. */
export function parseTableFile(text: string, delimiter: "," | "\t"): TextTable {
  if (text.includes("\0")) throw new Error("format");
  const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), {
    delimiter, skipEmptyLines: true, preview: MAX_ROWS + 2,
  });
  if (parsed.errors.length) throw new Error("format");
  const [headers = [], ...rows] = parsed.data;
  const columns = Math.max(headers.length, ...rows.slice(0, 1).map((row) => row.length));
  if (rows.length > MAX_ROWS || parsed.meta.truncated || columns > MAX_COLUMNS) throw new Error("size");
  let cells = headers.length;
  for (const row of rows) {
    cells += row.length;
    if (cells > MAX_CELLS || row.length > MAX_COLUMNS) throw new Error("size");
    if (row.length !== headers.length) throw new Error("columns");
  }
  return { headers, rows };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
export function isTableNumber(text: string): boolean { return NUMBER.test(text.trim()); }

/** A table with more rows than this can be searched. */
export const SEARCHABLE_TABLE_ROWS = 8;

/** A figure as a reply writes one: grouped digits, a currency sign, a percent, a unit like "pt", a scale like "1M". */
const FIGURE = /^([+−-]?)[$€£¥]?(\d[\d,]*(?:\.\d+)?)\s?(%|pt|pp|x|×|k|m|bn)?$/i;
const SCALE: Record<string, number> = { k: 1e3, m: 1e6, bn: 1e9 };

function figure(text: string): number | null {
  const match = FIGURE.exec(text.trim());
  if (!match) return null;
  const value = Number(match[2]!.replace(/,/g, "")) * (SCALE[match[3]?.toLowerCase() ?? ""] ?? 1);
  return match[1] && match[1] !== "+" ? -value : value;
}

/** Which of a table's columns hold only figures, judged by its first 200 rows; those line up on the right. */
export function numericColumns(count: number, rows: readonly (readonly string[])[]): boolean[] {
  const sample = rows.slice(0, 200);
  return Array.from({ length: count }, (_, index) => {
    const filled = sample.map((row) => row[index]?.trim() ?? "").filter(Boolean);
    return filled.length > 0 && filled.every((text) => isTableNumber(text) || figure(text) !== null);
  });
}

/** Saves a table as a .csv named after it, with a byte order mark so Excel reads it as UTF-8. */
export function downloadTableCsv(name: string, csv: string): void {
  const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name.replace(/\.(csv|tsv)$/i, "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 150) || "table"}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function tableRowOrder(rows: readonly (readonly string[])[], query: string, sort: TableSort): number[] {
  const needle = query.trim().toLocaleLowerCase();
  const order = rows.flatMap((row, index) => !needle || row.some((cell) => cell.toLocaleLowerCase().includes(needle)) ? [index] : []);
  if (sort) order.sort((a, b) => {
    const left = rows[a]![sort.column] ?? "", right = rows[b]![sort.column] ?? "";
    if (!left.trim() || !right.trim()) return Number(!left.trim()) - Number(!right.trim()) || a - b;
    const numeric = isTableNumber(left) && isTableNumber(right);
    let difference: number;
    if (numeric && /^[+-]?\d+$/.test(left.trim()) && /^[+-]?\d+$/.test(right.trim())) {
      const l = BigInt(left.trim()), r = BigInt(right.trim());
      difference = l < r ? -1 : l > r ? 1 : 0;
    } else if (numeric) difference = Number(left) - Number(right);
    else {
      const l = figure(left), r = figure(right);
      difference = l !== null && r !== null ? l - r : collator.compare(left, right);
    }
    return (Number.isFinite(difference) ? difference : collator.compare(left, right)) * (sort.descending ? -1 : 1) || a - b;
  });
  return order;
}

/** A cell a spreadsheet would read as a formula; a plain number such as -12.50 is a number, not a formula. */
const FORMULA = /^(?![+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$)[=+\-@\t\r]/i;

export function tableCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return Papa.unparse([headers, ...rows], { newline: "\r\n", escapeFormulae: FORMULA });
}
