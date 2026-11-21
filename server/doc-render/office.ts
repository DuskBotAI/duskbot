// Excel (.xlsx) and Word (.docx) files written from scratch: the smallest set of Office Open XML parts (ECMA-376) that
// Excel, Numbers, Google Sheets, Word, Pages and LibreOffice open.
import type { Block } from "./blocks.ts";
import { zip } from "./zip.ts";

const xml = (text: string) => text
  // oxlint-disable-next-line no-control-regex -- XML 1.0 forbids these characters
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const NUMBER = /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;

function column(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** A cell that is a plain number (commas between thousands allowed) is stored as one; everything else as text. A
 * leading = is text too, so nothing in a document becomes a formula. */
export function xlsx(rows: readonly (readonly string[])[], sheetName = "Sheet1"): Buffer {
  const data = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => {
    const ref = `${column(c)}${r + 1}`;
    const trimmed = value.trim();
    if (r > 0 && NUMBER.test(trimmed)) return `<c r="${ref}"><v>${trimmed.replace(/,/g, "")}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${r === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  }).join("")}</row>`).join("");
  const name = xml(sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet1");
  return zip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>` },
    { name: "xl/worksheets/sheet1.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${data}</sheetData></worksheet>` },
  ]);
}

const run = (text: string, size?: number, bold = false) => `<w:r>${bold || size ? `<w:rPr>${bold ? "<w:b/>" : ""}${size ? `<w:sz w:val="${size}"/>` : ""}</w:rPr>` : ""}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
const para = (content: string, spacing = 120) => `<w:p><w:pPr><w:spacing w:after="${spacing}"/></w:pPr>${content}</w:p>`;
const HEADING_SIZE = { 1: 36, 2: 30, 3: 26 } as const;

export function docx(blocks: readonly Block[]): Buffer {
  const body = blocks.map((block) => {
    if (block.type === "heading") return para(run(block.text, HEADING_SIZE[block.level], true), 160);
    if (block.type === "paragraph") return para(run(block.text));
    if (block.type === "item") return `<w:p><w:pPr><w:ind w:left="360" w:hanging="360"/><w:spacing w:after="60"/></w:pPr>${run(`${block.marker}\t${block.text}`)}</w:p>`;
    if (block.type === "rule") return para("");
    const cells = (row: readonly string[], header: boolean) => row.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p>${run(cell, undefined, header)}</w:p></w:tc>`).join("");
    const border = `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>`).join("")}</w:tblBorders>`;
    return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${border}</w:tblPr>${block.rows.map((row, i) => `<w:tr>${cells(row, i === 0)}</w:tr>`).join("")}</w:tbl>${para("")}`;
  }).join("");
  return zip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/document.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>` },
  ]);
}
