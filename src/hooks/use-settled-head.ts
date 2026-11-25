import { useLayoutEffect, useRef, useState } from "react";
import { motionReduced } from "@/lib/ghost-exit";

/** Under this width (30rem) the chat header puts the bot's name on the left with its actions under it. */
const NARROW_REM = 30;
const GLIDE_MS = 260;

/**
 * The chat header's layout, chosen for the width the chat settles at rather than the width it passes through: when the
 * bot's panel opens or closes, its column slides to the width it already set on itself, so the header picks its layout
 * once, as the slide starts, and the name glides straight to its new place instead of re-centring and then jumping.
 */
export function useSettledHead(phone: boolean) {
  const headRef = useRef<HTMLDivElement>(null);
  const identityRef = useRef<HTMLDivElement>(null);
  const [narrowHead, setNarrowHead] = useState(false);
  const narrow = useRef(false);
  const glideFrom = useRef<number | null>(null);

  useLayoutEffect(() => {
    const head = headRef.current;
    if (!head || phone || typeof ResizeObserver === "undefined") return;
    const settle = () => {
      const style = getComputedStyle(head);
      const inner = head.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      // the panel's column holds its destination in its inline width while it slides there
      const slot = document.querySelector<HTMLElement>("[data-panel-slot]");
      const still = slot ? slot.getBoundingClientRect().width - (parseFloat(slot.style.width) || 0) : 0;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const next = Math.round(inner + still) < NARROW_REM * rem;
      if (next === narrow.current) return;
      narrow.current = next;
      glideFrom.current = identityRef.current?.getBoundingClientRect().left ?? null;
      setNarrowHead(next);
    };
    settle();
    const watch = new ResizeObserver(settle);
    watch.observe(head);
    const slot = document.querySelector("[data-panel-slot]");
    // the slot's width is set a frame before the chat starts to move: read the destination the moment it is set
    const marks = slot ? new MutationObserver(settle) : null;
    if (slot) marks?.observe(slot, { attributes: true, attributeFilter: ["style"] });
    return () => { watch.disconnect(); marks?.disconnect(); };
  }, [phone]);

  // the new layout is in place before this frame paints: draw the name from where it was and ease it home
  useLayoutEffect(() => {
    const el = identityRef.current, from = glideFrom.current;
    glideFrom.current = null;
    if (!el || from === null || motionReduced()) return;
    const dx = from - el.getBoundingClientRect().left;
    if (Math.abs(dx) > 1) el.animate([{ translate: `${dx}px 0` }, { translate: "0 0" }], { duration: GLIDE_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" });
  }, [narrowHead]);

  return { headRef, identityRef, narrowHead };
}

/** The header's two layouts: a three-column row with the name in the middle, or (narrow) the name over its controls. */
export const HEAD_LAYOUT = {
  wide: { row: "grid grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(max-content,1fr)]", identity: "col-start-2 justify-self-center", controls: "col-start-3 justify-self-end" },
  narrow: { row: "flex-wrap gap-y-1", identity: "basis-full", controls: "ml-auto flex-wrap justify-end" },
} as const;
