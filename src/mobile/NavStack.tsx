import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { TranscriptStaging } from "@/components/transcript-staging";
import { wakeSystemControls } from "@/lib/system-control";
import { canScroll, ownsDrag, useDrag } from "./gesture";
import { replyRowAt } from "./swipe-reply";
import { prefersReducedMotion, projectRelease, settleTo, sheetNav, springPath, system } from "./motion";
import { PlatformContext } from "./platform";

const NavLeavingContext = createContext(false);

export function useNavLeaving(): boolean {
  return useContext(NavLeavingContext);
}

function readSafeTop(el: HTMLElement): number {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;height:var(--m-safe-top)";
  el.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return height;
}

/** Parallax of the page underneath, as a share of the width: UIKit's navigation push moves it a third as far. */
const UNDER_SHIFT = 0.3;
const NAV = { stiffness: system.stiffness, damping: system.damping };
const SNAPPY_NAV = { stiffness: sheetNav.stiffness, damping: sheetNav.damping };
/** A chat still loading its transcript slides in once it has it, or after this long with its loading rows. */
const LOAD_WAIT_MS = 150;

/** `stop` leaves the page where it is and says how fast it was moving there, in px/s, so what follows carries on. */
type Run = { stop: () => number };
/** A page slide as the compositor plays it: positions in px, one per 60 Hz frame, linear between them. */
export type SlidePath = { duration: number; points: number[] };

