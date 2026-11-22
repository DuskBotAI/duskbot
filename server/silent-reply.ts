const DIRECT_PASS = /^\(\s*pass\s*\)\.?$/i;
const PASS_PREFIX = /^\(\s*(?:p(?:a(?:s(?:s(?:\s*(?:\)\.?\s*)?)?)?)?)?)?$/i;
const TRAILING_PASS = /(?:\r?\n)+\s*\(\s*pass\s*\)\.?\s*$/i;
const TRAILING_PASS_PREFIX = /((?:\r?\n)+\s*(?:\(\s*(?:p(?:a(?:s(?:s(?:\s*(?:\)\.?\s*)?)?)?)?)?)?)?)$/i;

export function isDirectPassText(text: string | undefined): boolean {
  return DIRECT_PASS.test((text ?? "").trim());
}

export function stripTrailingPass(text: string): string {
  let out = text;
  while (TRAILING_PASS.test(out)) out = out.replace(TRAILING_PASS, "");
  return out;
}

export function isPassStreamPrefix(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.length === 0 || PASS_PREFIX.test(trimmed);
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
    const trailing = TRAILING_PASS_PREFIX.exec(combined);
    if (trailing) {
      const hold = trailing[1]!;
      const emit = combined.slice(0, combined.length - hold.length);
      this.held.set(threadId, hold);
      return emit.length > 0 ? emit : null;
    }
    this.held.delete(threadId);
    return combined;
  }

  reset(threadId: string): void {
    this.held.delete(threadId);
    this.released.delete(threadId);
  }
}
