import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Must equal Tailwind `gap-3` on the transcript stack. */
export const TRANSCRIPT_GAP = "0.75rem";

const FALLBACK_COMPOSER_PX = 64;

export function transcriptEndPad(composerHeightPx: number): string {
  const height = Number.isFinite(composerHeightPx)
    ? Math.max(0, Math.ceil(composerHeightPx))
    : FALLBACK_COMPOSER_PX;
  return `calc(${height}px + ${TRANSCRIPT_GAP})`;
}

/** The custom property the scroller carries with the composer's height on every frame of its spring. */
export const DOCK_VAR = "--composer-dock";
/** Marks an element inside the scroller whose own styles read DOCK_VAR. */
export const DOCK_PAD_ATTR = "data-dock-pad";

/** transcriptEndPad that reads the live height from DOCK_VAR, falling back to the measured one. */
export function followedEndPad(composerHeightPx: number): string {
  return transcriptEndPad(composerHeightPx).replace(/^calc\((\d+px)/, `calc(var(${DOCK_VAR}, $1)`);
}

/** The transcript's end inset. With `scroller` (read only when the composer moves, so it may name a ref made later), the
 * inset follows the composer frame by frame through DOCK_VAR and a transcript resting at its end stays there, so a sent
 * multi-line message rides down with the shrinking pill as grok's does instead of jumping once. The returned `pad` (and so any re-render keyed on it) still changes only once per spring. */
export function useComposerDockPad(ref: RefObject<HTMLElement | null>, scroller?: () => HTMLElement | null) {
  const [height, setHeight] = useState(0);
  const scrollerRef = useRef(scroller);
  scrollerRef.current = scroller;
  const follows = Boolean(scroller);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (mounting = false) => {
      const live = el.getBoundingClientRect().height;
      const view = scrollerRef.current?.();
      if (view) {
        // near the end counts: a banner that lands while the chat is still settling onto its last row must not cover it
        const atEnd = view.scrollTop >= view.scrollHeight - view.clientHeight - 24;
        const value = `${Math.max(0, Math.ceil(live))}px`;
        // DOCK_VAR does not inherit (styles.css registers it): it is set on the scroller and on each element padded by
        // it, so a frame of the composer's spring restyles those few, not every row under them
        for (const target of [view, ...view.querySelectorAll<HTMLElement>(`[${DOCK_PAD_ATTR}]`)]) {
          if (target.style.getPropertyValue(DOCK_VAR) !== value) target.style.setProperty(DOCK_VAR, value);
        }
        if (atEnd) view.scrollTop = view.scrollHeight;
      }
      // the pad reads DOCK_VAR already: a re-render here, in the mount's own commit, would build the whole chat twice
      // before its first frame; the observer's first call a moment later hands react the height
      if (mounting) return;
      // react keeps the height the pill is settling to, so it re-renders once instead of on every frame of the spring
      const pill = el.querySelector<HTMLElement>(".composer-pill");
      const settling = pill?.style.height ? parseFloat(pill.style.height) - pill.getBoundingClientRect().height : 0;
      setHeight(live + (Number.isFinite(settling) ? settling : 0));
    };
    apply(true);
    const observer = new ResizeObserver(() => apply());
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  const measured = height > 0 ? height : FALLBACK_COMPOSER_PX;
  return { pad: follows ? followedEndPad(measured) : transcriptEndPad(measured), height: measured };
}
