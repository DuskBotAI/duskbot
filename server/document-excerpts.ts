// What of a long document fits a prompt: its start with an outline of the whole, or the passages that mention what is
// asked. PDF text carries a form feed between pages (pdf.js through pdf-text.worker.ts, and pdftotext).
const PAGE_BREAK = /\n?\f\n?/;
const OUTLINE_LINES = 80;
const OUTLINE_CHARS = 3_000;
const PASSAGE_CHARS = 1_500;

const NUMBERED = /^(?:Slide \d+|Sheet: .+|(?:\d+(?:\.\d+)*[.)]?|[IVX]+\.|Chapter|Section|Part|Appendix)\s+\p{Lu}.*)$/u;
const heading = (line: string) => NUMBERED.test(line) || (line.length <= 60 && /\p{Lu}{3}/u.test(line) && !/\p{Ll}/u.test(line));

/** Headings of the whole text, each with its page when the text has pages: numbered and capitalised lines, slides and
 * sheets. */
export function outlineOf(text: string): string[] {
  const pages = text.split(PAGE_BREAK);
  const out: string[] = [];
  let chars = 0;
  const seen = new Set<string>();
  for (const [index, page] of pages.entries()) {
    for (const raw of page.split("\n")) {
      const line = raw.replace(/\s+/g, " ").trim();
      if (line.length < 3 || line.length > 90 || !heading(line) || seen.has(line)) continue;
      seen.add(line);
      const entry = pages.length > 1 ? `p.${index + 1} ${line}` : line;
      if (out.length >= OUTLINE_LINES || chars + entry.length > OUTLINE_CHARS) return out;
      out.push(entry);
      chars += entry.length + 1;
    }
  }
  return out;
}

export interface DocumentHead {
  text: string;
  /** Pages shown and in all, for a text with pages. */
  pages?: { shown: number; total: number };
}

/** The first whole pages that fit `maxChars` (at least the start of the first), or the first `maxChars` characters. */
export function headOf(text: string, maxChars: number): DocumentHead {
  const pages = text.split(PAGE_BREAK);
  if (pages.length < 2) return { text: cut(text, maxChars) };
  let shown = 0, used = 0;
  while (shown < pages.length && used + pages[shown]!.length + 2 <= maxChars) used += pages[shown++]!.length + 2;
  if (!shown) return { text: cut(pages[0]!, maxChars), pages: { shown: 1, total: pages.length } };
  return { text: pages.slice(0, shown).join("\n\n"), pages: { shown, total: pages.length } };
}

function cut(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const end = text.lastIndexOf("\n", maxChars);
  return text.slice(0, end > maxChars * 0.8 ? end : maxChars);
}

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4);

/** The passages that mention the most of `about`, in document order, up to `maxChars`, each with its page. */
export function passagesAbout(text: string, about: string, maxChars: number): string[] {
  const wanted = new Set(words(about));
  if (!wanted.size) return [];
  const chunks: Array<{ page: number; text: string; order: number; score: number }> = [];
  for (const [index, page] of text.split(PAGE_BREAK).entries()) {
    let current = "";
    const flush = () => {
      if (!current.trim()) return;
      const hits = new Set(words(current).filter((word) => wanted.has(word)));
      chunks.push({ page: index + 1, text: current.trim(), order: chunks.length, score: hits.size });
      current = "";
    };
    for (const line of page.split("\n")) {
      if (current.length + line.length > PASSAGE_CHARS) flush();
      current += `${line}\n`;
    }
    flush();
  }
  const paged = text.split(PAGE_BREAK).length > 1;
  const picked: typeof chunks = [];
  let used = 0;
  for (const chunk of chunks.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.order - b.order)) {
    if (used + chunk.text.length > maxChars) continue;
    picked.push(chunk);
    used += chunk.text.length;
  }
  return picked.sort((a, b) => a.order - b.order).map((chunk) => (paged ? `[p.${chunk.page}] ${chunk.text}` : chunk.text));
}
