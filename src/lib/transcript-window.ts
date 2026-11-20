export const TRANSCRIPT_WINDOW_SIZE = 120;
/** A phone mounts half as many rows: opening a long chat lays out and paints half the transcript, and older rows come in
 * as the person scrolls up. */
export const PHONE_TRANSCRIPT_WINDOW_SIZE = 60;

/** While the person pages back through a long chat one window of rows stays mounted, moving this share of it at a time:
 * paging earlier lets the newest rows go, paging later the oldest. */
export const PAGE_SHARE = 0.5;

export interface TranscriptWindow<T> {
  visible: T[];
  hiddenCount: number;
  laterCount: number;
  startIndex: number;
  endIndex: number;
}

export interface TranscriptWindowRange {
  start: number;
  end: number;
}

export function tailWindowStart(total: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  return Math.max(0, total - size);
}

export function followWindowStart(messages: readonly { role?: string }[], start: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  const tail = tailWindowStart(messages.length, size);
  const oldest = Math.max(start, tail - size);
  for (let index = messages.length - 1; index >= oldest; index--) {
    if (messages[index].role === "user") return Math.min(tail, index);
  }
  return tail;
}

export function expandWindowStart(startIndex: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  return Math.max(0, startIndex - size);
}

export function focusWindowRange(
  total: number,
  targetIndex: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
): TranscriptWindowRange {
  const safeTotal = Math.max(0, total);
  const safeSize = Math.max(1, size);
  const target = Math.max(0, Math.min(targetIndex, Math.max(0, safeTotal - 1)));
  const start = Math.max(0, Math.min(target - Math.floor(safeSize / 2), Math.max(0, safeTotal - safeSize)));
  return { start, end: Math.min(safeTotal, start + safeSize) };
}

export function resolveTranscriptWindow<T>(
  messages: readonly T[],
  startIndex: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  endIndex: number | null = null,
): TranscriptWindow<T> {
  const requestedEnd = endIndex === null ? messages.length : Math.max(0, Math.min(messages.length, endIndex));
  const invalidFiniteWindow = endIndex !== null && startIndex >= requestedEnd;
  const start =
    startIndex >= messages.length || invalidFiniteWindow
      ? tailWindowStart(messages.length, size)
      : Math.max(0, startIndex);
  const end = invalidFiniteWindow ? messages.length : Math.max(start, requestedEnd);
  return {
    visible: messages.slice(start, end),
    hiddenCount: start,
    laterCount: messages.length - end,
    startIndex: start,
    endIndex: end,
  };
}

/** The window cut to `max` rows from its start, for a reader paging back. */
export function boundedWindow(range: { start: number; end: number | null }, total: number, max: number): { start: number; end: number | null } {
  if ((range.end ?? total) - range.start <= max) return range;
  const end = range.start + max;
  return { start: range.start, end: end >= total ? null : end };
}

/** One window further on, letting the oldest rows go past `max`. */
export function laterWindow(range: { start: number; end: number }, total: number, size: number, max: number): { start: number; end: number | null } {
  const end = Math.min(total, range.end + size);
  return { start: Math.max(range.start, end - max), end: end >= total ? null : end };
}

/** The window once `landed` older rows arrived from the server above it: their newest page over the rows the reader
 * was on. */
export function olderPageWindow(range: { start: number; end: number | null }, landed: number, total: number, size: number, max: number): { start: number; end: number | null } {
  const start = Math.max(0, range.start + landed - size);
  return boundedWindow({ start, end: range.end === null ? null : range.end + landed }, total, max);
}
