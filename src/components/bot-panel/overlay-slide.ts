import { EASE, REDUCED } from "@/lib/motion-presets";

/** The docked panel's own column transition (PanelSlot): 260 ms on the standard curve. */
const SLIDE = { duration: 0.26, ease: EASE.standard };

/** The bot panel lying over the chat when the window is too narrow to dock it: it slides in from the right edge over
 * its dimmed chat and back out the same way, or fades with reduced motion. A panel handed over to another bot's
 * (AnimatePresence custom true) leaves at once, and the one taking over (slideIn false) is already in place. */
export function overlaySlide(reduced: boolean, slideIn: boolean) {
  const out = reduced ? { opacity: 0 } : { transform: "translateX(100%)" };
  const rest = reduced ? { opacity: 1 } : { transform: "translateX(0%)" };
  const timing = reduced ? REDUCED : SLIDE;
  return {
    panel: {
      variants: {
        out: (swapped: boolean) => ({ ...out, transition: swapped ? { duration: 0 } : timing }),
        rest: { ...rest, transition: timing },
      },
      initial: slideIn ? "out" : false,
      animate: "rest",
      exit: "out",
    },
    scrim: {
      variants: {
        out: (swapped: boolean) => ({ opacity: 0, transition: swapped ? { duration: 0 } : timing }),
        rest: { opacity: 1, transition: timing },
      },
      initial: slideIn ? "out" : false,
      animate: "rest",
      exit: "out",
    },
  } as const;
}
