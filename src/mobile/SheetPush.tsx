import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, useMotionValue, useReducedMotion, type MotionValue } from "motion/react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { wakeSystemControls } from "@/lib/system-control";
import { BAR_RANK, useNativeBar } from "./chrome";
import { canScroll, ownsDrag, useDrag } from "./gesture";
import { dur, ease, prefersReducedMotion, projectRelease, settleTo, springPath, system } from "./motion";
import { BackGlyph, RoundButton } from "./RoundButton";
import { closesOnBack } from "./Sheet";

/** Matches UIKit UINavigationController's 30% horizontal parallax on the receding view controller. */
const UNDER_SHIFT = 0.3;
const NAV = { stiffness: system.stiffness, damping: system.damping };

type Run = { stop: () => number };

function slidePushLayers(
  layers: { page: HTMLElement; base: HTMLElement | null; dim: HTMLElement | null },
  x: MotionValue<number>,
  width: number,
  from: number,
  to: number,
  velocity: number,
  onDone: () => void,
): Run {
  const path = springPath(from, to, velocity, NAV);
  const options: KeyframeAnimationOptions = { duration: path.duration, fill: "forwards", easing: "linear" };
  const runs = [
    layers.page.animate(path.points.map((p) => ({ transform: `translateX(${p}px)` })), options),
    layers.base?.animate(path.points.map((p) => ({ transform: `translateX(${-UNDER_SHIFT * (width - p)}px)` })), options),
    layers.dim?.animate(path.points.map((p) => ({ opacity: Math.max(0, Math.min(1, 1 - p / Math.max(1, width))) })), options),
  ].filter((run): run is Animation => Boolean(run));
  let over = false;
  const hand = (at: number) => {
    if (over) return;
    over = true;
    for (const run of runs) {
      try { run.commitStyles(); } catch { /* element already unmounted */ }
      run.cancel();
    }
    x.set(at);
    if (layers.base) layers.base.style.transform = at >= width - 0.5 ? "" : `translateX(${-UNDER_SHIFT * (width - at)}px)`;
    if (layers.dim) layers.dim.style.opacity = String(Math.max(0, Math.min(1, 1 - at / Math.max(1, width))));
  };
  runs[0]!.onfinish = () => { if (!over) { hand(to); onDone(); } };
  return {
    stop: () => {
      if (over) return 0;
      const frame = Math.floor(Number(runs[0]!.currentTime ?? 0) / (1000 / 60));
      const speed = ((path.points[frame + 1] ?? path.points.at(-1)!) - (path.points[frame] ?? path.points.at(-1)!)) * 60;
      hand(new DOMMatrixReadOnly(getComputedStyle(layers.page).transform).m41);
      return speed;
    },
  };
}

function underlyingSheet(pageEl: HTMLElement | null): HTMLElement | null {
  const shell = pageEl?.closest(".dusk-mobile") ?? document.querySelector(".dusk-mobile");
  if (!shell) return null;
  const pushed = shell.querySelectorAll<HTMLElement>("[data-phone-pushed-page]:not([data-leaving])");
  for (let i = pushed.length - 1; i >= 0; i -= 1) {
    const candidate = pushed[i]!;
    if (candidate !== pageEl && (!pageEl || !candidate.contains(pageEl))) return candidate;
  }
  const sheets = shell.querySelectorAll<HTMLElement>(".mobile-sheet-layer > .mobile-sheet");
  for (let i = sheets.length - 1; i >= 0; i -= 1) {
    const candidate = sheets[i]!;
    if (!pageEl || !candidate.contains(pageEl)) return candidate;
  }
  return null;
}

