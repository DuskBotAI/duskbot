import { useLayoutEffect, useRef, type RefObject } from "react";
import { cssCurve, desktopMotion } from "@/lib/desktop-motion";
import { motionReduced } from "@/lib/ghost-exit";
import { pacedMs } from "@/lib/motion-speed";

/** Another chat opened in the same view: at a desktop pick that has one, its transcript comes in on that motion. It moves
 * with `translate`, so the transforms the transcript's own flow sets stay its own. */
export function useChatSwitchMotion(ref: RefObject<HTMLElement | null>, chat: string): void {
  const shown = useRef(chat);
  useLayoutEffect(() => {
    if (shown.current === chat) return;
    shown.current = chat;
    const swap = desktopMotion().chatSwitch;
    const el = ref.current;
    if (!swap || !el || typeof el.animate !== "function" || motionReduced()) return;
    const run = el.animate(
      [{ opacity: swap.from, translate: `0 ${swap.y}px` }, { opacity: 1, translate: "0 0" }],
      { duration: pacedMs(swap.ms), easing: cssCurve(null) },
    );
    return () => run.cancel();
  }, [chat, ref]);
}
