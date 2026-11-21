// read_pages: web pages as readable text, for a conversation whose engine has no fetch of its own. Free, read-only.
import { readPage, type PageRead } from "../page-reader.ts";
import type { ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const READ_PAGES_TOOL = "read_pages";
const MAX_URLS = 5;
const PAGE_CHARS = 15_000;
/** Kept under the agents result cap, so a batch of pages is never saved aside as one oversized result. */
const BATCH_CHARS = 22_000;

export const READ_PAGES_DEFINITION = {
  name: READ_PAGES_TOOL,
  description: `Read 1 to ${MAX_URLS} public web pages at once, as clean text with headings, lists and [text](url) links. Free. Pages on this computer or a private network are refused. A long page is cut and ends with the exact call that reads on.`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      urls: { type: "array", minItems: 1, maxItems: MAX_URLS, items: { type: "string", minLength: 1, maxLength: 2048 }, description: `1 to ${MAX_URLS} http or https addresses.` },
      offset: { type: "integer", minimum: 0, description: "Read on from this character of a page cut earlier. Default 0." },
    },
    required: ["urls"],
  },
} as const;

type Reader = (url: string) => Promise<PageRead>;

/** A refusal is about this reader only: a page on the computer dusk bot runs on is still reachable from a job there. */
const LOCAL_PAGE_ROUTE = "This reader opens only public pages, but a page on this computer is still yours to check: a background job (background_job) runs on this computer and can read it on a schedule, and so can your shell or browser when you have them. Only a page on another machine of theirs needs that machine under Works on.";

function onThisComputer(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

function pageText(page: PageRead, offset: number, budget: number): string {
  if (!page.ok && page.refused && onThisComputer(page.url)) return `## ${page.url}\nFailed: ${LOCAL_PAGE_ROUTE}`;
  if (!page.ok) return `## ${page.url}\nFailed: ${page.error}`;
  const head = `## ${page.title ? `${page.title} (${page.url})` : page.url}`;
  if (!page.text) return `${head}\nThe page has no readable text. It may need a browser to run its scripts.`;
  if (offset >= page.text.length) return `${head}\nNothing past character ${offset}: the page has ${page.text.length} characters.`;
  const end = Math.min(page.text.length, offset + budget);
  const body = page.text.slice(offset, end);
  const lines = [head, offset > 0 ? `(from character ${offset})` : "", body].filter(Boolean);
  if (end < page.text.length) {
    lines.push(`[Cut at character ${end} of ${page.text.length}. Read on with ${READ_PAGES_TOOL} ${JSON.stringify({ urls: [page.url], offset: end })}]`);
  } else if (page.cut) {
    lines.push("[The page was larger than this reader takes; this is its first part.]");
  }
  return lines.join("\n");
}

export async function callReadPages(args: Json, read: Reader = (url) => readPage(url)): Promise<ToolCallResult> {
  const urls = [...new Set((Array.isArray(args.urls) ? args.urls : []).filter((url): url is string => typeof url === "string").map((url) => url.trim()).filter(Boolean))];
  if (!urls.length) return { text: `${READ_PAGES_TOOL} needs urls: 1 to ${MAX_URLS} web addresses.`, isError: true };
  if (urls.length > MAX_URLS) return { text: `${READ_PAGES_TOOL} reads at most ${MAX_URLS} pages per call.`, isError: true };
  const offset = typeof args.offset === "number" && Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0;
  const budget = Math.min(PAGE_CHARS, Math.floor(BATCH_CHARS / urls.length));
  const pages = await Promise.all(urls.map((url) => read(url).catch((): PageRead => ({ ok: false, url, error: "The page could not be reached." }))));
  const text = pages.map((page) => pageText(page, offset, budget)).join("\n\n");
  return pages.every((page) => !page.ok) ? { text, isError: true } : { text };
}