/** Resolves once a freshly mounted page has painted, and its transcript has loaded or `LOAD_WAIT_MS` has passed. */
function whenPainted(el: HTMLElement, signal: { cancelled: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const started = performance.now();
    const tick = (now: number) => {
      if (signal.cancelled) return;
      const loading = el.querySelector("[role='log'][aria-busy='true']") !== null;
      if (!loading || now - started > LOAD_WAIT_MS) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function useWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 390 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/** The page, the list under it and its dim, moved together as keyframes the compositor plays: a busy page thread (a chat
 * mounting, a reply streaming) never stalls the slide. On landing or `stop` the motion values take over where it is. */
function slideLayers(layers: { page: HTMLElement; base: HTMLElement | null; dim: HTMLElement | null }, x: MotionValue<number>, width: number, path: SlidePath, onDone: () => void, onStopped?: () => void): Run {
  const options: KeyframeAnimationOptions = { duration: path.duration, fill: "forwards", easing: "linear" };
  const runs = [
    layers.page.animate(path.points.map((p) => ({ transform: `translateX(${p}px)` })), options),
    layers.base?.animate(path.points.map((p) => ({ transform: `translateX(${-UNDER_SHIFT * (width - p)}px)` })), options),
    layers.dim?.animate(path.points.map((p) => ({ opacity: 1 - p / width })), options),
  ].filter((run): run is Animation => Boolean(run));
  let over = false;
  const hand = (at: number) => {
    if (over) return;
    over = true;
    for (const run of runs) {
      try { run.commitStyles(); } catch { /* an element already gone */ }
      run.cancel();
    }
    x.set(at);
  };
  runs[0]!.onfinish = () => { if (!over) { hand(path.points.at(-1)!); onDone(); } };
  return {
    stop: () => {
      if (over) return 0;
      const frame = Math.floor(Number(runs[0]!.currentTime ?? 0) / (1000 / 60));
      const speed = ((path.points[frame + 1] ?? path.points.at(-1)!) - (path.points[frame] ?? path.points.at(-1)!)) * 60;
      hand(new DOMMatrixReadOnly(getComputedStyle(layers.page).transform).m41);
      onStopped?.();
      return speed;
    },
  };
}

/** Two layers: the list, and a page pushed over it. The page follows the finger back to the list from anywhere on it
 * (a horizontal scroller inside keeps its own drag), and a release finishes or returns by where the flick would land. */
export function NavStack({ base, page, pageKey, onBack, onSettled, onSlide, onLeave, snappy = false }: {
  base: ReactNode;
  /** The pushed page, or null for the list alone. */
  page: ReactNode | null;
  pageKey: string | null;
  onBack: () => void;
  /** The pushed page is fully in (true) or gone (false). */
  onSettled?: (shown: boolean) => void;
  /** Each slide the page starts, with the path it plays, so native layers riding on the page play the same one in the
   * same frame; null when a slide stops short (a finger took the page). */
  onSlide?: (path: SlidePath | null) => void;
  /** The page starts back to the list (a back tap, or a finger taking it), before the slide's first frame. */
  onLeave?: () => void;
  /** Use UIKit's unscaled navigation push spring (for sheet sub-pages on non-native platforms). */
  snappy?: boolean;
}) {
  const width = useWidth();
  const x = useMotionValue(width);
  const baseX = useTransform(x, (value) => -UNDER_SHIFT * (width - value));
  const dim = useTransform(x, [0, width], [1, 0]);
  const pageOpacity = useMotionValue(1);
  const [shownKey, setShownKey] = useState<string | null>(null);
  const lastPage = useRef<ReactNode>(null);
  const [moving, setMoving] = useState(false);
  const [leavingPage, setLeavingPage] = useState(false);
  const run = useRef<Run | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLDivElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const slid = useRef(onSlide);
  slid.current = onSlide;
  const leaving = useRef(onLeave);
  leaving.current = onLeave;
  if (page) lastPage.current = page;

  // the page's older rows wait while it moves: they mount once it lands, and never for a page on its way out
  const sliding = useRef(false);
  const waiting = useRef(new Set<() => void>());
  // the list under a page is inert from the page's landing until it has fully left: toggling inert restyles the whole
  // list, so it never happens as a back slide or a finger's drag starts, only once nothing moves
  const [covered, setCovered] = useState(false);
  const lockSafeTop = useCallback(() => {
    const el = pageRef.current;
    if (!el) return;
    const top = readSafeTop(el);
    if (top > 0) el.style.setProperty("--m-safe-top", `${top}px`);
  }, []);
  const unlockSafeTop = useCallback(() => {
    pageRef.current?.style.removeProperty("--m-safe-top");
  }, []);
  const landed = useCallback(() => {
    unlockSafeTop();
    setCovered(true);
    sliding.current = false;
    const steps = [...waiting.current];
    waiting.current.clear();
    for (const step of steps) step();
  }, [unlockSafeTop]);
  const gone = useCallback(() => {
    sliding.current = false;
    waiting.current.clear();
  }, []);
  const staging = useMemo<TranscriptStaging>(() => ({
    afterSlide: (step) => {
      if (!sliding.current) { step(); return () => {}; }
      waiting.current.add(step);
      return () => { waiting.current.delete(step); };
    },
  }), []);

  /** `velocity` null: a tap, which pushes and pops at the system's speed, or carries on at the speed of a slide it interrupts. */
  const go = useCallback((target: number, velocity: number | null, done?: () => void) => {
    const carried = run.current?.stop() ?? 0;
    setMoving(true);
    wakeSystemControls();
    const finish = () => { setMoving(false); wakeSystemControls(); done?.(); };
    if (prefersReducedMotion()) {
      x.set(0);
      const fade = settleTo(pageOpacity, target === 0 ? 1 : 0, 0, () => { x.set(target); finish(); });
      run.current = { stop: () => { fade.stop(); return 0; } };
      return;
    }
    const page = pageRef.current;
    const springConfig = snappy ? SNAPPY_NAV : NAV;
    const pushSpeed = snappy ? sheetNav.push : system.push;
    const toward = Math.sign(target - x.get());
    const speed = velocity ?? (carried !== 0 ? carried : toward * width * pushSpeed);
    if (!page || typeof page.animate !== "function") {
      run.current = { stop: () => { controls.stop(); return 0; } };
      const controls = settleTo(x, target, speed, finish, springConfig);
      return;
    }
    const path = springPath(x.get(), target, speed, springConfig);
    run.current = slideLayers({ page, base: baseRef.current, dim: dimRef.current }, x, width, path, finish, () => slid.current?.(null));
    slid.current?.(path);
  }, [x, pageOpacity, width, snappy]);

  const preparing = useRef<{ cancelled: boolean } | null>(null);
  const push = useCallback(() => {
    if (preparing.current) preparing.current.cancelled = true;
    const signal = { cancelled: false };
    preparing.current = signal;
    sliding.current = true;
    setLeavingPage(false);
    unlockSafeTop();
    run.current?.stop();
    x.set(width);
    pageOpacity.set(prefersReducedMotion() ? 0 : 1);
    setMoving(true);
    requestAnimationFrame(() => {
      const el = pageRef.current;
      const ready = el ? whenPainted(el, signal) : Promise.resolve();
      void ready.then(() => {
        if (signal.cancelled) return;
        preparing.current = null;
        go(0, null, () => { landed(); settled.current?.(true); });
      });
    });
  }, [go, landed, unlockSafeTop, x, pageOpacity, width]);

  const popping = useRef(false);
  const popped = useCallback(() => {
    popping.current = false;
    setLeavingPage(false);
    unlockSafeTop();
    setCovered(false);
    setShownKey(null);
    lastPage.current = null;
    gone();
    settled.current?.(false);
  }, [gone, unlockSafeTop]);
  const pop = useCallback(() => {
    if (preparing.current) preparing.current.cancelled = true;
    const signal = { cancelled: false };
    preparing.current = signal;
    popping.current = true;
    sliding.current = true;
    lockSafeTop();
    setLeavingPage(true);
    leaving.current?.();
    setMoving(true);
    requestAnimationFrame(() => {
      if (signal.cancelled) return;
      preparing.current = null;
      go(width, null, popped);
    });
  }, [go, lockSafeTop, popped, width]);
  const unpop = useCallback(() => {
    if (preparing.current) preparing.current.cancelled = true;
    const signal = { cancelled: false };
    preparing.current = signal;
    popping.current = false;
    sliding.current = true;
    setLeavingPage(false);
    unlockSafeTop();
    run.current?.stop();
    requestAnimationFrame(() => {
      if (signal.cancelled) return;
      preparing.current = null;
      go(0, null, () => { landed(); settled.current?.(true); });
    });
  }, [go, landed, unlockSafeTop]);

  useLayoutEffect(() => {
    if (pageKey && page) {
      // opened again while it leaves (the same chat or another): the leaving page turns around with what is asked for
      if (popping.current) { setShownKey(pageKey); unpop(); return; }
      if (shownKey === pageKey) return;
      // a page swapped for another (a notification opening a different chat) cuts over; only list to page slides
      if (shownKey && x.get() < width / 2) { setShownKey(pageKey); return; }
      setShownKey(pageKey);
      push();
    } else if (shownKey && !popping.current) {
      pop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey, Boolean(page)]);

  useEffect(() => { if (shownKey && !moving) x.set(0); }, [width]); // eslint-disable-line react-hooks/exhaustive-deps

  const takeHold = useCallback(() => {
    run.current?.stop();
    popping.current = false;
    setLeavingPage(false);
    lockSafeTop();
    // a slide that already landed is over for the chrome too: from here it follows the finger
    slid.current?.(null);
    sliding.current = true;
    setMoving(true);
    wakeSystemControls();
    leaving.current?.();
    const active = document.activeElement;
    if (active instanceof HTMLElement && pageRef.current?.contains(active)) active.blur();
  }, [lockSafeTop]);

  // Android 14+'s back gesture moves the page as a finger on it does, and lands or returns on the same spring
  const platform = useContext(PlatformContext);
  const backed = useRef(onBack);
  backed.current = onBack;
  const shownNow = useRef(shownKey);
  shownNow.current = shownKey;
  const gesture = useRef(false);
  useEffect(() => platform?.onBackGesture?.((event) => {
    if (event.phase === "start") {
      if (!shownNow.current || popping.current) return false;
      takeHold();
      gesture.current = true;
    }
    if (!gesture.current) return false;
    switch (event.phase) {
      case "start": case "progress":
        x.set(Math.max(0, event.progress) * width);
        return true;
      case "cancel":
        gesture.current = false;
        go(0, null, landed);
        return true;
      case "commit":
        gesture.current = false;
        popping.current = true;
        lockSafeTop();
        setLeavingPage(true);
        go(width, null, () => { popped(); backed.current(); });
        return true;
    }
  }), [platform, takeHold, go, landed, lockSafeTop, popped, x, width]);

  useDrag(pageRef, {
    axis: "x",
    enabled: Boolean(shownKey),
    claim: (s, start) => s.dx > 0 && !ownsDrag(s.target) && !canScroll(s.target, pageRef.current!, "x", -1) && !replyRowAt(s.target, start.x),
    onStart: takeHold,
    onMove: (s) => {
      const pos = Math.max(0, s.dx);
      x.set(pos);
      slid.current?.({ duration: 0, points: [pos] });
      wakeSystemControls();
    },
    onEnd: (s) => {
      const landing = projectRelease(x.get(), s.vx);
      if ((landing > width / 2 && s.vx > -200) || s.vx > 500) {
        popping.current = true;
        lockSafeTop();
        setLeavingPage(true);
        go(width, Math.max(s.vx, 0), () => { popped(); onBack(); });
      } else {
        go(0, s.vx, landed);
      }
    },
    onCancel: () => go(0, null, landed),
  });

  const pageShown = Boolean(shownKey);
  const still = prefersReducedMotion();
  return (
    <div className="mobile-nav relative h-full w-full overflow-hidden bg-app">
      <motion.div
        ref={baseRef}
        className="absolute inset-0"
        style={{ x: pageShown && !still ? baseX : 0, willChange: moving ? "transform" : undefined }}
        inert={pageShown && covered ? true : undefined}
        aria-hidden={pageShown && covered ? true : undefined}
      >
        {base}
        {pageShown && <motion.div ref={dimRef} aria-hidden className="pointer-events-none absolute inset-0 bg-[rgb(10_10_12/0.16)]" style={{ opacity: still ? pageOpacity : dim }} />}
      </motion.div>
      {pageShown && (
        <motion.div
          ref={pageRef}
          key={shownKey}
          className="mobile-page absolute inset-0 bg-app"
          data-moving={moving ? "" : undefined}
          data-leaving={leavingPage ? "" : undefined}
          style={{ x, opacity: pageOpacity, willChange: moving ? "transform" : undefined }}
        >
          <NavLeavingContext.Provider value={leavingPage}>
            <TranscriptStaging value={staging}>{page ?? lastPage.current}</TranscriptStaging>
          </NavLeavingContext.Provider>
        </motion.div>
      )}
    </div>
  );
}
