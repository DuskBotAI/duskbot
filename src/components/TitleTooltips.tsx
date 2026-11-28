import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { EASE_OUT, REDUCED, SPRING, TOOLTIP } from "@/lib/motion-presets";
import { useStretch } from "@/lib/use-stretch";
import { useMotionReduced } from "./ui/SheetMotion";

/** Tooltip timing: 400ms on a first hover; leaving holds it 140ms, then it fades out over 100ms. A trigger reached while
 * one is still up (or within 300ms of one closing) shows at once, as does one reached by keyboard. The first one grows
 * out of its trigger; moving along a row of controls, the same tooltip travels and resizes (its edges stretch) while
 * its words slide the way the pointer went. */
export const TOOLTIP_DELAY_MS = TOOLTIP.openDelay;
const TOOLTIP_CLOSE_DELAY_MS = TOOLTIP.closeDelay;
const TOOLTIP_EXIT_MS = TOOLTIP.exit;
const GAP = 8;
const EDGE = 8;
const TOOLTIP_ID = "app-title-tooltip";
const TRIGGERS = "[title], [data-tip-title], [data-tip-clipped]";

interface Tip { el: HTMLElement; text: string; instant: boolean; ending?: boolean }

/**
 * Draws every native `title` as Grok's tooltip instead of the system one. While a trigger is hovered or focused its
 * title moves to `data-tip-title` (so the system tooltip stays away) and comes back when it closes; an icon-only
 * control keeps its name through a temporary aria-label. A `data-tip-clipped` text shows only while the element's own
 * text is cut short, so a truncated label always has a way to its full text. Mounted once beside the app.
 */
