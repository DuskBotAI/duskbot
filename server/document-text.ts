// A document's text without any helper model or account: PDFs through pdf.js (poppler's pdftotext when pdf.js cannot
// parse one), Office and OpenDocument files through their XML. Scanned PDFs have no text; poppler's pdftoppm, when the
// machine has it, turns their first pages into pictures for an engine that sees images.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { whichOnPath } from "./bot-box/detect.ts";
import { PDF_TEXT_LIMITS } from "./pdf-text-contract.ts";
import { pdfText, PdfTextError } from "./pdf-text.ts";
import { readZipDirectory, readZipMember, type ZipMember } from "./zip-archive.ts";

const run = promisify(execFile);

export const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp"]);
const MEMBER_MAX_BYTES = 32 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 5_000;
const SHEET_MAX_ROWS = 5_000;
/** pdf.js's own cap, so every format stops at the same size. */
export const DOCUMENT_TEXT_MAX_BYTES = PDF_TEXT_LIMITS.textBytes;

export class DocumentTextError extends Error {
  readonly scanned: boolean;
  constructor(message: string, scanned = false) {
    super(message);
    this.scanned = scanned;
  }
}

const SCANNED = "The PDF has no readable text. Pass page images for a scanned document.";
const UNREADABLE = "That file could not be read. Try a valid, unlocked copy.";

/** Poppler is on Homebrew's and the usual Linux paths even when an app's PATH leaves them out. */
function poppler(tool: "pdftotext" | "pdftoppm"): string | null {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].join(process.platform === "win32" ? ";" : ":");
  return whichOnPath(tool, { PATH: `${process.env.PATH ?? ""}${process.platform === "win32" ? ";" : ":"}${extra}` });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] !== "#") return ENTITIES[code] ?? whole;
    const point = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  });
}

const tidy = (text: string): string => text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** Word and PowerPoint: text runs, with paragraph, line break, tab and table-cell edges kept. */
function runsText(xml: string, prefix: "w" | "a"): string {
  const pattern = new RegExp(`<${prefix}:t(?:\\s[^>]*)?>([^<]*)</${prefix}:t>|<${prefix}:tab\\b[^>]*/>|<${prefix}:(?:br|cr)\\b[^>]*/>|</${prefix}:p>|</w:tc>`, "g");
  let out = "";
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) out += decodeXml(match[1]);
    else if (match[0].startsWith(`<${prefix}:tab`) || match[0] === "</w:tc>") out += "\t";
    else out += "\n";
  }
  return out;
}

function openDocumentText(xml: string): string {
  const body = xml.replace(/<text:s\b[^>]*\/>/g, " ").replace(/<text:tab\b[^>]*\/>/g, "\t").replace(/<text:line-break\b[^>]*\/>/g, "\n")
    .replace(/<\/table:table-cell>/g, "\t").replace(/<\/(?:text:p|text:h|table:table-row)>/g, "\n").replace(/<[^>]+>/g, "");
  return decodeXml(body);
}

function columnIndex(ref: string): number {
  let index = 0;
  for (const letter of ref.replace(/\d+$/, "").toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return Math.max(0, index - 1);
}

function sheetText(xml: string, shared: string[]): string {
  const rows: string[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= SHEET_MAX_ROWS) break;
    const cells: string[] = [];
    for (const cell of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1] ?? "", inner = cell[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attributes)?.[1];
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1];
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = "";
      if (type === "s" && raw !== undefined) value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") value = decodeXml([...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join(""));
      else if (type === "b" && raw !== undefined) value = raw === "1" ? "TRUE" : "FALSE";
      else if (raw !== undefined) value = decodeXml(raw);
      const at = ref ? columnIndex(ref) : cells.length;
      while (cells.length < at) cells.push("");
      cells[at] = value.replace(/[\t\n\r]+/g, " ");
    }
    if (cells.some(Boolean)) rows.push(cells.join("\t").replace(/\t+$/, ""));
  }
  return rows.join("\n");
}

const numbered = (pattern: RegExp) => (entries: ZipMember[]) => entries
  .map((entry) => ({ entry, n: Number(pattern.exec(entry.name)?.[1]) }))
  .filter((item) => Number.isFinite(item.n))
  .sort((a, b) => a.n - b.n)
  .map((item) => item.entry);

