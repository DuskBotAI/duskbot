// The first-run funnel's frame (back, progress, a step that arrives piece by piece) and its hello.
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { ChevronLeft } from "../../icons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { MausAvatar } from "../Avatar";
import { usePrefersReducedMotion } from "../mascot-clock";
import { Art, type ArtName } from "../ui/Art";
import { PlaceArt, type PlaceArtName } from "../ui/PlaceArt";
import { DEFAULT_BOT_NAME } from "@/lib/default-bot";
import { MAC_TRAFFIC_LIGHT_CLEAR_X, useDesktopCapabilities } from "../DesktopCapabilities";

export const PRIMARY = "ui-button ui-button-pill ui-button-lg ui-button-primary w-[288px] max-w-full font-normal tracking-[0.14px]";
/** The quiet way past a step that still reads as a button: a soft fill, no outline. */
export const SECONDARY = "ui-button ui-button-pill ui-button-lg w-[288px] max-w-full font-normal tracking-[0.14px]";
export const QUIET = "min-h-11 rounded-full px-3 text-[13px] leading-[18px] text-ink-secondary transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none";
/** A tonal choice: a soft fill, no outline, a deeper fill on hover and while chosen. */
export const TILE = "rounded-2xl bg-ink/[0.035] transition-[background-color,transform] duration-150 ease-[ease] hover:bg-ink/[0.06] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none motion-reduce:active:scale-100";

// the brand's lilac, a shade deeper than the pastel so the mark reads on the light canvas
export const BRAND_LILAC: [string, string, string] = ["#d0cefb", "#b99af2", "#d0cefb"];

/** Back, and how far along the setup is, over every step but the first. */
export function FunnelBar({ at, count, onBack }: { at: number; count: number; onBack: (() => void) | null }) {
  // on macOS Back starts clear of the traffic lights, which sit over the window's top left corner (the rail beside the
  // page, when there is one, already holds them)
  const lights = useDesktopCapabilities().capabilities.windowChrome === "mac-inset";
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-14 items-center justify-center px-4">
      {onBack && (
        <button type="button" data-funnel-back={lights ? "clear-of-traffic-lights" : ""} onClick={onBack}
          style={lights ? { left: `max(16px, calc(${MAC_TRAFFIC_LIGHT_CLEAR_X}px - var(--rail-beside, 0px)))` } : undefined}
          className="pointer-events-auto absolute start-4 inline-flex min-h-11 items-center gap-0.5 rounded-full py-1 pe-3 ps-1.5 text-[13px] leading-[18px] text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none">
          <ChevronLeft size={16} strokeWidth={1.5} aria-hidden="true" className="rtl:-scale-x-100" />{t("funnel.back")}
        </button>
      )}
      <div role="progressbar" aria-label={t("funnel.progress")} aria-valuemin={1} aria-valuemax={count} aria-valuenow={at + 1}
        aria-valuetext={t("funnel.progressAt", { at: String(at + 1), count: String(count) })} data-funnel-progress={`${at + 1}/${count}`}
        className="relative flex items-center gap-1.5">
        {Array.from({ length: count }, (_, index) => (
          <span key={index} aria-hidden="true" className={cn("h-1 rounded-full bg-ink/12", index === at ? "w-6" : "w-3")} />
        ))}
        <ProgressInk at={at} />
      </div>
    </div>
  );
}

// the funnel's own springs (motion brief 2026-11): the stretchy pill's two edges, the done fill, the page cascade
const LEAD = { type: "spring", stiffness: 620, damping: 36 } as const;
const TRAIL = { type: "spring", stiffness: 190, damping: 19 } as const;
const SOFT = { type: "spring", stiffness: 260, damping: 24 } as const;
const DOT = 12, GAP = 6, WIDE = 24;

/** The progress drawn over the dots: the steps behind fill in, and the current one is an ink pill that stretches to its
 * new dot, the edge facing the move quick and the other catching up. Logical offsets, so it runs the right way in RTL. */
