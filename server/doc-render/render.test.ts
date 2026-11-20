import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { exportFileName, renderDocument } from "./index.ts";

const REPORT = "# Weekly report\n\nRevenue grew **12%** week over week.\n\n- Gross: $3,735\n- Refunds: $249 – one duplicate charge\n\n| Campaign | Spend | ROAS |\n| --- | --- | --- |\n| Prospecting | 1,840 | 2.87 |\n| Retargeting | 420 | 5.84 |\n";

/** The entries of a ZIP: name and inflated text. */
function unzip(bytes: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  for (let at = 0; bytes.readUInt32LE(at) === 0x04034b50;) {
    const size = bytes.readUInt32LE(at + 18), nameLength = bytes.readUInt16LE(at + 26), extra = bytes.readUInt16LE(at + 28);
    const name = bytes.subarray(at + 30, at + 30 + nameLength).toString("utf8");
    const start = at + 30 + nameLength + extra;
    out.set(name, inflateRawSync(bytes.subarray(start, start + size)).toString("utf8"));
    at = start + size;
  }
  return out;
}

describe("a document as a file", () => {
  it("makes a PDF any reader opens, with the text, list and table on it", async () => {
    const made = renderDocument({ title: "Weekly report", kind: "markdown", content: REPORT }, "pdf");
    if ("error" in made) throw new Error(made.error);
    expect(made.bytes.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(made.bytes), useSystemFonts: false }).promise;
    const page = await doc.getPage(1);
    const text = (await page.getTextContent()).items.map((item) => ("str" in item ? item.str : "")).join(" ");
    expect(text).toContain("Weekly report");
    expect(text).toContain("Revenue grew 12% week over week.");
    expect(text).toContain("Refunds: $249 – one duplicate charge");
    expect(text).toContain("Retargeting");
    expect(text).toContain("page 1 of 1");
  });

  it("breaks a long document over pages", async () => {
    const long = Array.from({ length: 200 }, (_, i) => `Line ${i} of a long receipt list.`).join("\n\n");
    const made = renderDocument({ title: "Receipts", kind: "markdown", content: long }, "pdf");
    if ("error" in made) throw new Error(made.error);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    expect((await pdfjs.getDocument({ data: new Uint8Array(made.bytes) }).promise).numPages).toBeGreaterThan(3);
  });

  it("makes a spreadsheet of a sheet or a document's table, numbers as numbers and nothing as a formula", () => {
    const made = renderDocument({ title: "Expenses", kind: "sheet", content: "date,vendor,amount\n2026-11-17,AWS,312.88\n2026-11-18,=HYPERLINK(1),\"1,200\"" }, "xlsx");
    if ("error" in made) throw new Error(made.error);
    const sheet = unzip(made.bytes).get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain('<c r="C2"><v>312.88</v></c>');
    expect(sheet).toContain('<c r="C3"><v>1200</v></c>');
    expect(sheet).toContain('t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(1)</t>');
    expect(sheet).not.toContain("<f>");
    const fromReport = renderDocument({ title: "Weekly report", kind: "markdown", content: REPORT }, "xlsx");
    if ("error" in fromReport) throw new Error(fromReport.error);
    expect(unzip(fromReport.bytes).get("xl/worksheets/sheet1.xml")).toContain("Prospecting");
    expect(renderDocument({ title: "Notes", kind: "markdown", content: "just words" }, "xlsx")).toMatchObject({ error: expect.stringContaining("no table") });
  });

  it("makes a Word file with the headings, items and table", () => {
    const made = renderDocument({ title: "Weekly report", kind: "markdown", content: REPORT }, "docx");
    if ("error" in made) throw new Error(made.error);
    const body = unzip(made.bytes).get("word/document.xml")!;
    expect(body).toContain("Weekly report");
    expect(body).toContain("•\tGross: $3,735");
    expect(body).toContain("<w:tbl>");
    expect(exportFileName("Q4 report: Stripe / Meta", "pdf")).toBe("Q4 report Stripe Meta.pdf");
  });
});
