// Documents a bot makes with create_document: Markdown, sheets (CSV text, first row the headers) and simple web pages,
// kept per bot with their last versions, shown in chat as a file card and in the bot's panel under Files.
import Papa from "papaparse";

export const DOCUMENT_KINDS = ["markdown", "sheet", "html"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export type DocumentAuthor = "bot" | "person";

export const DOCUMENT_TITLE_MAX = 120;
export const DOCUMENT_MAX_BYTES = 512 * 1024;
export const DOCUMENT_VERSIONS_KEPT = 10;
export const DOCUMENTS_PER_BOT = 500;
export const DOCUMENT_ID = /^d_[0-9a-f]{12}$/;

const CARD_LINES = 4;
const CARD_ROWS = 4;
const CARD_COLUMNS = 4;
const CARD_LINE_MAX = 160;
const CARD_CELL_MAX = 40;

/** A document as listed: everything but its text. */
export interface DocumentMeta {
  id: string;
  botId: string;
  title: string;
  kind: DocumentKind;
  bytes: number;
  /** sheets: data rows, the header row not counted, and columns. */
  rows?: number;
  columns?: number;
  createdAt: number;
  updatedAt: number;
  version: number;
  by: DocumentAuthor;
  /** The person's manual for a bot or workflow: bots read it and never change it; only the person edits it. */
  manual?: true;
}

export interface DocumentVersionMeta {
  version: number;
  at: number;
  by: DocumentAuthor;
  bytes: number;
}

/** GET /api/bots/:botId/documents/:id: the document, its text, and the earlier versions that can be brought back. */
export interface DocumentWithContent extends DocumentMeta {
  content: string;
  versions: DocumentVersionMeta[];
}

/** WireMessage.document: the chat card of a document a bot made or changed, as it was then. Open reads the document as
 * it is now; `text` on the message names it in words for clients that do not draw the card. */
export interface ChatDocumentCard {
  botId: string;
  id: string;
  title: string;
  kind: DocumentKind;
  bytes: number;
  rows?: number;
  columns?: number;
  /** markdown: its first lines, as plain text. */
  lines?: string[];
  /** sheets: the header and the first rows, first columns only. */
  grid?: string[][];
  updatedAt: number;
  version: number;
  change: "created" | "updated";
}

export function isDocumentKind(value: unknown): value is DocumentKind {
  return typeof value === "string" && (DOCUMENT_KINDS as readonly string[]).includes(value);
}

/** Every row as long as the widest, so a sheet is always a grid; never throws on loose CSV. */
export function parseSheet(csv: string): string[][] {
  const text = csv.replace(/^﻿/, "");
  if (!text.trim()) return [[""]];
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy", delimiter: text.includes("\t") && !text.includes(",") ? "\t" : "," });
  const rows = parsed.data.filter((row) => Array.isArray(row));
  const width = Math.max(1, ...rows.map((row) => row.length));
  return rows.length ? rows.map((row) => Array.from({ length: width }, (_, index) => String(row[index] ?? ""))) : [[""]];
}

/** A cell a spreadsheet would read as a formula; a plain number such as -12.50 is a number. */
const FORMULA = /^(?![+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$)[=+\-@\t\r]/i;

/** The sheet as stored: plain CSV, no formula escaping, so the text round-trips exactly. */
export function sheetCsv(grid: readonly (readonly string[])[]): string {
  return Papa.unparse(grid.map((row) => [...row]), { newline: "\n" });
}

/** The sheet as a file to open in a spreadsheet app: a cell that would run as a formula is quoted as text. */
export function sheetExportCsv(grid: readonly (readonly string[])[]): string {
  return Papa.unparse(grid.map((row) => [...row]), { newline: "\r\n", escapeFormulae: FORMULA });
}

export function documentBytes(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

export function documentShape(kind: DocumentKind, content: string): Pick<DocumentMeta, "bytes" | "rows" | "columns"> {
  const bytes = documentBytes(content);
  if (kind !== "sheet") return { bytes };
  const grid = parseSheet(content);
  return { bytes, rows: Math.max(0, grid.length - 1), columns: grid[0]?.length ?? 0 };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The first lines of a Markdown text as a reader sees them: no heading marks, list bullets, quotes or emphasis. */
export function markdownLines(content: string, count = CARD_LINES): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const raw of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const line = raw
      .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|\*|_|`)/g, "")
      .trim();
    if (!line || /^[-|:\s]+$/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) continue;
    lines.push(clip(line, CARD_LINE_MAX));
    if (lines.length >= count) break;
  }
  return lines;
}

export function documentCard(meta: DocumentMeta, content: string, change: ChatDocumentCard["change"]): ChatDocumentCard {
  const base: ChatDocumentCard = {
    botId: meta.botId, id: meta.id, title: meta.title, kind: meta.kind, bytes: meta.bytes,
    ...(meta.rows === undefined ? {} : { rows: meta.rows }),
    ...(meta.columns === undefined ? {} : { columns: meta.columns }),
    updatedAt: meta.updatedAt, version: meta.version, change,
  };
  if (meta.kind === "markdown") {
    const lines = markdownLines(content, CARD_LINES + 1);
    const untitled = lines[0]?.toLowerCase() === meta.title.toLowerCase() ? lines.slice(1) : lines;
    return { ...base, lines: untitled.slice(0, CARD_LINES) };
  }
  if (meta.kind === "sheet") {
    return { ...base, grid: parseSheet(content).slice(0, CARD_ROWS).map((row) => row.slice(0, CARD_COLUMNS).map((cell) => clip(cell, CARD_CELL_MAX))) };
  }
  return base;
}

const EXTENSION: Record<DocumentKind, string> = { markdown: "md", sheet: "csv", html: "html" };

/** A file name safe on Windows and macOS, from the title. */
export function documentFileName(title: string, kind: DocumentKind): string {
  const printable = Array.from(title, (char) => (char.charCodeAt(0) < 32 ? "_" : char)).join("");
  const stem = printable.replace(/[\\/:*?"<>|]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 150) || "document";
  return `${stem}.${EXTENSION[kind]}`;
}
