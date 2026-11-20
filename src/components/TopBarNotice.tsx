import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import { desktopMotion } from "@/lib/desktop-motion";
import { EASE_OUT } from "@/lib/motion-presets";
import { pacedOut, pacedSeconds } from "@/lib/motion-speed";
import { useCaptionChrome } from "./DesktopCapabilities";
import { MotionDiv, useMotionReduced } from "./ui/SheetMotion";

export const TOP_BAR_PILL = "flex h-[41px] min-w-0 max-w-full items-center gap-1.5 rounded-full border-[0.5px] border-transparent bg-composer py-[7.5px] pl-3.5 pr-[7.5px] text-[13px] font-medium leading-5 text-ink shadow-(--shadow-float)";
export const TOP_BAR_PILL_CLOSE = "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink/68 transition-[background-color,color] duration-[120ms] ease-[ease] hover:bg-ink/6 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus";

function noticeMotion(reduced: boolean) {
  const { menu } = desktopMotion();
  const ease = pacedOut(EASE_OUT);
  if (reduced) return { initial: { opacity: 0 }, animate: { opacity: 1, transition: { duration: pacedSeconds(menu.enter.ms / 1000), ease } }, exit: { opacity: 0, transition: { duration: pacedSeconds(menu.leave.ms / 1000), ease } } };
  return {
    initial: { opacity: 0, transform: `scale(${menu.enter.scale})` },
    animate: { opacity: 1, transform: "scale(1)", transition: { duration: pacedSeconds(menu.enter.ms / 1000), ease } },
    exit: { opacity: 0, transform: `scale(${menu.leave.scale})`, transition: { duration: pacedSeconds(menu.leave.ms / 1000), ease } },
  };
}

export function TopBarNotice({ noticeKey, children }: { noticeKey: string | null; children?: ReactNode }) {
  const { noDragStyle } = useCaptionChrome();
  const reduced = useMotionReduced();
  const motionProps = noticeMotion(reduced);
  return createPortal(
    <div data-topbar-notice-frame="" className="topbar-notice-frame pointer-events-none fixed z-[28] @container/topnotice">
      <div className="flex justify-center px-5 pt-[66px] @min-[57rem]/topnotice:justify-start @min-[57rem]/topnotice:pt-2.5">
        <AnimatePresence>
          {noticeKey && <MotionDiv key={noticeKey} {...motionProps}
            className="pointer-events-auto flex min-w-0 max-w-full origin-left @max-[57rem]/topnotice:origin-top @min-[57rem]/topnotice:max-w-[calc(50%-170px)]"
            style={noDragStyle}>
            {children}
          </MotionDiv>}
        </AnimatePresence>
      </div>
    </div>,
    document.body,
  );
}
