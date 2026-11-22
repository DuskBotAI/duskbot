// @vitest-environment happy-dom
import { createElement, Profiler } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { describe, expect, it, vi } from "vitest";
import { RichTable } from "./RichTable";
import { ChatMarkdown } from "./ChatMarkdown";
import { CELL_PADDING_PX, CHAR_PX, COLUMN_MAX_CHARS, COLUMN_MIN_CHARS, columnMinimums, fitsColumns } from "@/lib/table-fit";
import { setPhoneBridge } from "@/lib/phone-bridge";


const header = ["App", "Stars", "License", "Target user", "Strength", "Weakness", "Verdict"];
const row = ["OpenHands (ex-OpenDevin)", "~85k", "MIT", "Developers who want an autonomous coder",
  "Runs real software tasks end to end", "Needs a strong model and a sandbox", "Best open coding agent today"];
const markdown = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...Array.from({ length: 10 }, () => `| ${row.join(" | ")} |`)].join("\n");

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
}

describe("a table in a reply", () => {
  it("fits every column to the message: auto layout, wrapped cells, no fixed widths and no inner scroll box", () => {
    const doc = parse(renderToStaticMarkup(createElement(ChatMarkdown, { text: markdown })));
    const table = doc.querySelector("table")!;
    expect(table.className).toContain("table-auto");
    expect(table.className).toContain("w-full");
    expect(table.getAttribute("style")).toBeNull();
    expect(doc.querySelector("colgroup")).toBeNull();
    const viewport = doc.querySelector<HTMLElement>("[role=region]")!;
    expect(viewport.dataset.fit).toBe("true");
    expect(viewport.getAttribute("style") ?? "").not.toContain("max-height");
    expect(doc.querySelectorAll("th")).toHaveLength(7);
    const floors = [...doc.querySelectorAll<HTMLElement>("th > div")].map((cell) => Number.parseFloat(cell.style.minWidth));
    expect(floors).toEqual(columnMinimums(header, [row]));
    expect(floors.reduce((sum, width) => sum + width, 0) + 7 * CELL_PADDING_PX).toBeLessThan(704);
    for (const cell of doc.querySelectorAll("td > div")) expect(cell.className).toContain("[overflow-wrap:anywhere]");
    const surface = doc.querySelector("[data-table-card]")!;
    expect(surface.className).toContain("w-fit");
    expect(surface.parentElement!.parentElement!.className).toBe("chat-table");
  });

  it("keeps fixed columns and a scroll box for a very long table, whose rows are drawn as they scroll", () => {
    const doc = parse(renderToStaticMarkup(createElement(RichTable, {
      columns: header.map((text) => ({ text })), rows: Array.from({ length: 500 }, () => row.map((text) => ({ text }))),
    })));
    expect(doc.querySelector("table")!.className).toContain("table-fixed");
    expect(doc.querySelectorAll("col")).toHaveLength(7);
    expect(doc.querySelector<HTMLElement>("[role=region]")!.style.maxHeight).toBe("400px");
    expect(fitsColumns({ wrap: true, virtual: false })).toBe(true);
    expect(fitsColumns({ wrap: false, virtual: false })).toBe(false);
    expect(fitsColumns({ wrap: true, virtual: true })).toBe(false);
  });

  it("keeps roomy columns and scrolls sideways, with no inner scroll box, when even the narrowest columns cannot fit", () => {
    const minimums = columnMinimums(header, [row]);
    const needed = minimums.reduce((sum, width) => sum + width + CELL_PADDING_PX, 0);
    expect(fitsColumns({ wrap: true, virtual: false, minimums, available: needed })).toBe(true);
    expect(fitsColumns({ wrap: true, virtual: false, minimums, available: needed - 1 })).toBe(false);
    let report: () => void = () => undefined;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { report = callback; } observe() {} disconnect() {} });
    let regionWidth = 300;
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "region" ? regionWidth : 0;
    });
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      let commits = 0;
      flushSync(() => root.render(createElement(Profiler, { id: "table", onRender: () => { commits += 1; } },
        createElement(RichTable, { columns: header.map((text) => ({ text })), rows: Array.from({ length: 10 }, () => row.map((text) => ({ text }))) }))));
      expect(host.querySelector("table")!.className).toContain("table-auto");
      flushSync(() => report());
      const viewport = host.querySelector<HTMLElement>("[role=region]")!;
      expect(host.querySelector("table")!.className).toContain("table-fixed");
      expect(host.querySelectorAll("col")).toHaveLength(7);
      expect(viewport.dataset.fit).toBeUndefined();
      expect(viewport.style.maxHeight).toBe("");
      const settled = commits;
      for (const next of [290, 280, 310]) { regionWidth = next; flushSync(() => report()); }
      expect(commits, "a resize that keeps the fit redraws nothing").toBe(settled);
    } finally {
      root.unmount();
      width.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("floors a column at its longest word, within bounds", () => {
    expect(columnMinimums(["ID", "Notes"], [["7", "a"], ["12", "Extraordinarily-long-identifier here"]])).toEqual([
      COLUMN_MIN_CHARS * CHAR_PX, COLUMN_MAX_CHARS * CHAR_PX,
    ]);
    expect(columnMinimums(["Verdict"], [["Best open coding agent"]])).toEqual([Math.round(7 * CHAR_PX)]);
  });

  it("enlarges on mobile only from the expand button, not from clicking the table itself", () => {
    const view = vi.fn();
    const clearBridge = setPhoneBridge({
      haptic: () => {},
      openLink: () => {},
      share: async () => {},
      shareFile: async () => {},
      view,
    });
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      flushSync(() => root.render(createElement(RichTable, {
        columns: [{ text: "Plan" }, { text: "Price" }],
        rows: [[{ text: "Pro" }, { text: "$20" }]],
      })));
      host.querySelector<HTMLElement>("td")!.click();
      host.querySelector<HTMLElement>("th")!.click();
      expect(view).not.toHaveBeenCalled();

      host.querySelector<HTMLButtonElement>("[data-table-expand]")!.click();
      expect(view).toHaveBeenCalledTimes(1);
      expect(view.mock.calls[0]?.[0]).toMatchObject({ kind: "table" });
    } finally {
      root.unmount();
      clearBridge();
    }
  });
});