async function zipDocumentText(path: string, extension: string): Promise<string> {
  const entries = await readZipDirectory(path, ZIP_MAX_ENTRIES);
  const member = (name: string) => entries.find((entry) => entry.name === name);
  const read = async (entry: ZipMember | undefined) => entry ? (await readZipMember(path, entry, MEMBER_MAX_BYTES)).toString("utf8") : "";
  if (extension === ".docx") return runsText(await read(member("word/document.xml")), "w");
  if (extension === ".pptx") {
    const slides = numbered(/^ppt\/slides\/slide(\d+)\.xml$/)(entries);
    const parts: string[] = [];
    for (const [index, slide] of slides.entries()) parts.push(`Slide ${index + 1}\n${runsText(await read(slide), "a").trim()}`);
    return parts.join("\n\n");
  }
  if (extension === ".xlsx") {
    const shared = [...(await read(member("xl/sharedStrings.xml"))).matchAll(/<si>([\s\S]*?)<\/si>/g)]
      .map((item) => decodeXml([...item[1]!.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join("")));
    const names = [...(await read(member("xl/workbook.xml"))).matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decodeXml(m[1]!));
    const sheets = numbered(/^xl\/worksheets\/sheet(\d+)\.xml$/)(entries);
    const parts: string[] = [];
    for (const [index, sheet] of sheets.entries()) parts.push(`Sheet: ${names[index] ?? `Sheet${index + 1}`}\n${sheetText(await read(sheet), shared)}`);
    return parts.join("\n\n");
  }
  return openDocumentText(await read(member("content.xml")));
}

/** pdf.js and the ZIP reader take files by path; the bytes go to a private temporary folder for them. */
async function inTemporaryFile<T>(bytes: Buffer, extension: string, use: (path: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), "dusk-document-"));
  try {
    const path = join(folder, `document${extension}`);
    await writeFile(path, bytes, { mode: 0o600 });
    return await use(path);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function pdftotext(bytes: Buffer): Promise<string | null> {
  const tool = poppler("pdftotext");
  if (!tool) return null;
  try {
    return await inTemporaryFile(bytes, ".pdf", async (path) => {
      const { stdout } = await run(tool, ["-layout", "-enc", "UTF-8", "-q", path, "-"], { timeout: PDF_TEXT_LIMITS.timeoutMs, maxBuffer: DOCUMENT_TEXT_MAX_BYTES * 4 });
      return stdout.trim() ? stdout : null;
    });
  } catch {
    return null;
  }
}

/** A document's text from its bytes and extension, or a DocumentTextError in words a bot can pass on; `scanned` marks a
 * PDF with no text layer. */
export async function documentText(bytes: Buffer, extension: string, signal?: AbortSignal): Promise<string> {
  if (!DOCUMENT_EXTENSIONS.has(extension)) throw new DocumentTextError("That is not a PDF, Word, Excel, PowerPoint or OpenDocument file.");
  if (bytes.length > PDF_TEXT_LIMITS.fileBytes) throw new DocumentTextError("The file is over 25 MB. Split it into smaller files.");
  if (extension === ".pdf") {
    try {
      return await pdfText(bytes, signal);
    } catch (error) {
      if (!(error instanceof PdfTextError)) throw error;
      if (error.message === SCANNED) throw new DocumentTextError(error.message, true);
      if (/password|cancelled|too much text|500 pages|25 MB/.test(error.message)) throw new DocumentTextError(error.message);
      const text = await pdftotext(bytes);
      if (text) return text;
      throw new DocumentTextError(error.message);
    }
  }
  let text: string;
  try {
    text = tidy(await inTemporaryFile(bytes, extension, (path) => zipDocumentText(path, extension)));
  } catch {
    throw new DocumentTextError(UNREADABLE);
  }
  if (!text) throw new DocumentTextError("The file has no readable text.");
  return text;
}

/** The first pages of a scanned PDF as PNGs in `folder` (made once, kept), or [] when poppler is not installed. */
export async function pdfPagePictures(path: string, folder: string, maxPages: number): Promise<string[]> {
  const pages = async () => (await readdir(folder).catch(() => [] as string[])).filter((name) => /^page-\d+\.png$/.test(name)).sort().map((name) => join(folder, name));
  const kept = await pages();
  if (kept.length) return kept.slice(0, maxPages);
  const tool = poppler("pdftoppm");
  if (!tool) return [];
  const partial = `${folder}.${process.pid}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true, mode: 0o700 });
  try {
    await run(tool, ["-png", "-r", "110", "-f", "1", "-l", String(maxPages), path, join(partial, "page")], { timeout: 30_000 });
    await rm(folder, { recursive: true, force: true });
    await rename(partial, folder);
  } catch {
    await rm(partial, { recursive: true, force: true });
    return [];
  }
  // pdftoppm pads page numbers to the document's page count, so names sort as numbers
  return (await pages()).slice(0, maxPages);
}
