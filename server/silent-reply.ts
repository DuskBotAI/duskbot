const DIRECT_PASS = /^\(\s*pass\s*\)\.?$/i;
const PASS_PREFIX = /^\(\s*(?:p(?:a(?:s(?:s(?:\s*(?:\)\.?\s*)?)?)?)?)?)?$/i;

export function isDirectPassText(text: string | undefined): boolean {
  return DIRECT_PASS.test((text ?? "").trim());
}

export function isPassStreamPrefix(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.length === 0 || PASS_PREFIX.test(trimmed);
}

/** Holds leading assistant_text deltas only while they could still spell "(pass)", so clients never flash it live. */
export class PassStreamGate {
  private readonly held = new Map<string, string>();
  private readonly released = new Set<string>();

  delta(threadId: string, chunk: string): string | null {
    if (this.released.has(threadId)) return chunk;
    const next = (this.held.get(threadId) ?? "") + chunk;
    if (isPassStreamPrefix(next)) {
      this.held.set(threadId, next);
      return null;
    }
    this.held.delete(threadId);
    this.released.add(threadId);
    return next;
  }

  reset(threadId: string): void {
    this.held.delete(threadId);
    this.released.delete(threadId);
  }
}
