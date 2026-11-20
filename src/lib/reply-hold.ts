/** How much of the row above a long reply stays in view when the transcript stops at the reply's top (px): the end of
 * the person's message, so the reply reads as the answer to it. */
export const READING_PEEK_PX = 40;

/** Where a transcript following its end stops instead, so a reply taller than the view is read from its start: the
 * reply's top just under the header with READING_PEEK_PX of the row above. Null when following to the end keeps that
 * top in view, or when the view is already past it. */
export function replyHoldTop({ replyTop, inset, end, current }: { replyTop: number; inset: number; end: number; current: number }): number | null {
  const hold = Math.max(0, replyTop - inset - READING_PEEK_PX);
  if (end <= hold || current > hold + 2) return null;
  return hold;
}

const px = (style: CSSStyleDeclaration, name: string) => {
  const value = parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
};

/** How much of the transcript's top the person does not see: the header the glass skins draw over it, and on the
 * iPhone with the keyboard up, the part of the page the native side lifts above the screen (`--m-lift`). */
export function readingInset(scroller: HTMLElement): number {
  const style = getComputedStyle(scroller);
  return px(style, "--glass-top") + px(style, "--m-lift");
}

/** A row's top in the scroller's content, without whatever translateY the column is drawn at (`drawnAt`). */
export function contentTop(scroller: HTMLElement, row: Element, drawnAt = 0): number {
  return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - drawnAt;
}

/** The bot's newest bubble when it is the last row to arrive in this conversation (a reply still growing). */
export function growingReply(column: HTMLElement): HTMLElement | null {
  const last = [...column.querySelectorAll<HTMLElement>("[data-arrival]")].at(-1);
  return last?.getAttribute("data-arrival") === "start" ? last : null;
}

/** The first reply row of a landing batch with no message of the person's after it. */
export function landingReply(arrivals: readonly HTMLElement[]): HTMLElement | null {
  let first: HTMLElement | null = null;
  for (const row of arrivals) {
    if (row.getAttribute("data-arrival") === "start") first ??= row;
    else first = null;
  }
  return first;
}