export function TitleTooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number; width: number; side: Side; single: boolean; text: string; originX: number; travel: boolean; dir: number; key: number } | null>(null);

  useEffect(() => {
    let pending: { el: HTMLElement; timer: number } | null = null;
    let shown: HTMLElement | null = null;
    let closing = 0;
    let ending = 0;
    let poll = 0;
    let cooled = 0;
    const strip = (el: HTMLElement): string | null => {
      const clipped = el.dataset.tipClipped;
      if (clipped != null) {
        if (!clipped.trim()) return null;
        el.dataset.tipTitle = clipped;
        return clipped;
      }
      const title = el.getAttribute("title");
      if (title == null) return el.dataset.tipTitle ?? null;
      if (!title.trim()) return null;
      el.dataset.tipTitle = title;
      el.removeAttribute("title");
      if (!el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby") && !el.textContent?.trim()) {
        el.setAttribute("aria-label", title);
        el.dataset.tipLabel = "";
      }
      return title;
    };
    const restore = (el: HTMLElement) => {
      const title = el.dataset.tipTitle;
      if (title == null) return;
      if (!el.hasAttribute("title") && el.dataset.tipClipped == null) el.setAttribute("title", title);
      if ("tipLabel" in el.dataset) { el.removeAttribute("aria-label"); delete el.dataset.tipLabel; }
      if (el.getAttribute("aria-describedby") === TOOLTIP_ID) el.removeAttribute("aria-describedby");
      delete el.dataset.tipTitle;
    };
    const cancel = () => {
      if (pending) { window.clearTimeout(pending.timer); restore(pending.el); pending = null; }
    };
    const stopClosing = () => {
      window.clearTimeout(closing); closing = 0;
      window.clearTimeout(ending); ending = 0;
    };
    // gone now: scroll, blur, a trigger that left the page, or a newer tooltip taking over
    const hide = () => {
      cancel();
      stopClosing();
      window.clearInterval(poll);
      if (shown) { restore(shown); shown = null; cooled = performance.now(); }
      setTip(null);
    };
    // Grok's close: the tip fades out from where it is, and a trigger reached meanwhile still opens at once
    const fade = () => {
      if (!shown) return;
      window.clearTimeout(closing); closing = 0;
      if (ending) return;
      setTip((current) => (current ? { ...current, ending: true } : current));
      ending = window.setTimeout(hide, TOOLTIP_EXIT_MS);
    };
    const leave = () => {
      cancel();
      if (!shown || closing || ending) return;
      closing = window.setTimeout(fade, TOOLTIP_CLOSE_DELAY_MS);
    };
    const show = (el: HTMLElement, instant: boolean) => {
      const text = el.dataset.tipTitle;
      if (!text || !el.isConnected) return;
      shown = el;
      if (!el.hasAttribute("aria-describedby")) el.setAttribute("aria-describedby", TOOLTIP_ID);
      setTip({ el, text, instant });
      window.clearInterval(poll);
      // a trigger that unmounts under the pointer sends no pointerout
      poll = window.setInterval(() => { if (!el.isConnected) hide(); }, 250);
    };
    const arm = (el: HTMLElement, keyboard = false) => {
      if (shown === el) {
        // back on the trigger before it finished closing: keep it
        if (closing) { window.clearTimeout(closing); closing = 0; }
        if (ending) { stopClosing(); setTip((current) => (current ? { ...current, ending: false, instant: true } : current)); }
        return;
      }
      if (pending?.el === el) return;
      const warm = shown !== null || performance.now() - cooled < TOOLTIP.warm;
      hide();
      if (strip(el) == null) return;
      if (warm || keyboard) { show(el, true); return; }
      pending = { el, timer: window.setTimeout(() => { pending = null; show(el, false); }, TOOLTIP_DELAY_MS) };
    };
    // a label that fits passes the hover on to a titled control around it
    const trigger = (target: EventTarget | null): HTMLElement | null => {
      let el = target instanceof Element ? target.closest<HTMLElement>(TRIGGERS) : null;
      while (el && el.dataset.tipClipped != null && el.scrollWidth <= el.clientWidth) el = el.parentElement?.closest<HTMLElement>(TRIGGERS) ?? null;
      return el;
    };

    const onOver = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const el = trigger(event.target);
      if (el && el !== document.body && el !== document.documentElement) arm(el);
    };
    const onOut = (event: PointerEvent) => {
      const el = shown ?? pending?.el;
      if (!el) return;
      const next = event.relatedTarget;
      if (next instanceof Node && el.contains(next)) return;
      leave();
    };
    const onFocusIn = (event: FocusEvent) => {
      const el = trigger(event.target);
      if (el && el === event.target && el.matches(":focus-visible")) arm(el, true);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && (shown || pending)) { cancel(); fade(); } };
    const onPress = () => { cancel(); fade(); };
    const onFocusOut = () => { cancel(); if (shown && !closing && !ending) fade(); };

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      hide();
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // below the trigger and centred on it, above when there is no room, held 8px inside the window. Measured on a hidden
  // copy, since the shown one may be mid-stretch.
  const reduced = useMotionReduced();
  const measureRef = useRef<HTMLDivElement>(null);
  const last = useRef<{ el: HTMLElement; left: number; top: number; side: Side; single: boolean } | null>(null);
  const anchorEl = tip?.el;
  const anchorText = tip?.text;
  useLayoutEffect(() => {
    if (!tip || !measureRef.current) { setPlace(null); last.current = null; return; }
    const anchor = tip.el.getBoundingClientRect();
    const box = measureRef.current.getBoundingClientRect();
    const below = anchor.bottom + GAP + box.height <= window.innerHeight - EDGE;
    const top = below ? anchor.bottom + GAP : Math.max(EDGE, anchor.top - GAP - box.height);
    const left = Math.min(Math.max(EDGE, anchor.left + anchor.width / 2 - box.width / 2), window.innerWidth - EDGE - box.width);
    const side: Side = below ? "bottom" : "top";
    const single = box.height <= 28;
    // a warm move to a neighbour on the same line travels; anything else (another row, the far side of the window,
    // a wrapped tip, reduced motion) just appears there
    const prev = last.current;
    const travel = Boolean(prev && tip.instant && !reduced && prev.el !== tip.el && prev.side === side && prev.single && single
      && Math.abs(prev.top - top) < 4 && Math.abs(prev.left - left) < 400);
    last.current = { el: tip.el, left, top, side, single };
    setPlace((was) => ({ left, top, width: box.width, side, single, text: tip.text, originX: anchor.left + anchor.width / 2 - left,
      travel, dir: prev && left < prev.left ? -1 : 1, key: (was?.key ?? 0) + 1 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorEl, anchorText]);
  const edges = useStretch(place ? { start: place.left, end: place.left + place.width } : null, !place?.travel);

  if (!tip) return null;
  const words = { travel: place?.travel ?? false, dir: place?.dir ?? 1 };
  return createPortal(
    <>
      <div ref={measureRef} aria-hidden="true" className="ui-tooltip" style={{ left: 0, top: 0, visibility: "hidden" }}>{tip.text}</div>
      <motion.div
        id={TOOLTIP_ID}
        role="tooltip"
        data-side={place?.side ?? "bottom"}
        data-instant={tip.instant ? "" : undefined}
        data-ending={tip.ending ? "" : undefined}
        className="ui-tooltip overflow-hidden"
        style={place ? {
          left: edges.start,
          top: place.top,
          width: edges.size,
          textAlign: place.single ? "center" : undefined,
          whiteSpace: place.single ? "nowrap" : undefined,
          transformOrigin: `${Math.round(place.originX)}px ${place.side === "bottom" ? "-6px" : "calc(100% + 6px)"}`,
        } : { left: 0, top: 0, visibility: "hidden" }}
        initial={tip.instant ? false : reduced ? { opacity: 0 } : { opacity: 0, scale: 0.92 }}
        animate={tip.ending
          ? { opacity: 0, transition: { duration: TOOLTIP.exit / 1000, ease: EASE_OUT } }
          : { opacity: 1, scale: 1, transition: reduced ? REDUCED : { ...SPRING.fade, opacity: { duration: 0.15, ease: EASE_OUT } } }}
      >
        <AnimatePresence initial={false} mode="popLayout" custom={words}>
          <motion.span key={place?.key ?? 0} className="block" custom={words} variants={WORDS} initial="enter" animate="center" exit="exit">
            {place?.text ?? tip.text}
          </motion.span>
        </AnimatePresence>
      </motion.div>
    </>,
    document.body,
  );
}

type Side = "top" | "bottom";

/** the words of a travelling tooltip slide 14px the way it went, through a 3px blur; otherwise they just change */
const WORDS = {
  enter: ({ travel, dir }: { travel: boolean; dir: number }) => (travel ? { opacity: 0, x: dir * 14, filter: "blur(3px)" } : { opacity: 1, x: 0, filter: "blur(0px)" }),
  center: { opacity: 1, x: 0, filter: "blur(0px)", transition: SPRING.fade },
  exit: ({ travel, dir }: { travel: boolean; dir: number }) => (travel
    ? { opacity: 0, x: dir * -10, filter: "blur(3px)", transition: { duration: 0.12, ease: EASE_OUT } }
    : { opacity: 0, transition: { duration: 0 } }),
};