export function ProgressInk({ at }: { at: number }) {
  const reduced = useReducedMotion() === true;
  const start = at * (DOT + GAP);
  const from = useMotionValue(start), to = useMotionValue(start + WIDE), done = useMotionValue(Math.max(0, start - GAP));
  const first = useRef(true);
  useLayoutEffect(() => {
    const end = start + WIDE, fill = Math.max(0, start - GAP);
    if (first.current || reduced) { from.set(start); to.set(end); done.set(fill); first.current = false; return; }
    const forward = start >= from.get();
    const moves = [animate(from, start, forward ? TRAIL : LEAD), animate(to, end, forward ? LEAD : TRAIL), animate(done, fill, SOFT)];
    return () => moves.forEach((move) => move.stop());
  }, [start, reduced, from, to, done]);
  const inset = useTransform(from, (v) => `${v}px`);
  const width = useTransform(() => `${Math.max(0, to.get() - from.get())}px`);
  const doneWidth = useTransform(done, (v) => `${v}px`);
  return <>
    <motion.span aria-hidden="true" className="absolute inset-y-0 start-0 rounded-full bg-ink/45" style={{ width: doneWidth }} />
    <motion.span aria-hidden="true" className="absolute inset-y-0 rounded-full bg-ink" style={{ insetInlineStart: inset, width }} />
  </>;
}

/** One piece of a step arriving: the art first, then the title, the line, what to do and the way on, 45ms apart, each
 * rising 12px out of a 4px blur on the enter spring. Under reduced motion they only fade. */
function useCascade() {
  const reduced = useReducedMotion() === true;
  return (index: number) => {
    if (reduced) return { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.15, ease: [0.22, 1, 0.36, 1] as const } };
    if (index === 0) return { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { type: "spring" as const, stiffness: 520, damping: 26 } };
    return {
      initial: { opacity: 0, y: 12, filter: "blur(4px)" },
      animate: { opacity: 1, y: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } },
      transition: { type: "spring" as const, stiffness: 300, damping: 22, delay: 0.06 + index * 0.045 },
    };
  };
}

/** One step's page: a picture that explains it, the title, a short line, what to do, and the way on. */
export function StepFrame({ art, title, sub, children, footer, wide = false }: {
  art?: ReactNode; title: ReactNode; sub?: ReactNode; children?: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const rise = useCascade();
  return (
    <div data-step-cascade="" className={cn("mx-auto my-auto flex w-full flex-col items-center px-6 pt-20 text-center", footer ? "pb-6" : "pb-12", wide ? "max-w-[640px]" : "max-w-[520px]")}>
      {art && <motion.div aria-hidden="true" className="mb-6 flex h-16 items-end justify-center" {...rise(0)}>{art}</motion.div>}
      <motion.h1 id="welcome-title" tabIndex={-1} className="text-balance text-[28px] font-normal leading-[34px] tracking-[-0.02em] text-ink outline-none" {...rise(1)}>{title}</motion.h1>
      {sub && <motion.p className="mt-2 max-w-[420px] text-pretty text-[15px] leading-[22px] text-ink-secondary" {...rise(2)}>{sub}</motion.p>}
      {children && <motion.div className="mt-8 flex w-full flex-col items-center" {...rise(3)}>{children}</motion.div>}
      {/* a step taller than the window keeps its way on in view, over the content scrolling under it */}
      {footer && <motion.div data-step-footer="" className="sticky bottom-0 z-[1] mt-4 flex w-full flex-col items-center gap-2 bg-app pb-6 pt-4" {...rise(4)}>{footer}</motion.div>}
    </div>
  );
}

/** Pixel art from either set, at the step's size. */
export function StepArt({ art, place }: { art?: ArtName; place?: PlaceArtName }) {
  if (place) return <PlaceArt name={place} size={60} className="place-mark" />;
  return art ? <Art name={art} size="xl" className="place-mark h-16" /> : null;
}

/** The hello. On a cloud the desktop app set up it greets the person by the name and picture that computer knows. */
export function WelcomeStep({ onStart, cloud }: { onStart: () => void; cloud?: { name: string; picture?: string } }) {
  const reduced = usePrefersReducedMotion();
  const art = cloud?.picture
    ? <img src={cloud.picture} alt="" data-welcome-picture="" className="size-[72px] rounded-full object-cover" />
    : <MausAvatar color="purple" gradient={BRAND_LILAC} size={72} state="excited" animated={!reduced} label={DEFAULT_BOT_NAME} />;
  return (
    <div className="flex min-h-full w-full flex-col">
      <StepFrame
        art={art}
        title={cloud ? (cloud.name ? t("funnel.welcome.cloudNamed", { name: cloud.name }) : t("funnel.welcome.cloud")) : t("funnel.welcome.title")}
        sub={cloud ? t("funnel.welcome.cloudSub") : t("funnel.welcome.sub")}
        footer={<button type="button" data-primary="" data-funnel-start="" autoFocus onClick={onStart} className={PRIMARY}>{t("funnel.welcome.start")}</button>}
      />
    </div>
  );
}
