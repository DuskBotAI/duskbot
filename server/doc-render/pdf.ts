// A PDF (ISO 32000-1) laid out from document blocks with the standard Helvetica fonts, which every reader has, so no
// font is embedded. Text outside Windows-1252 shows as "?": the standard fonts carry no other glyphs.
import { deflateSync } from "node:zlib";

import type { Block } from "./blocks.ts";

/** Helvetica advance widths for ASCII 32-126, in thousandths of the font size (Adobe Core14 AFM). */
const WIDTHS = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
/** Characters Windows-1252 places in 0x80-0x9f, which Latin-1 leaves to control codes. */
const CP1252: Record<string, number> = { "€": 128, "‚": 130, "„": 132, "…": 133, "‘": 145, "’": 146, "“": 147, "”": 148, "•": 149, "–": 150, "—": 151, "™": 153 };

const PAGE_W = 612, PAGE_H = 792, MARGIN = 54, WIDTH = PAGE_W - 2 * MARGIN;
const SIZES = { 1: 18, 2: 14, 3: 12 } as const;
const BODY = 10.5, CELL = 9;

function codes(text: string): number[] {
  return [...text.normalize("NFC")].map((char) => {
    const code = char.codePointAt(0)!;
    if (CP1252[char]) return CP1252[char]!;
    if (code === 9) return 32;
    return (code >= 32 && code < 127) || (code >= 160 && code <= 255) ? code : 63;
  });
}

const charWidth = (code: number, bold: boolean) => (code >= 32 && code <= 126 ? WIDTHS[code - 32]! : 556) * (bold ? 1.06 : 1);
const textWidth = (text: string, size: number, bold = false) => codes(text).reduce((sum, code) => sum + charWidth(code, bold), 0) * size / 1000;

function wrap(text: string, size: number, width: number, bold = false): string[] {
  const lines: string[] = [];
  for (const piece of text.split("\n")) {
    let line = "";
    for (const word of piece.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= width) { line = next; continue; }
      if (line) lines.push(line);
      line = word;
      while (textWidth(line, size, bold) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && textWidth(line.slice(0, cut), size, bold) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

const literal = (text: string) => `(${codes(text).map((code) => code === 40 || code === 41 || code === 92 ? `\\${String.fromCharCode(code)}` : code > 126 ? `\\${code.toString(8).padStart(3, "0")}` : String.fromCharCode(code)).join("")})`;

export function pdf(blocks: readonly Block[], title: string): Buffer {
  const pages: string[][] = [[]];
  let y = PAGE_H - MARGIN;
  const ops = () => pages.at(-1)!;
  const room = (height: number) => { if (y - height < MARGIN) { pages.push([]); y = PAGE_H - MARGIN; } };
  const text = (x: number, size: number, bold: boolean, line: string) => ops().push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td ${literal(line)} Tj ET`);
  const lines = (input: string[], x: number, size: number, bold: boolean) => {
    for (const line of input) { room(size * 1.35); y -= size * 1.35; text(x, size, bold, line); }
  };

  for (const block of blocks) {
    if (block.type === "heading") {
      const size = SIZES[block.level];
      y -= size * 0.6;
      lines(wrap(block.text, size, WIDTH, true), MARGIN, size, true);
      y -= size * 0.3;
    } else if (block.type === "paragraph") {
      lines(wrap(block.text, BODY, WIDTH), MARGIN, BODY, false);
      y -= BODY * 0.6;
    } else if (block.type === "item") {
      const marker = block.marker;
      const body = wrap(block.text, BODY, WIDTH - 16);
      room(BODY * 1.35);
      ops().push(`BT /F1 ${BODY} Tf ${MARGIN.toFixed(2)} ${(y - BODY * 1.35).toFixed(2)} Td ${literal(marker)} Tj ET`);
      lines(body, MARGIN + 16, BODY, false);
      y -= BODY * 0.2;
    } else if (block.type === "rule") {
      room(12); y -= 6; ops().push(`0.75 G 0.5 w ${MARGIN} ${y.toFixed(2)} m ${PAGE_W - MARGIN} ${y.toFixed(2)} l S 0 G`); y -= 6;
    } else {
      const columns = Math.max(1, ...block.rows.map((row) => row.length));
      const colW = WIDTH / columns;
      for (const [index, row] of block.rows.entries()) {
        const bold = index === 0;
        const cells = Array.from({ length: columns }, (_, c) => wrap(row[c] ?? "", CELL, colW - 6, bold));
        const height = Math.max(...cells.map((cell) => cell.length)) * CELL * 1.3 + 6;
        room(height);
        const top = y;
        if (bold) ops().push(`0.93 g ${MARGIN} ${(top - height).toFixed(2)} ${WIDTH} ${height.toFixed(2)} re f 0 g`);
        cells.forEach((cell, c) => {
          y = top - 3;
          for (const line of cell) { y -= CELL * 1.3; text(MARGIN + c * colW + 3, CELL, bold, line); }
        });
        ops().push(`0.8 G 0.4 w ${MARGIN} ${(top - height).toFixed(2)} m ${PAGE_W - MARGIN} ${(top - height).toFixed(2)} l S 0 G`);
        y = top - height;
      }
      y -= BODY;
    }
  }

  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const catalog = add(""), pagesId = add("");
  const regular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const streams: Buffer[] = [];
  const kids: number[] = [];
  pages.forEach((page, index) => {
    const footer = `BT /F1 8 Tf ${MARGIN} 30 Td ${literal(`${title} · page ${index + 1} of ${pages.length}`)} Tj ET`;
    const packed = deflateSync(Buffer.from([...page, footer].join("\n"), "latin1"));
    streams.push(packed);
    const content = add(`STREAM:${streams.length - 1}`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`));
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const info = add(`<< /Title ${literal(title)} /Producer (dusk bot) >>`);

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let offset = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const stream = /^STREAM:(\d+)$/.exec(body);
    const chunk = stream
      ? Buffer.concat([Buffer.from(`${index + 1} 0 obj\n<< /Length ${streams[Number(stream[1])]!.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), streams[Number(stream[1])]!, Buffer.from("\nendstream\nendobj\n", "latin1")])
      : Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    parts.push(chunk);
    offset += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}
