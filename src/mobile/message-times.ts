import { canScroll } from "./gesture";
import { prefersReducedMotion, rubberband } from "./motion";

/** how far the transcript slides to show the times beside it */
export const TIMES_GUTTER = 76;
/** a drag this far in either direction decides what it is */
const DECIDE = 10;
/** from the screen's left edge a drag is the page's swipe back, never this */
const EDGE = 24;
const BACK = { ms: 260, ease: "cubic-bezier(.2,.9,.3,1)" };

/** The transcript's slide for a finger `dx` px along: left only, up to the gutter, then resisting. */
export function revealOffset(dx: number): number {
  if (dx >= 0) return 0;
  const pulled = -dx;
  return -(pulled <= TIMES_GUTTER ? pulled : TIMES_GUTTER + rubberband(pulled - TIMES_GUTTER, 24));
}

/** A drag that shows the times: clearly sideways and to the left, past the decision distance. null: not decided yet. */
export function decideDrag(dx: number, dy: number): "reveal" | "other" | null {
  if (Math.abs(dx) < DECIDE && Math.abs(dy) < DECIDE) return null;
  return dx < 0 && Math.abs(dx) > Math.abs(dy) * 1.5 ? "reveal" : "other";
}

/** A message's time as the phone tells time: 12 or 24 hour by its own setting. */
export function clockTime(at: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
}

const IGNORED = "textarea, input, [contenteditable='true'], [data-tour='composer'], nav, [role='dialog']";

/** Drag the chat to the left and every message shows when it was sent beside it, as Messages does; let go and it slides
 * back. Rows carry their time in `data-sent-at`; the text is written when a drag begins. Returns the stop. */
export function installMessageTimes(chat: HTMLElement): () => void {
  let start: { x: number; y: number; log: HTMLElement } | null = null;
  let mode: "reveal" | "other" | null = null;
  let offset = 0;

  const reset = () => { start = null; mode = null; offset = 0; };
  const onStart = (event: TouchEvent) => {
    reset();
    if (event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    const target = event.target instanceof Element ? event.target : null;
    const log = chat.querySelector<HTMLElement>("[role='log']");
    const area = log?.closest<HTMLElement>(".glass-scroller") ?? log;
    if (!target || !log || !area?.contains(target) || touch.clientX < EDGE || target.closest(IGNORED)) return;
    if (canScroll(target, log, "x", 1) || canScroll(target, log, "x", -1)) return;
    if (!(globalThis.getSelection?.()?.isCollapsed ?? true)) return;
    start = { x: touch.clientX, y: touch.clientY, log };
  };
  const onMove = (event: TouchEvent) => {
    if (!start || mode === "other") return;
    const touch = event.touches[0]!;
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (mode === null) {
      mode = decideDrag(dx, dy);
      if (mode !== "reveal") return;
      for (const row of start.log.querySelectorAll<HTMLElement>("[data-message-row][data-sent-at]")) {
        const at = Number(row.dataset.sentAt);
        if (at > 0 && !row.dataset.time) row.dataset.time = clockTime(at);
      }
      start.log.getAnimations().forEach((run) => run.cancel());
    }
    if (event.cancelable) event.preventDefault();
    offset = revealOffset(dx);
    start.log.style.transform = `translateX(${offset}px)`;
  };
  const onEnd = () => {
    if (start && mode === "reveal" && offset !== 0) {
      const log = start.log;
      const from = log.style.transform;
      log.style.transform = "";
      if (!prefersReducedMotion()) log.animate([{ transform: from }, { transform: "translateX(0)" }], { duration: BACK.ms, easing: BACK.ease });
    }
    reset();
  };
  chat.addEventListener("touchstart", onStart, { passive: true });
  chat.addEventListener("touchmove", onMove, { passive: false });
  chat.addEventListener("touchend", onEnd);
  chat.addEventListener("touchcancel", onEnd);
  return () => {
    onEnd();
    chat.removeEventListener("touchstart", onStart);
    chat.removeEventListener("touchmove", onMove);
    chat.removeEventListener("touchend", onEnd);
    chat.removeEventListener("touchcancel", onEnd);
  };
}
