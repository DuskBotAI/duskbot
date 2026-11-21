import { t } from "@/lib/i18n";
import { canScroll } from "./gesture";
import { haptic } from "./haptics";
import { prefersReducedMotion, rubberband, springEasing } from "./motion";

/** Telegram iOS's numbers: the pull that arms a reply, by who sent the message. */
export const REPLY_THRESHOLD = { incoming: 45, outgoing: 60 } as const;
export const REPLY_MAX = 180;
const RUBBER_RANGE = 100;
const RUBBER_COEFFICIENT = 0.4;
/** a drag this far in either direction decides what it is */
const DECIDE = 10;
/** from the screen's left edge a drag is the page's swipe back, never this */
export const BACK_EDGE = 24;
const ICON = 33;
/** settles in about 0.3 s, as Telegram's release does */
const RELEASE = springEasing(700, 50);

const ROW = "[data-mobile-chat] [data-message-row]";
const IGNORED = "textarea, input, select, [contenteditable='true'], [data-tour='composer'], nav, [role='dialog'], [data-no-swipe], [role='slider']";

/** The row's slide for a finger `dx` px along: right only, 1:1 up to the threshold, then resisting, never past the max. */
export function replyOffset(dx: number, threshold: number): number {
  if (dx <= 0) return 0;
  if (dx <= threshold) return dx;
  return Math.min(REPLY_MAX, threshold + rubberband(dx - threshold, RUBBER_RANGE, RUBBER_COEFFICIENT));
}

/** A drag that replies: clearly sideways and to the right. null: not decided yet. */
export function decideReplyDrag(dx: number, dy: number): "reply" | "other" | null {
  if (Math.abs(dx) < DECIDE && Math.abs(dy) < DECIDE) return null;
  return dx > 0 && Math.abs(dx) > Math.abs(dy) * 2 ? "reply" : "other";
}

function replyButton(row: Element): HTMLButtonElement | null {
  return row.querySelector<HTMLButtonElement>(`[data-testid='message-actions'] button[aria-label="${CSS.escape(t("chat.replyToMessage"))}"]`);
}

/** The message row a drag starting at `x` on `target` would reply to: one that offers Reply, away from the back-swipe
 * edge, not in a field, a sideways scroller or a selection. */
export function replyRowAt(target: EventTarget | null, x: number): HTMLElement | null {
  const el = target instanceof Element ? target : null;
  if (!el || x < BACK_EDGE || el.closest(IGNORED)) return null;
  const row = el.closest<HTMLElement>(ROW);
  if (!row || !replyButton(row)) return null;
  if (canScroll(el, row, "x", 1) || canScroll(el, row, "x", -1)) return null;
  if (!(globalThis.getSelection?.()?.isCollapsed ?? true)) return null;
  return row;
}

function drawIcon(row: HTMLElement): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "m-swipe-reply";
  icon.setAttribute("aria-hidden", "true");
  const glyph = replyButton(row)?.querySelector("svg")?.cloneNode(true);
  if (glyph) icon.append(glyph);
  const bubble = (row.querySelector<HTMLElement>("[data-chat-bubble]") ?? row).getBoundingClientRect();
  icon.style.left = `${bubble.left - ICON - 6}px`;
  icon.style.top = `${bubble.top + bubble.height / 2 - ICON / 2}px`;
  document.body.append(icon);
  return icon;
}

/** Drag a message to the right and a reply icon comes out from under it; past the threshold it arms with one tap of the
 * taptic engine, and letting go there opens the composer quoting it, through the message's own Reply. */
export function installSwipeReply(chat: HTMLElement): () => void {
  let start: { x: number; y: number; row: HTMLElement; threshold: number } | null = null;
  let mode: "reply" | "other" | null = null;
  let icon: HTMLElement | null = null;
  let offset = 0;
  let armed = false;
  let back: Animation | null = null;

  const reset = () => { start = null; mode = null; offset = 0; armed = false; };
  const onStart = (event: TouchEvent) => {
    reset();
    if (event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    const row = replyRowAt(event.target, touch.clientX);
    if (!row || !chat.contains(row)) return;
    const outgoing = row.querySelector("[data-own-row]") !== null;
    start = { x: touch.clientX, y: touch.clientY, row, threshold: outgoing ? REPLY_THRESHOLD.outgoing : REPLY_THRESHOLD.incoming };
  };
  const onMove = (event: TouchEvent) => {
    if (!start || mode === "other") return;
    const touch = event.touches[0]!;
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (mode === null) {
      mode = decideReplyDrag(dx, dy);
      if (mode !== "reply") return;
      back?.cancel();
      icon?.remove();
      icon = drawIcon(start.row);
    }
    if (event.cancelable) event.preventDefault();
    offset = replyOffset(dx, start.threshold);
    const progress = Math.min(1, offset / start.threshold);
    start.row.style.translate = `${offset}px 0`;
    if (icon) {
      icon.style.translate = `${offset}px 0`;
      icon.style.opacity = String(progress);
      icon.style.scale = String(0.6 + 0.4 * progress);
      icon.toggleAttribute("data-armed", progress >= 1);
    }
    if (progress >= 1 && !armed) haptic("swipeReply");
    armed = progress >= 1;
  };
  const onEnd = (event?: TouchEvent) => {
    if (start && mode === "reply") {
      if (event?.cancelable) event.preventDefault();
      const { row } = start;
      const from = row.style.translate;
      row.style.translate = "";
      const leaving = icon;
      icon = null;
      if (prefersReducedMotion() || !from) leaving?.remove();
      else {
        back = row.animate([{ translate: from }, { translate: "0 0" }], { duration: RELEASE.duration, easing: RELEASE.easing });
        const fade = leaving?.animate([{ opacity: leaving.style.opacity, scale: leaving.style.scale, translate: leaving.style.translate }, { opacity: 0, scale: 0.2, translate: "0 0" }], { duration: 300, easing: "ease-out" });
        if (fade) fade.onfinish = () => leaving?.remove(); else leaving?.remove();
      }
      if (armed) replyButton(row)?.click();
    }
    reset();
  };
  const onCancel = () => { armed = false; onEnd(); };
  chat.addEventListener("touchstart", onStart, { passive: true });
  chat.addEventListener("touchmove", onMove, { passive: false });
  chat.addEventListener("touchend", onEnd);
  chat.addEventListener("touchcancel", onCancel);
  return () => {
    onCancel();
    chat.removeEventListener("touchstart", onStart);
    chat.removeEventListener("touchmove", onMove);
    chat.removeEventListener("touchend", onEnd);
    chat.removeEventListener("touchcancel", onCancel);
  };
}
