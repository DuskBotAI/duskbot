import { feel, prefersReducedMotion, springEasing } from "./motion";

/** Controls that already press in CSS (the shell's round buttons, the composer discs) or that move under the finger. */
const OWN_PRESS = ".mobile-press, [data-long-press], [data-composer-send], [data-voice-mic], [data-composer-stop], [data-composer-plus], [role='slider'], [role='switch'], input, textarea, select";
/** On Android: controls that answer with a ripple of their own (the composer's), press in CSS, or move under the finger,
 * and rows and menu items, where a ripple reads as the whole row flashing. */
const OWN_RIPPLE = ".mobile-press, .mobile-row, [role='menuitem'], [role='menuitemradio'], [role='option'], [data-tour='composer'] button, [role='slider'], input, textarea, select";
const TAPPABLE = "button, a[href], [role='button'], [role='menuitem'], [role='option'], [role='tab'], [role='radio'], [role='switch'], label[for], summary";
const CARD_CONTAINER = "[data-settings-card], [data-panel-card-surface], [data-settings-rows]";
const CARD_ROW = "button, a[href], [data-select-row]";
const CARD_NO_HIGHLIGHT = "[data-segmented], [data-system-control], [data-no-press], input, textarea, select";
/** Matches UIKit UITableView delaysContentTouches (~90ms) and scroll cancellation slop. */
const ROW_HIGHLIGHT_DELAY_MS = 90;
const ROW_TAP_FLASH_MS = 70;
const ROW_SCROLL_SLOP_PX = 8;

export function cardRowTarget(target: EventTarget | null, root: Element): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  if (target.closest(CARD_NO_HIGHLIGHT)) return null;
  const row = target.closest<HTMLElement>(CARD_ROW);
  if (!row || !root.contains(row)) return null;
  const card = row.closest(CARD_CONTAINER);
  if (!card || !root.contains(card)) return null;
  if (row.matches(":disabled, [aria-disabled='true'], [role='switch']") || row.closest("[data-no-press]")) return null;
  const parent = row.parentElement;
  if (parent !== card && !(parent?.matches("li, .contents") && parent.parentElement?.closest(CARD_CONTAINER) === card)) return null;
  return row;
}

export function pressTarget(target: EventTarget | null, root: Element, own = OWN_PRESS): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>(TAPPABLE);
  if (!el || !root.contains(el) || el.matches(own) || el.closest(own)) return null;
  if (el.matches(":disabled, [aria-disabled='true']") || el.closest("[data-no-press]")) return null;
  if (el.closest(CARD_CONTAINER)) return null;
  return el;
}

/** Wide things (a chat row, a settings row) barely move; small ones press further. */
export function pressScale(width: number): number {
  return width > 180 ? feel.press.wide : feel.press.scale;
}

/** Every tappable in the phone shell sinks under the finger and springs back on release, so a tap always lands. Runs on
 * the compositor through `scale`, which leaves each control's own transform and transitions alone. A touch that turns
 * into a scroll lets go at once. */
