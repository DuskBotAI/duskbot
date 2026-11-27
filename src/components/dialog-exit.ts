import { useLayoutEffect, useRef } from "react";
import { cssCurve, desktopMotion } from "@/lib/desktop-motion";
import { motionReduced, playGhostExit } from "@/lib/ghost-exit";
import { pacedMs } from "@/lib/motion-speed";

/** A dialog that unmounts at once leaves as the desktop pick's dialogs do, on a copy: spread the ref on its scrim, `box`
 * selects the dialog inside it. */
export function useDialogExit<T extends HTMLElement>(box: string) {
  const scrim = useRef<T>(null);
  useLayoutEffect(() => {
    const el = scrim.current;
    // A dialog gone before its first frame was never on screen, so it has no way out to play. React's StrictMode
    // unmounts and mounts every component once in development, and a full-dim copy then flashed over the opening one.
    let painted = false;
    const frame = requestAnimationFrame(() => { painted = true; });
    return () => {
      cancelAnimationFrame(frame);
      const motion = desktopMotion();
      if (!painted || motion.pick === "a" || !el || motionReduced()) return;
      const { leave } = motion.dialog;
      // checked once the commit is done, when a dialog taking over (Templates from Connect apps) is in the page: it
      // keeps the dim up in place, and this one's copy fading over it would stack a second dim and a second window
      queueMicrotask(() => {
        if (document.querySelector("[data-handoff]")) return;
        playGhostExit(el, document.body, (ghost) => {
          const timing = { duration: pacedMs(leave.ms), easing: cssCurve(null), fill: "forwards" as const };
          const dialog = ghost.querySelector(box);
          return [
            ghost.animate([{ opacity: 1 }, { opacity: 0 }], timing),
            dialog?.animate([{ transform: "none" }, { transform: `translateY(${leave.y}px) scale(${leave.scale})` }], timing),
          ].filter((run): run is Animation => Boolean(run));
        });
      });
    };
  }, [box]);
  return scrim;
}
