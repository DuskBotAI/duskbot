import { useLayoutEffect, useRef, type ReactNode } from "react";
import { reducedMotion } from "@/lib/onboarding";
import { cssBezier, pacedInOut, pacedMs, pacedOut } from "@/lib/motion-speed";

/** How a card above the composer comes and goes, so the composer and the chat never jump. It comes in with a fade and a
 * short rise, the slot's height following; it leaves by fading where it is while the slot's height collapses under it,
 * on an ease-in-out, and the chat rides that collapse. */
export const NOTICE_MOTION = {
  enterMs: pacedMs(220),
  fadeOutMs: pacedMs(140),
  collapseMs: pacedMs(200),
  rise: 6,
  ease: cssBezier(pacedOut([0.22, 1, 0.36, 1])),
  collapseEase: cssBezier(pacedInOut([0.645, 0.045, 0.355, 1])),
} as const;

const canAnimate = (node: Element) => typeof (node as HTMLElement).animate === "function";

/** Every card above the composer sits in one of this slot's rows (a direct child that stays mounted); a card a row stops
 * rendering is kept, out of React's tree, until its exit has played. */
export function ComposerNoticeSlot({ children, className }: { children: ReactNode; className?: string }) {
  const outer = useRef<HTMLDivElement | null>(null);
  const inner = useRef<HTMLDivElement | null>(null);
  const ghosts = useRef<HTMLDivElement | null>(null);
  const height = useRef<number | null>(null);

  useLayoutEffect(() => {
    const box = outer.current, rows = inner.current, layer = ghosts.current;
    if (!box || !rows || !layer) return;
    height.current = rows.offsetHeight;
    const follow = () => {
      const was = height.current, now = rows.offsetHeight;
      height.current = now;
      if (was === null || was === now || reducedMotion() || !canAnimate(box)) return;
      box.style.overflow = "hidden";
      const run = box.animate([{ height: `${was}px` }, { height: `${now}px` }], now > was
        ? { duration: NOTICE_MOTION.enterMs, easing: NOTICE_MOTION.ease }
        : { duration: NOTICE_MOTION.collapseMs, easing: NOTICE_MOTION.collapseEase });
      run.onfinish = run.oncancel = () => { box.style.overflow = ""; };
    };
    const observer = new MutationObserver((records) => {
      const reduced = reducedMotion();
      for (const record of records) {
        // only a card's own root, the direct child of a row
        if (!(record.target instanceof HTMLElement) || record.target.parentElement !== rows) continue;
        const swapped = [...record.addedNodes].some((node) => node instanceof HTMLElement);
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement) || !canAnimate(node)) continue;
          node.animate(reduced ? [{ opacity: 0 }, { opacity: 1 }]
            : [{ opacity: 0, transform: `translateY(${NOTICE_MOTION.rise}px)` }, { opacity: 1, transform: "none" }],
          { duration: NOTICE_MOTION.enterMs, easing: NOTICE_MOTION.ease });
        }
        // a card swapped for another in the same row only crossfades: the new one's entrance covers it
        if (swapped) continue;
        for (const node of record.removedNodes) {
          if (!(node instanceof HTMLElement) || !canAnimate(node)) continue;
          const top = record.target.offsetTop;
          node.dataset.noticeLeaving = "";
          Object.assign(node.style, { position: "absolute", left: "0", right: "0", top: `${top}px`, pointerEvents: "none" });
          node.setAttribute("aria-hidden", "true");
          layer.appendChild(node);
          const fade = node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: NOTICE_MOTION.fadeOutMs, easing: NOTICE_MOTION.ease, fill: "forwards" });
          fade.onfinish = fade.oncancel = () => node.remove();
        }
      }
      follow();
    });
    observer.observe(rows, { childList: true, subtree: true });
    const resized = typeof ResizeObserver === "function" ? new ResizeObserver(follow) : null;
    resized?.observe(rows);
    return () => { observer.disconnect(); resized?.disconnect(); };
  }, []);

  return (
    <div ref={outer} data-composer-notices="" className={`relative ${className ?? ""}`}>
      <div ref={inner}>{children}</div>
      <div ref={ghosts} aria-hidden="true" className="pointer-events-none absolute inset-0" />
    </div>
  );
}
