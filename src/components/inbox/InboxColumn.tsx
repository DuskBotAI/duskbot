import type { ReactNode } from "react";
import { motion, useIsPresent } from "motion/react";
import { EASE, REDUCED } from "@/lib/motion-presets";
import { useMotionReduced } from "../ui/SheetMotion";

/** The docked bot panel's column transition (PanelSlot): 260 ms on the standard curve. */
const GROW = { duration: 0.26, ease: EASE.standard };

/** The inbox's column beside the chat, inside its parent's AnimatePresence: it grows from nothing at the window's right
 * edge and back, so the chat reflows across it instead of jumping, and the panel rides its left edge in from the right.
 * Reduced motion fades it at its full width. */
export function InboxColumn({ children }: { children: ReactNode }) {
  const reduced = useMotionReduced();
  const leaving = !useIsPresent();
  const motionProps = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1, transition: REDUCED }, exit: { opacity: 0, transition: REDUCED } }
    : { initial: { width: 0 }, animate: { width: "auto", transition: GROW }, exit: { width: 0, transition: GROW } };
  return (
    <motion.div {...motionProps} data-inbox-column={leaving ? "closing" : "open"} inert={leaving || undefined}
      className="relative flex h-full shrink-0 overflow-hidden max-md:contents">
      {children}
    </motion.div>
  );
}
