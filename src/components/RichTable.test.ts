import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RichTable } from "./RichTable";
import { ChatMarkdown } from "./ChatMarkdown";
import { AttachedFileChip } from "./AttachmentPreview";
import { readTableResponse } from "./TableFilePreview";
import { TABLE_FILE_MAX_BYTES } from "@/lib/table-data";

describe("rich table rendering", () => {
  it("keeps Markdown links, emphasis, code, alignment and escaped HTML inside cells", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { text: '| Name | Amount |\n| :--- | ---: |\n| **Alpha** [docs](https://example.com) `code` | 12 |\n| <script>alert(1)</script> | 2 |' }));
    expect(html).toContain("<strong>Alpha</strong>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("code");
    expect(html).toContain("text-align:right");
    expect(html).not.toContain("<script>");
    expect(html).toContain('scope="col"');
  });
  it("lines up a column the way its Markdown delimiter row says, even when its cells are words", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { text: "| Plan | Price | SSO |\n| :--- | ---: | :---: |\n| Team | Custom | yes |" }));
    const cells = [...html.matchAll(/<td[^>]*style="text-align:(\w+)/g)].map((match) => match[1]);
    expect(cells).toEqual(["left", "right", "center"]);
  });
  it("gives a short table outside a card its actions without the search box and row count a long one needs", () => {
    const table = (length: number) => renderToStaticMarkup(createElement(RichTable, { columns: [{ text: "ID" }], rows: Array.from({ length }, (_, i) => [{ text: String(i) }]), card: false }));
    const short = table(8);
    expect(short).not.toContain('aria-label="Search all rows…"');
    expect(short).not.toContain("8 of 8 rows");
    expect(short).toContain('aria-label="Copy results as CSV"');
    const long = table(9);
    expect(long).toContain('aria-label="Search all rows…"');
    expect(long).toContain("9 of 9 rows");
  });
  it("bounds the DOM for a large table", () => {
    const html = renderToStaticMarkup(createElement(RichTable, { columns: [{ text: "ID" }], rows: Array.from({ length: 5000 }, (_, i) => [{ text: String(i) }]) }));
    expect(html).toContain('aria-rowcount="5001"');
    expect((html.match(/aria-rowindex=/g) ?? []).length).toBeLessThan(50);
  });
  it("offers file previews only for message-scoped attachments or authored links", () => {
    const file = { name: "report.csv", path: "/workspace/report.csv", private: true };
    const message = { threadId: "t", messageId: "m" };
    expect(renderToStaticMarkup(createElement(AttachedFileChip, { file, message }))).toContain("Preview table: report.csv");
    expect(renderToStaticMarkup(createElement(AttachedFileChip, { file }))).not.toContain("Preview table:");
    expect(renderToStaticMarkup(createElement(AttachedFileChip, { file: { ...file, private: false }, message }))).not.toContain("Preview table:");
  });
  it("reads chunked UTF-8 data and rejects too-large responses", async () => {
    const signal = new AbortController().signal;
    expect(await readTableResponse(new Response("A,B\n中文,2"), signal)).toBe("A,B\n中文,2");
    await expect(readTableResponse(new Response("", { headers: { "content-length": String(TABLE_FILE_MAX_BYTES + 1) } }), signal)).rejects.toThrow("size");
    await expect(readTableResponse(new Response(new Uint8Array(TABLE_FILE_MAX_BYTES + 1)), signal)).rejects.toThrow("size");
    await expect(readTableResponse(new Response("A,B"), AbortSignal.abort())).rejects.toThrow();
    await expect(readTableResponse(new Response(new Uint8Array([0xff])), signal)).rejects.toThrow();
  });
});

describe("a reply's table card", () => {
  const card = (rows: number) => renderToStaticMarkup(createElement(RichTable, {
    columns: [{ text: "Sender" }, { text: "Emails" }],
    rows: Array.from({ length: rows }, (_, index) => [{ text: `Sender ${index}` }, { text: String(index) }]),
  }));

  it("draws a short table as a content-sized card with a header band, row hairlines and its tools in a gutter beside it", () => {
    const html = card(3);
    const surface = html.match(/<div data-table-card="[^"]*" class="([^"]*)"/)?.[1] ?? "";
    expect(surface.split(" ")).toEqual(expect.arrayContaining(["w-fit", "max-w-full", "rounded-2xl", "bg-(--chat-card)"]));
    const plate = html.match(/<div class="(table-plate [^"]*)"/)?.[1] ?? "";
    expect(plate.split(" ")).toEqual(expect.arrayContaining(["absolute", "end-0", "opacity-0", "group-hover/table:opacity-100", "focus-within:opacity-100", "touch:opacity-100"]));
    expect(html).toMatch(/class="group\/table relative w-fit max-w-full pe-9/);
    expect(html).toContain('aria-label="Copy table"');
    expect(html).toContain('aria-label="Expand table"');
    expect(html).not.toContain('aria-label="sort by Sender"');
    expect(html).toContain("bg-(--table-head)");
    expect(html).toContain("border-t border-(--table-line)");
    expect(html).not.toContain("<footer");
    expect(html).not.toContain(`aria-label="${"Search all rows…"}"`);
    expect(html).toContain('data-fit="true"');
  });

  it("puts search and the row count inside the card once a table runs past eight rows", () => {
    const html = card(12);
    expect(html).toContain('aria-label="Search all rows…"');
    expect(html).toContain("12 of 12 rows · 2 columns");
    expect(html).not.toContain("<footer");
  });
});
