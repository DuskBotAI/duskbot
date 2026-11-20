import type { DocumentKind } from "../../shared/documents.ts";
import { documentBlocks, documentTable } from "./blocks.ts";
import { docx, xlsx } from "./office.ts";
import { pdf } from "./pdf.ts";

export const EXPORT_FORMATS = ["pdf", "xlsx", "docx", "csv", "md"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const isExportFormat = (value: unknown): value is ExportFormat => (EXPORT_FORMATS as readonly unknown[]).includes(value);

/** A document as a file of the asked format, or why it cannot be one (a spreadsheet needs a table). */
export function renderDocument(doc: { title: string; kind: DocumentKind; content: string }, format: ExportFormat): { bytes: Buffer; extension: string } | { error: string } {
  if (format === "pdf") return { bytes: pdf(documentBlocks(doc.kind, doc.title, doc.content), doc.title), extension: "pdf" };
  if (format === "docx") return { bytes: docx(documentBlocks(doc.kind, doc.title, doc.content)), extension: "docx" };
  if (format === "md") return { bytes: Buffer.from(doc.content, "utf8"), extension: doc.kind === "sheet" ? "csv" : doc.kind === "html" ? "html" : "md" };
  const table = documentTable(doc.kind, doc.content);
  if (!table) return { error: `"${doc.title}" has no table to put in a ${format === "csv" ? "CSV file" : "spreadsheet"}: export it as pdf or docx, or make it a sheet.` };
  if (format === "csv") return { bytes: Buffer.from(table.map((row) => row.map((cell) => /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell).join(",")).join("\r\n"), "utf8"), extension: "csv" };
  return { bytes: xlsx(table, doc.title), extension: "xlsx" };
}

/** A file name from a document's title that every system accepts. */
export function exportFileName(title: string, extension: string): string {
  const base = title.normalize("NFKD").replace(/[^\w .-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "document";
  return `${base}.${extension}`;
}
