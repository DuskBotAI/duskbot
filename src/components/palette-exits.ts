import { useLayoutEffect, useRef } from "react";
import { cssCurve, desktopMotion } from "@/lib/desktop-motion";
import { motionReduced, playGhostExit } from "@/lib/ghost-exit";
import { pacedMs } from "@/lib/motion-speed";

/** The palette's way out at a desktop pick that has one: the palette fades from where it is when it closes, and a row a
 * new query drops fades where it stood. Spread `wrap` on the palette's layer and `list` on its rows' column; each row
 * carries its key in data-palette-row. */
export function usePaletteExits(open: boolean) {
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const lastWrap = useRef<HTMLDivElement | null>(null);
  const rows = useRef(new Map<string, { el: HTMLElement; top: number }>());

  useLayoutEffect(() => {
    if (!open) { rows.current.clear(); return; }
    lastWrap.current = wrap.current;
    const { rowsMs } = desktopMotion().palette;
    const column = list.current;
    if (!rowsMs) return;
    const now = new Map<string, { el: HTMLElement; top: number }>();
    for (const el of column?.querySelectorAll<HTMLElement>(":scope > [data-palette-row]") ?? []) now.set(el.dataset.paletteRow ?? "", { el, top: el.offsetTop });
    if (column && !motionReduced()) {
      for (const [key, was] of rows.current) {
        if (now.has(key)) continue;
        playGhostExit(was.el, column, (ghost) => [ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: pacedMs(rowsMs), easing: cssCurve(null), fill: "forwards" })], (ghost) => {
          ghost.style.position = "absolute";
          ghost.style.top = `${was.top}px`;
          ghost.style.insetInline = "8px";
          ghost.style.width = "auto";
        });
      }
    }
    rows.current = now;
  });

  useLayoutEffect(() => {
    if (!open) return;
    return () => {
      const leave = desktopMotion().palette.leave;
      const el = lastWrap.current;
      if (!leave || !el || motionReduced()) return;
      const typed = [...el.querySelectorAll("input")].map((input) => input.value);
      playGhostExit(el, document.body, (ghost) => {
        const timing = { duration: pacedMs(leave.ms), easing: cssCurve(null), fill: "forwards" as const };
        const box = ghost.querySelector("[data-command-palette]");
        const dim = ghost.querySelector(".palette-scrim");
        return [
          box?.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateY(${leave.y}px) scale(${leave.scale})` }], timing),
          dim?.animate([{ opacity: 1 }, { opacity: 0 }], timing),
        ].filter((run): run is Animation => Boolean(run));
      }, (ghost) => ghost.querySelectorAll("input").forEach((input, i) => { input.value = typed[i] ?? ""; }));
    };
  }, [open]);

  return { wrap, list };
}
