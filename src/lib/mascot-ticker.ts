type Frame = (now: number) => void;
type Clock = {
  raf: (fn: (now: number) => void) => number;
  caf: (id: number) => void;
  doc: Pick<Document, "hidden" | "addEventListener" | "removeEventListener"> | null;
};

/** One animation frame loop shared by every working mascot on the page: it runs only while someone listens and the
 * page is visible, and stops entirely in a background tab. */
export function createTicker(clock: Clock) {
  const listeners = new Set<Frame>();
  let frame: number | null = null;
  const loop = (now: number) => {
    frame = null;
    for (const listener of listeners) listener(now);
    schedule();
  };
  const schedule = () => {
    if (frame === null && listeners.size && !clock.doc?.hidden) frame = clock.raf(loop);
  };
  const stop = () => {
    if (frame !== null) clock.caf(frame);
    frame = null;
  };
  const onVisibility = () => (clock.doc?.hidden ? stop() : schedule());
  return {
    subscribe(listener: Frame): () => void {
      if (!listeners.size) clock.doc?.addEventListener("visibilitychange", onVisibility);
      listeners.add(listener);
      schedule();
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        stop();
        clock.doc?.removeEventListener("visibilitychange", onVisibility);
      };
    },
    get running() { return frame !== null; },
  };
}

export const mascotTicker = createTicker({
  raf: (fn) => requestAnimationFrame(fn),
  caf: (id) => cancelAnimationFrame(id),
  doc: typeof document === "undefined" ? null : document,
});
