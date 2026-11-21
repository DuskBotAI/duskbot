// A document's text as plain blocks every file format can lay out: headings, paragraphs, list items and tables.
import { parseSheet, type DocumentKind } from "../../shared/documents.ts";

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "item"; text: string; marker: string }
  | { type: "table"; rows: string[][] }
  | { type: "rule" };

const inline = (text: string) => text
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
  .replace(/(\*\*|__)(.+?)\1/g, "$2")
  .replace(/(^|\W)[*_](\S.*?\S|\S)[*_](?=\W|$)/g, "$1$2")
  .replace(/`([^`]+)`/g, "$1")
  .replace(/~~(.+?)~~/g, "$1")
  .trim();

const tableRow = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => inline(cell));
const isDivider = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function markdownBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) blocks.push({ type: "paragraph", text: inline(paragraph.join(" ")) }); paragraph = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*(```|~~~)/.test(lines[i]!); i++) code.push(lines[i]!);
      for (const row of code) blocks.push({ type: "paragraph", text: row });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flush(); blocks.push({ type: "heading", level: Math.min(3, heading[1]!.length) as 1 | 2 | 3, text: inline(heading[2]!.replace(/#+\s*$/, "")) }); continue; }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { flush(); blocks.push({ type: "rule" }); continue; }
    if (line.trim().startsWith("|") && i + 1 < lines.length && isDivider(lines[i + 1]!)) {
      flush();
      const rows = [tableRow(line)];
      for (i += 2; i < lines.length && lines[i]!.trim().startsWith("|"); i++) rows.push(tableRow(lines[i]!));
      i--;
      blocks.push({ type: "table", rows });
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) { flush(); blocks.push({ type: "item", marker: /\d/.test(item[1]!) ? item[1]! : "•", text: inline(item[2]!.replace(/^\[[ xX]\]\s*/, "")) }); continue; }
    paragraph.push(line.replace(/^\s*>\s?/, ""));
  }
  flush();
  return blocks;
}

function htmlText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => `\n\n${"#".repeat(Number(level))} ${text}\n\n`)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|\/p|\/div|\/tr|\/h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}

export function documentBlocks(kind: DocumentKind, title: string, content: string): Block[] {
  const body = kind === "sheet" ? [{ type: "table", rows: parseSheet(content) } as Block] : markdownBlocks(kind === "html" ? htmlText(content) : content);
  return body[0]?.type === "heading" && body[0].text === title ? body : [{ type: "heading", level: 1, text: title }, ...body];
}

/** The first table in a document, for a spreadsheet: a sheet's own rows, or a Markdown table. */
export function documentTable(kind: DocumentKind, content: string): string[][] | null {
  if (kind === "sheet") return parseSheet(content);
  const table = documentBlocks(kind, "", content).find((block) => block.type === "table");
  return table && table.type === "table" ? table.rows : null;
}
