export const SUBMENU_DWELL_MS = 100;
export const SUBMENU_GRACE_MS = 300;
export const SUBMENU_POINTER_BUFFER = 10;
export const SUBMENU_EDGE_PAD = 12;

export type Point = { x: number; y: number };
export type Box = { left: number; right: number; top: number; bottom: number };
export type BridgeRect = { left: number; top: number; width: number; height: number };

export function towardSubmenu(from: Point, point: Point, submenu: Box): boolean {
  if (submenu.right <= submenu.left || submenu.bottom <= submenu.top) return false;
  const top = submenu.top - SUBMENU_EDGE_PAD;
  const bottom = submenu.bottom + SUBMENU_EDGE_PAD;
  let t: number;
  if (from.x < submenu.left) {
    if (point.x <= from.x || point.x > submenu.right) return false;
    t = Math.min(1, (point.x - from.x) / (submenu.left - from.x));
  } else if (from.x > submenu.right) {
    if (point.x >= from.x || point.x < submenu.left) return false;
    t = Math.min(1, (from.x - point.x) / (from.x - submenu.right));
  } else {
    return point.x >= submenu.left && point.x <= submenu.right && point.y >= top && point.y <= bottom;
  }
  const minY = (from.y - SUBMENU_POINTER_BUFFER) + (top - (from.y - SUBMENU_POINTER_BUFFER)) * t;
  const maxY = (from.y + SUBMENU_POINTER_BUFFER) + (bottom - (from.y + SUBMENU_POINTER_BUFFER)) * t;
  return point.y >= minY && point.y <= maxY;
}

export function submenuBridgeBox(menu: Box, row: Box, submenu: Box): BridgeRect | null {
  if (submenu.right <= submenu.left || submenu.bottom <= submenu.top) return null;
  const onRight = submenu.left >= menu.right;
  const onLeft = submenu.right <= menu.left;
  if (!onRight && !onLeft) return null;
  const rawLeft = onRight ? menu.right : submenu.right;
  const rawRight = onRight ? submenu.left : menu.left;
  if (rawRight <= rawLeft) return null;
  // 1px overlap into each sheet's padding prevents DPR subpixel cracks from firing pointerleave in the gap.
  const left = Math.floor(rawLeft) - 1;
  const right = Math.ceil(rawRight) + 1;
  const hasRow = row.bottom > row.top;
  const top = Math.max(0, (hasRow ? Math.min(submenu.top, row.top) : submenu.top) - SUBMENU_EDGE_PAD);
  const bottom = (hasRow ? Math.max(submenu.bottom, row.bottom) : submenu.bottom) + SUBMENU_EDGE_PAD;
  return { left, top, width: right - left, height: bottom - top };
}

export interface SubmenuIntent {
  enterRow(key: string, hasSubmenu: boolean, point: Point): void;
  leaveRow(key: string): void;
  move(point: Point, onOpenRow: boolean): void;
  leaveMenu(point?: Point): void;
  enterSubmenu(): void;
  openNow(key: string, point?: Point): void;
  closeNow(): void;
  reset(): void;
  readonly openKey: string | null;
}

export function attachSubmenuAim(
  intent: () => SubmenuIntent | null,
  refs: {
    menu: () => HTMLElement | null;
    submenu: () => HTMLElement | null;
    bridge: () => HTMLElement | null;
  },
): (aiming: boolean) => void {
  let listening = false;
  const onMove = (event: PointerEvent) => {
    const target = event.target;
    if (target instanceof Node && (refs.menu()?.contains(target) || refs.submenu()?.contains(target) || refs.bridge()?.contains(target))) return;
    intent()?.move({ x: event.clientX, y: event.clientY }, false);
  };
  return (aiming) => {
    refs.menu()?.toggleAttribute?.("data-submenu-aiming", aiming);
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    if (aiming && !listening) {
      listening = true;
      window.addEventListener("pointermove", onMove);
    } else if (!aiming && listening) {
      listening = false;
      window.removeEventListener("pointermove", onMove);
    }
  };
}

const WINDOW_TIMERS = { set: (run: () => void, ms: number) => setTimeout(run, ms), clear: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle) };

export function submenuIntent({ open, close, submenuBox, onAimingChange, timers = WINDOW_TIMERS }: {
  open: (key: string) => void;
  close: () => void;
  submenuBox: () => Box | null;
  onAimingChange?: (aiming: boolean) => void;
  timers?: { set: (run: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (handle: ReturnType<typeof setTimeout>) => void };
}): SubmenuIntent {
  let openKey: string | null = null;
  let dwell: { key: string; point: Point; handle: ReturnType<typeof setTimeout> } | null = null;
  let grace: ReturnType<typeof setTimeout> | null = null;
  let aiming = false;
  let anchor: Point | null = null;

  const setAiming = (next: boolean) => {
    if (aiming === next) return;
    aiming = next;
    onAimingChange?.(next);
  };
  const cancelDwell = () => {
    if (dwell) timers.clear(dwell.handle);
    dwell = null;
  };
  const cancelGrace = () => {
    if (grace) timers.clear(grace);
    grace = null;
    setAiming(false);
  };
  const startGrace = (ms: number, aim: boolean) => {
    if (grace) timers.clear(grace);
    grace = timers.set(closeNow, ms);
    setAiming(aim);
  };
  const closeNow = () => {
    cancelGrace();
    if (openKey === null) return;
    openKey = null;
    anchor = null;
    close();
  };
  const openNow = (key: string, point?: Point) => {
    cancelDwell();
    cancelGrace();
    if (point) anchor = point;
    if (openKey === key) return;
    openKey = key;
    open(key);
  };
  const heading = (point: Point) => {
    const box = submenuBox();
    return Boolean(anchor && box && towardSubmenu(anchor, point, box));
  };

  return {
    enterRow(key, hasSubmenu, point) {
      cancelDwell();
      if (openKey !== null && key === openKey) {
        cancelGrace();
        anchor = point;
        return;
      }
      if (openKey !== null) {
        if (heading(point)) {
          if (!grace) startGrace(SUBMENU_GRACE_MS, true);
        } else {
          closeNow();
        }
      }
      if (hasSubmenu) {
        const entry = { key, point, handle: undefined as unknown as ReturnType<typeof setTimeout> };
        entry.handle = timers.set(() => openNow(key, entry.point), SUBMENU_DWELL_MS);
        dwell = entry;
      }
    },
    leaveRow(key) {
      if (dwell?.key === key) cancelDwell();
    },
    move(point, onOpenRow) {
      if (onOpenRow) {
        anchor = point;
        return;
      }
      if (dwell) dwell.point = point;
      if (!grace) return;
      if (!heading(point)) closeNow();
      else startGrace(SUBMENU_GRACE_MS, true);
    },
    // Deferred one tick so a synchronous pointerenter on the bridge or submenu can cancel the close.
    leaveMenu(point?: Point) {
      cancelDwell();
      if (openKey === null) return;
      if (point && heading(point)) {
        startGrace(SUBMENU_GRACE_MS, true);
        return;
      }
      startGrace(0, false);
    },
    enterSubmenu() {
      cancelGrace();
      anchor = null;
    },
    openNow,
    closeNow,
    reset() {
      cancelDwell();
      cancelGrace();
      openKey = null;
      anchor = null;
    },
    get openKey() {
      return openKey;
    },
  };
}