export function SheetPush({
  open,
  onClose,
  title,
  label,
  children,
  pageId,
  bodyClassName,
  flush = false,
  swipeBack = true,
  onBack,
  contentRef,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  label?: string;
  children: ReactNode;
  pageId?: string;
  bodyClassName?: string;
  flush?: boolean;
  swipeBack?: boolean;
  onBack?: () => void;
  contentRef?: (el: HTMLDivElement | null) => void;
}) {
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const [moving, setMoving] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [nested, setNested] = useState(false);
  const widthRef = useRef(typeof window === "undefined" ? 390 : window.innerWidth);
  const x = useMotionValue(widthRef.current);
  const pageOpacity = useMotionValue(1);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const dimRef = useRef<HTMLDivElement | null>(null);
  const baseRef = useRef<HTMLElement | null>(null);
  const runRef = useRef<Run | null>(null);
  const poppingRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const backRef = useRef(onBack ?? onClose);
  backRef.current = onBack ?? onClose;
  const prefersReduced = useReducedMotion();
  const isReduced = () => Boolean(prefersReduced) || prefersReducedMotion()
    || (typeof document !== "undefined" && document.documentElement.dataset.reducedMotion === "true");

  if (open && !mounted) setMounted(true);

  const setRefs = useCallback((el: HTMLDivElement | null) => {
    pageRef.current = el;
    contentRef?.(el);
  }, [contentRef]);

  const clearBase = useCallback(() => {
    if (baseRef.current) {
      baseRef.current.style.transform = "";
      baseRef.current.style.willChange = "";
    }
    baseRef.current = null;
  }, []);

  const syncBaseFor = useCallback((pos: number) => {
    const width = Math.max(1, widthRef.current);
    const clamped = Math.max(0, Math.min(width, pos));
    if (baseRef.current) baseRef.current.style.transform = clamped >= width - 0.5 ? "" : `translateX(${-UNDER_SHIFT * (width - clamped)}px)`;
    if (dimRef.current) dimRef.current.style.opacity = String(Math.max(0, Math.min(1, 1 - clamped / width)));
  }, []);

  const go = useCallback((target: number, velocity: number | null, onDone?: () => void) => {
    const carried = runRef.current?.stop() ?? 0;
    const width = Math.max(1, window.innerWidth || widthRef.current);
    widthRef.current = width;
    setMoving(true);
    wakeSystemControls();
    const finish = () => {
      setMoving(false);
      wakeSystemControls();
      onDone?.();
    };
    const page = pageRef.current;
    if (isReduced()) {
      x.set(0);
      clearBase();
      if (dimRef.current) dimRef.current.style.opacity = target === 0 ? "1" : "0";
      const fade = settleTo(pageOpacity, target === 0 ? 1 : 0, 0, () => {
        x.set(target);
        finish();
      }, { stiffness: 600, damping: 54 });
      runRef.current = { stop: () => { fade.stop(); return 0; } };
      return;
    }
    const from = x.get();
    if (Math.abs(from - target) < 0.5) {
      x.set(target);
      syncBaseFor(target);
      finish();
      return;
    }
    const toward = Math.sign(target - from);
    const speed = velocity ?? (carried !== 0 ? carried : toward * width * system.push);
    if (!page || typeof page.animate !== "function") {
      const controls = settleTo(x, target, speed, () => { syncBaseFor(target); finish(); }, NAV);
      runRef.current = { stop: () => { controls.stop(); return 0; } };
      return;
    }
    if (!baseRef.current) baseRef.current = underlyingSheet(page);
    if (baseRef.current) baseRef.current.style.willChange = "transform";
    runRef.current = slidePushLayers({ page, base: baseRef.current, dim: dimRef.current }, x, width, from, target, speed, finish);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, pageOpacity, clearBase, syncBaseFor]);

  useLayoutEffect(() => {
    if (!mounted) return;
    const width = Math.max(1, window.innerWidth || widthRef.current);
    widthRef.current = width;
    if (open) {
      setLeaving(false);
      if (poppingRef.current) {
        poppingRef.current = false;
        go(0, null);
        return;
      }
      baseRef.current = underlyingSheet(pageRef.current);
      setNested(Boolean(baseRef.current?.hasAttribute("data-phone-pushed-page")));
      const reduced = isReduced();
      x.set(reduced ? 0 : width);
      pageOpacity.set(reduced ? 0 : 1);
      if (pageRef.current) {
        pageRef.current.dataset.preparing = "";
        pageRef.current.style.transform = reduced ? "none" : `translateX(${width}px)`;
      }
      if (dimRef.current) dimRef.current.style.opacity = "0";
      setMoving(true);
      let frame2 = 0;
      const frame1 = requestAnimationFrame(() => {
        frame2 = requestAnimationFrame(() => {
          if (pageRef.current) delete pageRef.current.dataset.preparing;
          if (reduced) {
            const el = pageRef.current;
            if (el && typeof el.animate === "function") {
              const anim = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur.fast * 1000, easing: `cubic-bezier(${ease.out.join(",")})`, fill: "forwards" });
              if (dimRef.current) dimRef.current.style.opacity = "1";
              anim.onfinish = () => { pageOpacity.set(1); anim.cancel(); setMoving(false); wakeSystemControls(); };
              runRef.current = { stop: () => { anim.cancel(); return 0; } };
            } else {
              pageOpacity.set(1);
              setMoving(false);
              wakeSystemControls();
            }
            return;
          }
          go(0, null);
        });
      });
      return () => {
        cancelAnimationFrame(frame1);
        if (frame2) cancelAnimationFrame(frame2);
      };
    }
    setLeaving(true);
    if (poppingRef.current) return;
    poppingRef.current = true;
    const reduced = isReduced();
    if (reduced) {
      clearBase();
      const el = pageRef.current;
      const done = () => { poppingRef.current = false; setLeaving(false); setMounted(false); wakeSystemControls(); };
      if (el && typeof el.animate === "function") {
        const anim = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur.fast * 1000, easing: `cubic-bezier(${ease.out.join(",")})`, fill: "forwards" });
        anim.onfinish = () => { anim.cancel(); done(); };
        runRef.current = { stop: () => { anim.cancel(); return 0; } };
      } else {
        done();
      }
      return;
    }
    go(width, null, () => {
      poppingRef.current = false;
      clearBase();
      setLeaving(false);
      setMounted(false);
      wakeSystemControls();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  useEffect(() => () => {
    runRef.current?.stop();
    clearBase();
    wakeSystemControls();
  }, [clearBase]);

  useEffect(() => { setScrolled(false); }, [open, title]);

  useEffect(() => {
    if (!open) return;
    return closesOnBack(() => backRef.current());
  }, [open]);

  const handleBack = useCallback(() => backRef.current(), []);

  const systemBar = useNativeBar(BAR_RANK.sheetPushed, mounted && open && !leaving ? {
    title: title || undefined,
    leading: [{ id: "back", symbol: "chevron.backward", label: t("mobile.sheet.back") }],
    trailing: [],
  } : null, { back: handleBack });

  useDrag(pageRef, {
    axis: "x",
    enabled: mounted && open && swipeBack && !isReduced(),
    claim: (s) => s.dx > 0 && !ownsDrag(s.target) && !canScroll(s.target, pageRef.current!, "x", -1),
    onStart: () => {
      runRef.current?.stop();
      poppingRef.current = false;
      if (!baseRef.current) baseRef.current = underlyingSheet(pageRef.current);
      if (baseRef.current) baseRef.current.style.willChange = "transform";
      setMoving(true);
      wakeSystemControls();
      const active = document.activeElement;
      if (active instanceof HTMLElement && pageRef.current?.contains(active)) active.blur();
    },
    onMove: (s) => {
      const pos = Math.max(0, s.dx);
      x.set(pos);
      syncBaseFor(pos);
      wakeSystemControls();
    },
    onEnd: (s) => {
      const width = Math.max(1, window.innerWidth || widthRef.current);
      widthRef.current = width;
      const landing = projectRelease(x.get(), s.vx);
      if ((landing > width / 2 && s.vx > -200) || s.vx > 500) {
        poppingRef.current = true;
        setLeaving(true);
        go(width, Math.max(s.vx, 0), () => {
          poppingRef.current = false;
          clearBase();
          setLeaving(false);
          setMounted(false);
          closeRef.current();
          wakeSystemControls();
        });
      } else {
        go(0, s.vx);
      }
    },
    onCancel: () => go(0, null),
  });

  if (!mounted) return null;

  return createPortal(
    <>
      <div
        ref={dimRef}
        aria-hidden
        className={cn("pointer-events-none fixed inset-0 bg-[rgb(10_10_12/0.14)]", nested ? "z-[61]" : "z-[59]")}
        style={{ opacity: 0 }}
      />
      <motion.div
        ref={setRefs}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? title}
        data-phone-pushed-page={pageId ?? ""}
        data-phone-bot-page={pageId || undefined}
        data-leaving={leaving ? "" : undefined}
        inert={leaving || undefined}
        style={{ x, opacity: pageOpacity, willChange: moving ? "transform" : undefined }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); handleBack(); } }}
        onScrollCapture={(event) => {
          const area = event.target as HTMLElement;
          if (area.scrollHeight > area.clientHeight + 1) setScrolled(area.scrollTop > 2);
        }}
        className={cn("fixed inset-0 flex flex-col bg-(--m-sheet-page) shadow-[-12px_0_32px_rgb(10_10_12/0.14)] outline-none", nested ? "z-[62]" : "z-[60]")}
      >
        {systemBar && (
          <div aria-hidden className={cn("mobile-edge mobile-sheet-edge pointer-events-none absolute inset-x-0 top-0 z-50 h-[calc(var(--m-safe-top)+20px)] transition-opacity duration-150", scrolled ? "opacity-100" : "opacity-0")} />
        )}
        {!systemBar && (
          <div className="flex min-h-[52px] shrink-0 items-center gap-3 px-4 pb-2 pt-[max(var(--m-safe-top),16px)]">
            <RoundButton label={t("mobile.sheet.back")} onClick={handleBack} size={44}><BackGlyph /></RoundButton>
            {title && <div className="min-w-0 flex-1 truncate text-[17px] font-semibold text-ink">{title}</div>}
          </div>
        )}
        {flush ? (
          <div className={cn("relative flex min-h-0 flex-1 flex-col overflow-hidden pb-[var(--m-safe-bottom)]", systemBar && "pt-[max(var(--m-safe-top),16px)]", bodyClassName)}>
            {children}
          </div>
        ) : (
          <div className={cn("mobile-sheet-body relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pb-[max(var(--m-safe-bottom),16px)]", systemBar && "pt-[max(var(--m-safe-top),16px)]", bodyClassName)}>
            {children}
          </div>
        )}
      </motion.div>
    </>,
    document.querySelector(".dusk-mobile") ?? document.body,
  );
}
