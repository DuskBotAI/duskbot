// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HTML_PREVIEW_MAX_BYTES, TextFileContent, filePreviewKind, useFilePreview } from "./HtmlFilePreview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const message = { threadId: "t", messageId: "m" };
let root: Root | null = null;
let container: HTMLElement;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  vi.unstubAllGlobals();
});

async function show(name: string, body: BodyInit, markdown: boolean) {
  const fetch = vi.fn(async () => new Response(body));
  vi.stubGlobal("fetch", fetch);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(TextFileContent, { path: `/workspace/${name}`, name, message, markdown })));
  await vi.waitFor(() => expect(container.querySelector("[role=status]")).toBeNull());
  return fetch;
}

describe("filePreviewKind", () => {
  it.each([["report.html", "html"], ["notes.md", "markdown"], ["Brief.MARKDOWN", "markdown"], ["notes.txt", "text"], ["run.log", "text"], ["data.json", "text"], ["ci.yaml", "text"], ["ci.yml", "text"], ["data.csv", "table"], ["export.TSV", "table"]] as const)(
    "opens %s as %s", (name, kind) => expect(filePreviewKind(name)).toBe(kind));
  it("previews a CSV or TSV on tap like a PDF, page or Markdown file beside it, with Save on its small button, so one list of files never answers a tap two ways", () => {
    expect(filePreviewKind("numbers.csv")).toBe(filePreviewKind("report.pdf") ? "table" : null);
  });
  it.each(["photo.png", "notes.md.zip", "md", "archive.tar"])("saves %s at once", (name) => expect(filePreviewKind(name)).toBeNull());
});

describe("a Markdown or text file's preview", () => {
  it("reads a Markdown file formatted, its source a press away, with Save kept in the preview", async () => {
    const fetch = await show("notes.md", "# Weekly brief\n\nAll **good**.", true);
    expect(fetch).toHaveBeenCalledWith("/api/threads/t/messages/m/file", expect.objectContaining({ method: "POST", body: JSON.stringify({ path: "/workspace/notes.md" }) }));
    await vi.waitFor(() => expect(container.querySelector("[data-file-preview=markdown] [data-md-h=\"1\"]")?.textContent).toBe("Weekly brief"), { timeout: 10_000 });
    expect(container.querySelector("[data-file-preview=markdown] strong")?.textContent).toBe("good");
    expect(container.querySelector('[aria-label="Save a copy of notes.md"]')).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="View source"]')!.click());
    expect(container.querySelector("[data-file-preview=text]")?.textContent).toBe("# Weekly brief\n\nAll **good**.");
    expect(container.querySelector('[aria-label="View formatted"]')).not.toBeNull();
  });

  it("shows a text file as it is, in a fixed-width face, with no formatted view", async () => {
    await show("run.txt", "line one\n**not bold**", false);
    const text = container.querySelector("[data-file-preview=text]")!;
    expect(text.textContent).toBe("line one\n**not bold**");
    expect(text.className).toContain("font-mono");
    expect(container.querySelector('[aria-label="View source"]')).toBeNull();
    expect(container.querySelector('[aria-label="Save a copy of run.txt"]')).not.toBeNull();
  });

  it("says a file over the preview cap is too large, and still saves it", async () => {
    await show("huge.md", new Uint8Array(HTML_PREVIEW_MAX_BYTES + 1), true);
    expect(container.querySelector("[role=alert]")?.textContent).toBe("This file is too large for an in-app preview (2 MB). Save it to read it.");
    expect(container.querySelector('[aria-label="Save a copy of huge.md"]')).not.toBeNull();
  });
});

describe("a file preview dialog", () => {
  function Opener({ name }: { name: string }) {
    const preview = useFilePreview(`/workspace/${name}`, name, message);
    return createElement("div", null, createElement("button", { type: "button", onClick: preview.show }, "open"), preview.dialog);
  }

  async function open(name: string, body: string) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(Opener, { name })));
    await act(async () => container.querySelector("button")!.click());
    return document.querySelector("dialog")!;
  }

  it.each(["notes.md", "run.txt", "report.html"])("names its close button for the preview it shows, not a table, for %s", async (name) => {
    const dialog = await open(name, "hello");
    expect(dialog.querySelector("header button")?.getAttribute("aria-label")).toBe("Close preview");
  });

  it("keeps Close table for a table file", async () => {
    const dialog = await open("data.csv", "a,b\n1,2\n");
    expect(dialog.querySelector("header button")?.getAttribute("aria-label")).toBe("Close table");
  });

  it("lets a short Markdown file's card fit its text instead of filling a fixed tall box", async () => {
    const dialog = await open("notes.md", "# Short");
    await vi.waitFor(() => expect(dialog.querySelector("[data-file-preview=markdown]")).not.toBeNull(), { timeout: 10_000 });
    const classes = dialog.querySelector("[data-file-preview=markdown]")!.className.split(/\s+/);
    expect(classes).toContain("max-h-[72dvh]");
    expect(classes).not.toContain("h-[72dvh]");
  });
});