export function installPress(root: HTMLElement): () => void {
  if (document.documentElement.dataset.mobileApp === "android") return installRipple(root);
  const release = springEasing(feel.press.release.stiffness, feel.press.release.damping);
  let held: { el: HTMLElement; anim: Animation; to: number } | null = null;
  let rowTouch: { el: HTMLElement; x: number; y: number; timer: number; highlighted: boolean; cancelled: boolean } | null = null;
  let flashTimer = 0;
  let flashing: HTMLElement | null = null;

  const clearFlash = () => {
    if (flashTimer) { window.clearTimeout(flashTimer); flashTimer = 0; }
    if (flashing) { delete flashing.dataset.rowHighlighted; flashing = null; }
  };

  const cancelRow = () => {
    if (!rowTouch) return;
    if (rowTouch.timer) window.clearTimeout(rowTouch.timer);
    if (rowTouch.highlighted) delete rowTouch.el.dataset.rowHighlighted;
    rowTouch = null;
  };

  const letGo = () => {
    cancelRow();
    if (!held) return;
    const { el, anim, to } = held;
    held = null;
    const now = Number(getComputedStyle(el).scale) || to;
    anim.cancel();
    el.animate([{ scale: String(now) }, { scale: "1" }], { duration: release.duration, easing: release.easing });
  };

  const down = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    letGo();
    clearFlash();
    const row = cardRowTarget(event.target, root);
    if (row) {
      const state = { el: row, x: event.clientX, y: event.clientY, timer: 0, highlighted: false, cancelled: false };
      state.timer = window.setTimeout(() => {
        if (rowTouch !== state || state.cancelled) return;
        state.timer = 0;
        state.highlighted = true;
        row.dataset.rowHighlighted = "";
      }, ROW_HIGHLIGHT_DELAY_MS);
      rowTouch = state;
      return;
    }
    if (prefersReducedMotion()) return;
    const el = pressTarget(event.target, root);
    if (!el) return;
    const to = pressScale(el.getBoundingClientRect().width);
    const anim = el.animate([{ scale: "1" }, { scale: String(to) }], { duration: feel.press.inMs, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" });
    held = { el, anim, to };
  };

  const move = (event: PointerEvent) => {
    if (!rowTouch) return;
    if (Math.hypot(event.clientX - rowTouch.x, event.clientY - rowTouch.y) > ROW_SCROLL_SLOP_PX) {
      rowTouch.cancelled = true;
      cancelRow();
    }
  };

  const up = () => {
    if (rowTouch) {
      const state = rowTouch;
      rowTouch = null;
      if (state.timer) window.clearTimeout(state.timer);
      if (state.highlighted) {
        delete state.el.dataset.rowHighlighted;
      } else if (!state.cancelled) {
        clearFlash();
        flashing = state.el;
        state.el.dataset.rowHighlighted = "";
        flashTimer = window.setTimeout(() => {
          flashTimer = 0;
          if (flashing === state.el) { delete state.el.dataset.rowHighlighted; flashing = null; }
        }, ROW_TAP_FLASH_MS);
      }
    }
    letGo();
  };

  const onScroll = () => {
    if (rowTouch) rowTouch.cancelled = true;
    clearFlash();
    letGo();
  };

  root.addEventListener("pointerdown", down, { passive: true });
  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("pointerup", up, { passive: true });
  window.addEventListener("pointercancel", letGo, { passive: true });
  // a press that becomes a scroll, or a held row that opens a menu, lets go too
  root.addEventListener("scroll", onScroll, { passive: true, capture: true });
  root.addEventListener("dusk-press-release", letGo);
  return () => {
    clearFlash();
    letGo();
    root.removeEventListener("pointerdown", down);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", letGo);
    root.removeEventListener("scroll", onScroll, { capture: true });
    root.removeEventListener("dusk-press-release", letGo);
  };
}

/** Android answers a touch the Material way instead: a ripple spreads from the finger across the control (M3's
 * emphasized decelerate) and fades once it lets go. It paints in the control's own background (mobile.css), so nothing
 * round it moves or is clipped. */
export function installRipple(root: HTMLElement): () => void {
  const running = new WeakMap<HTMLElement, Animation[]>();
  let held: HTMLElement | null = null;

  const clear = (el: HTMLElement) => {
    for (const one of running.get(el) ?? []) one.cancel();
    running.delete(el);
    delete el.dataset.ripple;
  };

  const letGo = () => {
    const el = held;
    if (!el) return;
    held = null;
    const fade = el.animate([{ "--m-ripple-a": "1" }, { "--m-ripple-a": "0" }], { duration: 220, delay: 90, easing: "linear", fill: "forwards" });
    const list = [...(running.get(el) ?? []), fade];
    running.set(el, list);
    void fade.finished.then(() => { if (running.get(el) === list) clear(el); }, () => {});
  };

  const down = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    letGo();
    const el = pressTarget(event.target, root, OWN_RIPPLE);
    if (!el) return;
    clear(el);
    const box = el.getBoundingClientRect();
    const x = event.clientX - box.left, y = event.clientY - box.top;
    const reach = Math.hypot(Math.max(x, box.width - x), Math.max(y, box.height - y));
    el.style.setProperty("--m-rx", `${Math.round(x)}px`);
    el.style.setProperty("--m-ry", `${Math.round(y)}px`);
    el.dataset.ripple = "";
    running.set(el, [el.animate([{ "--m-ripple": "0px" }, { "--m-ripple": `${Math.ceil(reach)}px` }], {
      duration: prefersReducedMotion() ? 1 : 450, easing: "cubic-bezier(.05,.7,.1,1)", fill: "forwards",
    })]);
    held = el;
  };

  root.addEventListener("pointerdown", down, { passive: true });
  window.addEventListener("pointerup", letGo, { passive: true });
  window.addEventListener("pointercancel", letGo, { passive: true });
  root.addEventListener("scroll", letGo, { passive: true, capture: true });
  root.addEventListener("dusk-press-release", letGo);
  return () => {
    letGo();
    root.removeEventListener("pointerdown", down);
    window.removeEventListener("pointerup", letGo);
    window.removeEventListener("pointercancel", letGo);
    root.removeEventListener("scroll", letGo, { capture: true });
    root.removeEventListener("dusk-press-release", letGo);
  };
}
