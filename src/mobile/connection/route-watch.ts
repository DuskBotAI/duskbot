import type { PhoneTransport } from "../transport/transport";

/** silence from the place this long, while the phone is online and open, means the route it took may be gone */
export const ROUTE_STUCK_MS = 45_000;
export const ROUTE_CHECK_MS = 15_000;

export interface RouteWatch {
  /** the newest time the place answered anything: a request or the live stream */
  heardAt: () => number | null;
  online: () => boolean;
  visible: () => boolean;
  /** walks the record's routes again in the background; the screen stays as it is */
  rewalk: () => Promise<void>;
  /** the phone changed networks: the route it holds may be gone at once, so the walk runs without waiting for silence */
  onNetworkChange?: (listener: () => void) => () => void;
  now?: () => number;
  every?: (run: () => void, ms: number) => () => void;
}

/** A phone keeps the route it connected on (one Wi-Fi address of the computer, say) until the app starts again, so a
 * computer whose address changed, or a dock unplugged, left it reconnecting to nothing while another route worked. */
export function watchRoute(watch: RouteWatch): () => void {
  const now = watch.now ?? Date.now;
  const every = watch.every ?? ((run, ms) => { const timer = setInterval(run, ms); return () => clearInterval(timer); });
  const startedAt = now();
  let lastWalk = -Infinity;
  let walking = false;
  let stopped = false;
  const check = (moved = false) => {
    if (stopped || walking || !watch.online() || !watch.visible()) return;
    const at = now();
    if (!moved && (at - Math.max(watch.heardAt() ?? startedAt, startedAt) < ROUTE_STUCK_MS || at - lastWalk < ROUTE_STUCK_MS)) return;
    lastWalk = at;
    walking = true;
    void watch.rewalk().catch(() => {}).finally(() => { walking = false; });
  };
  const stop = every(() => check(), ROUTE_CHECK_MS);
  const unlisten = watch.onNetworkChange?.(() => check(true));
  return () => { stopped = true; stop(); unlisten?.(); };
}

/** the same way to the place: a new transport over it would only drop the one that works as well */
export function sameRoute(a: PhoneTransport, b: PhoneTransport): boolean {
  if (a.kind === "relay" || b.kind === "relay") return a.kind === b.kind;
  return a.origin === b.origin;
}
