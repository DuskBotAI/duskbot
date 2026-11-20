import { useLayoutEffect, useRef, type RefObject } from "react";
import { playGhostExit } from "@/lib/ghost-exit";
import { contentMove, feel, prefersReducedMotion } from "./motion";

const KEY = "data-flip-key";

/** Moves between two renders of a list: rows that changed place glide from where they were, rows that are new arrive
 * through a small blur, rows that are gone fade out where they were. Positions come from offsetTop, which a transform
 * on the page around the list (a push, a sheet stepping it back) does not change. Runs on `translate`, so a row's own
 * press scale is left alone. */
export function useListFlip(listRef: RefObject<HTMLElement | null>, signature: string): void {
  const last = useRef<{ signature: string; at: Map<string, number>; drawn: Map<string, Drawn> } | null>(null);
    useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // the same rows in the same order have not moved: reading every row's place forced the list's whole layout on each
    // render of the list (a chat opening over it re-renders it), so it is read only when the order changes
    if (last.current?.signature === signature) return;
    const rows = [...list.querySelectorAll<HTMLElement>(`[${KEY}]`)];
    // relative to the rows' own container: something above the list growing between renders is not a move
    const now = new Map(rows.map((row) => [row.getAttribute(KEY)!, row.offsetTop - (row.parentElement?.offsetTop ?? 0)]));
    const prev = last.current;
    last.current = { signature, at: now, drawn: new Map(rows.map((row) => [row.getAttribute(KEY)!, { row, top: row.offsetTop, left: row.offsetLeft, width: row.offsetWidth }])) };
    if (!prev || prev.signature === signature || prefersReducedMotion()) return;
    const before = prev.at;
    let entered = 0;
    for (const row of rows) {
      const key = row.getAttribute(KEY)!;
      const was = before.get(key);
      if (was === undefined) {
        row.animate(
          [{ opacity: 0, translate: `0 ${feel.enter.y}px` }, { opacity: 1, translate: "0 0" }],
          { duration: feel.enter.fade * 1000 + 60, delay: entered++ * feel.stagger * 1000, easing: "cubic-bezier(.22,1,.36,1)", fill: "backwards" },
        );
      } else if (Math.abs(was - now.get(key)!) > 0.5) {
        const delta = was - now.get(key)!;
        // added to any glide still running, so a second move mid-flight carries on from where the row is drawn
        const anim = row.animate([{ translate: `0 ${delta}px` }, { translate: "0 0" }], { duration: contentMove.ms, easing: contentMove.css, composite: "add" });
        // a row travelling past others rides over them on the page's own ground, so their text never crosses
        if (Math.abs(delta) > row.offsetHeight) {
          row.style.position = "relative";
          row.style.zIndex = "1";
          row.style.backgroundColor = "var(--color-app)";
          const settle = () => { row.style.position = ""; row.style.zIndex = ""; row.style.backgroundColor = ""; };
          anim.addEventListener("finish", settle);
          anim.addEventListener("cancel", settle);
        }
      }
    }
    const container = rows[0]?.parentElement ?? list;
    for (const [key, drawn] of prev.drawn) if (!now.has(key)) fadeOutGone(drawn, container);
  });
}

type Drawn = { row: HTMLElement; top: number; left: number; width: number };

/** A row the list no longer has fades out where it was drawn, as a copy laid over the list at its last place (offsets
 * from the same positioned ancestor the rows measure from), leaving quicker than rows arrive. */
function fadeOutGone({ row, top, left, width }: Drawn, container: HTMLElement): void {
  if (row.isConnected) return;
  playGhostExit(row, container, (ghost) => [ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: feel.exit.fade * 1000, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" })],
    (ghost) => { ghost.removeAttribute(KEY); Object.assign(ghost.style, { position: "absolute", top: `${top}px`, left: `${left}px`, width: `${width}px`, margin: "0" }); });
}

/** A list that has just replaced its loading placeholder fades up into place once. */
export function revealOnce(el: HTMLElement | null): void {
  if (!el || prefersReducedMotion()) return;
  el.animate([{ opacity: 0, translate: "0 6px" }, { opacity: 1, translate: "0 0" }], { duration: feel.enter.fade * 1000 + 80, easing: "cubic-bezier(.22,1,.36,1)" });
}
