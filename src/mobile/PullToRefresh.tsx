import { useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { motion, useMotionValue, useMotionValueEvent, useTransform, type MotionValue } from "motion/react";
import { haptic } from "./haptics";
import { ownsDrag, useDrag } from "./gesture";
import { rubberband, settleTo } from "./motion";
import { isGlassDark } from "./native-glass";
import { PlatformContext } from "./platform";

const THRESHOLD = 72;
const HOLD = 60;

/** Pull down past the top of a list to refresh. The list follows the finger on a rubber band, a tick lands as the pull
 * passes the line, and a release past it holds the list open until the refresh settles. */
export function PullToRefresh({ scrollRef, onRefresh, indicator, children, top = 0 }: {
  scrollRef: RefObject<HTMLElement | null>;
  onRefresh: () => Promise<unknown>;
  indicator: (progress: MotionValue<number>, refreshing: boolean) => ReactNode;
  children: ReactNode;
  /** Where the indicator sits, below the floating bar. */
  top?: number | string;
}) {
  const glass = useContext(PlatformContext)?.glass;
  const nativeOrb = glass?.pullRefresh;
  const anchorRef = useRef<HTMLDivElement>(null);
  const pull = useMotionValue(0);
  const progress = useTransform(pull, [0, THRESHOLD], [0, 1], { clamp: false });
  const indicatorOpacity = useTransform(pull, [8, 40], [0, 1]);
  const [refreshing, setRefreshing] = useState(false);
  const armed = useRef(false);
  const busy = useRef(false);
  const settling = useRef(false);
  const nativeActive = useRef(false);
  const finishTimer = useRef<number | null>(null);

  const syncNative = useCallback((value: number, isRefreshing: boolean) => {
    if (!nativeOrb) return;
    if (value <= 1 && !isRefreshing) {
      settling.current = false;
      if (nativeActive.current) {
        nativeActive.current = false;
        nativeOrb(null);
      }
      return;
    }
    if (settling.current && !isRefreshing) return;
    nativeActive.current = true;
    const baseTop = anchorRef.current?.getBoundingClientRect().top || 108;
    const y = Math.round((baseTop + Math.min(34, Math.max(12, value * 0.5))) * 2) / 2;
    nativeOrb({
      y,
      progress: Math.max(0, value / THRESHOLD),
      armed: armed.current,
      refreshing: isRefreshing,
      dark: isGlassDark(),
    });
  }, [nativeOrb]);

  useEffect(() => () => {
    if (finishTimer.current !== null) {
      window.clearTimeout(finishTimer.current);
      finishTimer.current = null;
    }
    if (nativeActive.current) {
      nativeActive.current = false;
      nativeOrb?.(null, true);
    }
  }, [nativeOrb]);

  useMotionValueEvent(pull, "change", (value) => {
    if (!busy.current) {
      if (value >= THRESHOLD && !armed.current) { armed.current = true; haptic("refresh"); }
      else if (value < THRESHOLD - 12 && armed.current) armed.current = false;
    }
    syncNative(value, busy.current);
  });

  const finish = useCallback(() => {
    finishTimer.current = null;
    busy.current = false;
    settling.current = true;
    setRefreshing(false);
    if (nativeOrb && nativeActive.current) {
      nativeActive.current = false;
      nativeOrb(null);
    }
    settleTo(pull, 0, 0);
  }, [pull, nativeOrb]);

  useDrag(scrollRef, {
    axis: "y",
    claim: (s) => s.dy > 0 && !busy.current && (scrollRef.current?.scrollTop ?? 1) <= 0 && !ownsDrag(s.target),
    onMove: (s) => { settling.current = false; pull.set(rubberband(Math.max(0, s.dy), 220, 0.75)); },
    onEnd: () => {
      if (pull.get() >= THRESHOLD) {
        busy.current = true;
        armed.current = false;
        setRefreshing(true);
        syncNative(HOLD, true);
        settleTo(pull, HOLD, 0);
        const started = performance.now();
        // a refresh that answers at once still shows its beat, so the hand sees it happened
        void onRefresh().catch(() => haptic("error")).finally(() => {
          if (finishTimer.current !== null) window.clearTimeout(finishTimer.current);
          finishTimer.current = window.setTimeout(finish, Math.max(0, 450 - (performance.now() - started)));
        });
      } else settleTo(pull, 0, 0);
    },
    onCancel: () => { if (!busy.current) settleTo(pull, 0, 0); },
  });

  return (
    <>
      <motion.div ref={anchorRef} aria-hidden={!refreshing} role="status" className="pointer-events-none absolute inset-x-0 z-0 flex justify-center" style={{ top, opacity: nativeOrb ? 0 : refreshing ? 1 : indicatorOpacity }}>
        {indicator(progress, refreshing)}
      </motion.div>
      <motion.div className="relative z-[1] bg-app" style={{ y: pull }}>
        {children}
      </motion.div>
    </>
  );
}
