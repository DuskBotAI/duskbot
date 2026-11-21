type Frame = (now: number) => void;
type Clock = {
  raf: (fn: (now: number) => void) => number;
  caf: (id: number) => void;
  doc: Pick<Document, "hidden" | "addEventListener" | "removeEventListener"> | null;
  win?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
  minFrameMs?: number;
};

/** One animation frame loop shared by every working mascot on the page: it runs only while someone listens and the
 * page is visible, caps high-refresh displays when configured, and stops in a background or blurred window. */
export function createTicker(clock: Clock) {
  const listeners = new Set<Frame>();
  const minFrameMs = clock.minFrameMs ?? 0;
  let frame: number | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  let blurred = false;
  const paused = () => Boolean(clock.doc?.hidden) || blurred;
  const loop = (now: number) => {
    frame = null;
    for (const listener of listeners) listener(now);
    if (paused() || !listeners.size) return;
    if (minFrameMs > 0) {
      waitTimer = setTimeout(() => {
        waitTimer = null;
        schedule();
      }, minFrameMs);
      return;
    }
    schedule();
  };
  const schedule = () => {
    if (frame === null && waitTimer === null && listeners.size && !paused()) frame = clock.raf(loop);
  };
  const stop = () => {
    if (frame !== null) clock.caf(frame);
    frame = null;
    if (waitTimer !== null) {
      clearTimeout(waitTimer);
      waitTimer = null;
    }
  };
  const onVisibility = () => (paused() ? stop() : schedule());
  const onBlur = () => { blurred = true; stop(); };
  const onFocus = () => { blurred = false; schedule(); };
  return {
    subscribe(listener: Frame): () => void {
      if (!listeners.size) {
        clock.doc?.addEventListener("visibilitychange", onVisibility);
        clock.win?.addEventListener("blur", onBlur);
        clock.win?.addEventListener("focus", onFocus);
      }
      listeners.add(listener);
      schedule();
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        stop();
        clock.doc?.removeEventListener("visibilitychange", onVisibility);
        clock.win?.removeEventListener("blur", onBlur);
        clock.win?.removeEventListener("focus", onFocus);
      };
    },
    get running() { return frame !== null || waitTimer !== null; },
  };
}

export const mascotTicker = createTicker({
  raf: (fn) => requestAnimationFrame(fn),
  caf: (id) => cancelAnimationFrame(id),
  doc: typeof document === "undefined" ? null : document,
  win: typeof window === "undefined" ? null : window,
  minFrameMs: 32,
});
