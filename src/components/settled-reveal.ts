import { useEffect, useState, type RefObject } from "react";

/** A block whose parts load on their own is shown once its size has held this long. */
export const SETTLE_QUIET_MS = 160;
/** and at the latest after this, whatever is still loading */
export const SETTLE_MAX_MS = 1200;

/** Watches a block's size: `onSettled` runs once it has not changed for `quiet` ms, or after `max` ms at the latest. */
export function watchSettled(element: Element, onSettled: () => void, { quiet = SETTLE_QUIET_MS, max = SETTLE_MAX_MS } = {}): () => void {
  let done = false;
  let timer = setTimeout(finish, quiet);
  const cap = setTimeout(finish, max);
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(finish, quiet);
  });
  observer?.observe(element);
  function finish() {
    if (done) return;
    done = true;
    stop();
    onSettled();
  }
  function stop() {
    clearTimeout(timer);
    clearTimeout(cap);
    observer?.disconnect();
  }
  return stop;
}

/** The block's first visible paint is its settled layout: it stays invisible (taking its space) while its parts load and
 * move it, then shows at once. */
export function useSettledReveal(ref: RefObject<Element | null>): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || shown) return;
    return watchSettled(element, () => setShown(true));
  }, [ref, shown]);
  return shown;
}
