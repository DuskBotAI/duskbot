// A reply's words revealed at a steady pace, each one fading in, however unevenly its text arrives. The pacer decides how
// much of the text is shown; the rehype plugin wraps the words that are new in this render so CSS can fade them in.

/** Never slower than this, so a short answer still lands at a reading pace (chars per second). */
export const REVEAL_MIN_CPS = 70;
/** Whatever is still waiting is shown within about this long, so the reveal never trails the stream far behind. */
export const REVEAL_CATCH_UP_S = 0.7;
/** The stagger between words landing in one step, and the cap on a whole landing's stagger (ms). */
export const REVEAL_WORD_STEP_MS = 26;
export const REVEAL_SPAN_MS = 900;

/** Where a word ends: the next whitespace after `at`, or the end. A reveal never stops inside a word. */
function wordEnd(text: string, at: number): number {
  if (at <= 0) return 0;
  if (at >= text.length) return text.length;
  const rest = text.slice(at).search(/\s/);
  return rest < 0 ? text.length : at + rest;
}

/** How many characters of `text` show after `elapsedMs`, from `shown`: at least REVEAL_MIN_CPS, faster when more is
 * waiting, always at a word's end. Pure, so the cadence is testable. */
export function nextReveal(text: string, shown: number, elapsedMs: number): number {
  if (shown >= text.length) return text.length;
  const waiting = text.length - shown;
  const cps = Math.max(REVEAL_MIN_CPS, waiting / REVEAL_CATCH_UP_S);
  const step = Math.max(1, Math.floor((cps * Math.max(0, elapsedMs)) / 1000));
  return wordEnd(text, Math.min(text.length, shown + step));
}

/** The stagger for `count` new words landing at once: a few words read as a steady patter, a whole reply at once
 * still lands inside REVEAL_SPAN_MS. */
export function revealStep(count: number): number {
  if (count <= 1) return 0;
  return Math.max(6, Math.min(REVEAL_WORD_STEP_MS, Math.round(REVEAL_SPAN_MS / count)));
}

/** A prefix of a reply cut mid-markdown, closed so it draws as it will once whole: an open code fence, inline code or
 * bold is closed at the cut instead of showing its marks. */
export function closeOpenMarks(text: string): string {
  let out = text;
  if ((out.match(/^```/gm)?.length ?? 0) % 2 === 1) return `${out}\n\`\`\``;
  const outsideFences = out.replace(/^```[\s\S]*?^```/gm, "");
  if ((outsideFences.match(/`/g)?.length ?? 0) % 2 === 1) out += "`";
  const bold = outsideFences.replace(/`[^`]*`?/g, "").match(/\*\*/g)?.length ?? 0;
  if (bold % 2 === 1) out = /\*\*\s*$/.test(out) ? out.replace(/\s*\*\*\s*$/, "") : `${out.trimEnd()}**`;
  return out;
}

/** Counts the words of a text the way the plugin counts them (whitespace-separated runs). */
export function wordCount(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

interface HastText { type: "text"; value: string }
interface HastElement { type: "element"; tagName: string; properties?: Record<string, unknown>; children: HastNode[] }
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

const SKIP_TAGS = new Set(["pre", "code", "svg", "math", "annotation", "semantics", "img", "input", "a"]);

function skipped(node: HastElement): boolean {
  if (SKIP_TAGS.has(node.tagName)) return true;
  const className = node.properties?.className;
  return Array.isArray(className) && className.some((name) => typeof name === "string" && name.startsWith("katex"));
}

/** Rehype plugin: every word from index `from` on is wrapped in `<span class="md-rv" style="--rv:n">`, n counting from
 * 0 at `from`; earlier words stay plain text. Code, math, links and images are never split and not counted: they
 * arrive whole, and a link keeps the plain label its renderer shortens. */
export function rehypeRevealWords({ from }: { from: number }) {
  return () => (tree: HastNode) => {
    let index = 0;
    const visit = (node: HastNode) => {
      const children = (node as { children?: HastNode[] }).children;
      if (!children) return;
      const next: HastNode[] = [];
      for (const child of children) {
        if (child.type === "element") {
          if (!skipped(child as HastElement)) visit(child);
          next.push(child);
          continue;
        }
        if (child.type !== "text") { next.push(child); continue; }
        const value = (child as HastText).value;
        let plain = "";
        for (const part of value.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part) || index++ < from) { plain += part; continue; }
          if (plain) { next.push({ type: "text", value: plain }); plain = ""; }
          next.push({ type: "element", tagName: "span", properties: { className: ["md-rv"], style: `--rv:${index - 1 - from}` }, children: [{ type: "text", value: part }] });
        }
        if (plain) next.push({ type: "text", value: plain });
      }
      (node as { children: HastNode[] }).children = next;
    };
    visit(tree);
  };
}


/** What the live bubble last showed, per thread, for the reply that lands in its place a moment later. */
const handoffs = new Map<string, { words: number; at: number }>();
const HANDOFF_FRESH_MS = 4_000;
export function noteRevealed(threadId: string, words: number): void {
  handoffs.delete(threadId);
  handoffs.set(threadId, { words, at: Date.now() });
  if (handoffs.size > 50) handoffs.delete(handoffs.keys().next().value!);
}
/** Only a handoff from moments ago counts: an older reply drawn again (the chat reopened) reveals nothing. */
export function revealedWords(threadId: string, now = Date.now()): number | null {
  const handoff = handoffs.get(threadId);
  return handoff && now - handoff.at < HANDOFF_FRESH_MS ? handoff.words : null;
}

const FENCE = /^\s{0,3}(```|~~~)/;
/** a line that carries on the block before a blank line: a list item, an indented line, a quote or a table row */
const CONTINUES = /^(\s+\S|\s{0,3}([-*+]|\d+[.)])\s|\s{0,3}>|\s*\|)/;

/** A streaming reply cut into its finished blocks and the one still growing, at blank lines outside code fences and
 * never before a line that continues a list, quote or table, so each finished block renders as it will land. */
export function streamingBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (FENCE.test(line)) fenced = !fenced;
    const next = lines[i + 1];
    if (!fenced && line.trim() === "" && current.length > 0 && next !== undefined && next.trim() !== "" && !CONTINUES.test(next)) {
      blocks.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}
