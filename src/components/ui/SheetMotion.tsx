import { isMotionValue, motion, useIsPresent, useReducedMotion, type HTMLMotionProps } from "motion/react";
import { dialogMotion } from "@/lib/motion-presets";


/** The app's reduced-motion choice or the system's. */
export function useMotionReduced(): boolean {
  const system = useReducedMotion();
  return Boolean(system) || (typeof document !== "undefined" && document.documentElement?.dataset?.reducedMotion === "true");
}

const MOTION_PROPS = ["initial", "animate", "exit", "transition", "variants", "custom", "whileTap", "whileHover", "onAnimationComplete"] as const;

/** motion measures and listens on a real window; rendered to a string there is none, so the element draws at rest. */
const live = () => typeof window !== "undefined" && typeof window.addEventListener === "function";

function rest<P extends object>(props: P): P {
  const plain = { ...props } as Record<string, unknown>;
  for (const key of MOTION_PROPS) delete plain[key];
  return plain as P;
}

/** A motion div where there is a window to animate in, a plain div at rest elsewhere. */
export function MotionDiv(props: HTMLMotionProps<"div">) {
  return live() ? <motion.div {...props} /> : <div {...(rest(props) as React.HTMLAttributes<HTMLDivElement>)} />;
}

/** A motion span where there is a window, a plain span at rest elsewhere (motion values in its style read once). */
export function MotionSpan(props: HTMLMotionProps<"span">) {
  if (live()) return <motion.span {...props} />;
  const plain = rest(props) as React.HTMLAttributes<HTMLSpanElement> & { style?: Record<string, unknown> };
  const style = plain.style ? Object.fromEntries(Object.entries(plain.style).map(([key, value]) => [key, isMotionValue(value) ? value.get() : value])) : undefined;
  return <span {...plain} style={style as React.CSSProperties} />;
}

/** A centered sheet's own box. It opens with the app's one dialog motion, from overlays.css on its aria-modal role. */
export function SheetMotion(props: HTMLMotionProps<"div">) {
  return <MotionDiv initial={false} {...props} />;
}

/** The dimmed backdrop behind a sheet; overlays.css fades it in. */
export function ScrimMotion(props: HTMLMotionProps<"div">) {
  return <MotionDiv initial={false} {...props} />;
}

/** A centred sheet's motion both ways: spread `layer` on its fixed layer, `scrim` on the dim behind (a ScrimMotion, or the
 * layer itself when the layer is the dim) and `sheet` on its box (a SheetMotion). Inside its parent's AnimatePresence it
 * plays its way out and takes no presses or focus meanwhile. */
export function useDialogMotion() {
  const motion = dialogMotion(useMotionReduced());
  const leaving = !useIsPresent();
  return {
    layer: { inert: leaving || undefined, "data-leaving": leaving ? "" : undefined },
    scrim: { ...motion.scrim, "data-raw-dialog": "" },
    sheet: { ...motion.sheet, "data-raw-dialog": "" },
  };
}

/** A centred sheet's dim that is also its layer, playing the dialog motion both ways. */
export function DialogScrimLayer(props: HTMLMotionProps<"div">) {
  const played = useDialogMotion();
  return <ScrimMotion {...played.layer} {...played.scrim} {...props} />;
}

/** A centred sheet's box, playing the dialog motion both ways. */
export function DialogSheet(props: HTMLMotionProps<"div">) {
  const played = useDialogMotion();
  return <SheetMotion {...played.sheet} {...props} />;
}
