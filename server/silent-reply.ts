const DIRECT_PASS = /^\(\s*pass\s*\)\.?$/i;
const PASS_PREFIX = /^\(\s*(?:p(?:a(?:s(?:s(?:\s*(?:\)\.?\s*)?)?)?)?)?)?$/i;
const WHITESPACE = /\s/;

export function isDirectPassText(text: string | undefined): boolean {
  return DIRECT_PASS.test((text ?? "").trim());
}

export function isPassStreamPrefix(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.length === 0 || PASS_PREFIX.test(trimmed);
}

function firstLineBreakInBlanksBefore(text: string, end: number): number {
  let start = end;
  while (start > 0 && WHITESPACE.test(text[start - 1]!)) start--;
  const newline = text.indexOf("\n", start);
  if (newline < 0 || newline >= end) return -1;
  return text[newline - 1] === "\r" ? newline - 1 : newline;
}

function trailingPassStart(text: string): number {
  const open = text.lastIndexOf("(");
  return open >= 0 && isDirectPassText(text.slice(open)) ? firstLineBreakInBlanksBefore(text, open) : -1;
}

function trailingPassPrefixStart(text: string): number {
  const open = text.lastIndexOf("(");
  const beforeOpen = open >= 0 && isPassStreamPrefix(text.slice(open)) ? firstLineBreakInBlanksBefore(text, open) : -1;
  return beforeOpen >= 0 ? beforeOpen : firstLineBreakInBlanksBefore(text, text.length);
}

export function stripTrailingPass(text: string): string {
  let out = text;
  for (let start = trailingPassStart(out); start >= 0; start = trailingPassStart(out)) out = out.slice(0, start);
  return out;
}

/** Holds leading or trailing newline-prefixed assistant_text deltas while they could still spell "(pass)", so clients never flash it live. */
export class PassStreamGate {
  private readonly held = new Map<string, string>();
  private readonly released = new Set<string>();

  delta(threadId: string, chunk: string): string | null {
    const combined = (this.held.get(threadId) ?? "") + chunk;
    if (!this.released.has(threadId)) {
      if (isPassStreamPrefix(combined)) {
        this.held.set(threadId, combined);
        return null;
      }
      this.released.add(threadId);
    }
    const hold = trailingPassPrefixStart(combined);
    if (hold >= 0) {
      this.held.set(threadId, combined.slice(hold));
      return hold > 0 ? combined.slice(0, hold) : null;
    }
    this.held.delete(threadId);
    return combined;
  }

  reset(threadId: string): void {
    this.held.delete(threadId);
    this.released.delete(threadId);
  }
}
