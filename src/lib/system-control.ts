import { useEffect, useId, useRef, useState, type RefObject } from "react";

export interface SystemPopupOption {
  key: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  separated?: boolean;
}

/** A system control drawn where the page leaves room for it. */
export type SystemControl =
  | { kind: "segmented"; items: string[]; selected: number; disabled?: boolean; label?: string }
  /** `tint`: the colour of the switch when on, any css colour; the device's own (green) without one. */
  | { kind: "switch"; on: boolean; tint?: string; disabled?: boolean; label?: string }
  | { kind: "popup"; title: string; value: string; options: SystemPopupOption[]; disabled?: boolean; label?: string };

/** Where the room is. `room` is in the coordinates of the scrolling area's content, `clip` is that area in the viewport
 * and `inset` how much of its top a bar covers; with no scrolling area, room and clip are in the viewport. All css px. */
export interface ControlPlace {
  room: { x: number; y: number; width: number; height: number };
  clip: { x: number; y: number; width: number; height: number };
  inset: number;
  scrollTop: number;
  scrollHeight: number;
  scrollable: boolean;
  /** Something of the page's own lies over the room. */
  hidden: boolean;
  /** Combined opacity of the room's ancestors (0..1), so a control fades in lockstep with a transitioning view. */
  alpha: number;
  /** Leading edge (in viewport CSS px) of a sliding pushed page over this control, so the native clip masks right at it. */
  maskRight?: number;
}

/** The device's own segmented control, switch and pop-up menu button, in the page. `place` resolves false when the device
 * cannot follow the page's scrolling there. */
export interface SystemControls {
  place(id: string, control: SystemControl, place: ControlPlace): Promise<boolean>;
  trigger?(id: string): Promise<boolean>;
  remove(id: string): void;
  onChange(listener: (id: string, value: number | boolean | string) => void): () => void;
}

/** The room a control leaves for the device's switch: the system's size (63 by 28 from iOS 26), drawn as nothing. */
export const SYSTEM_SWITCH_ROOM = { width: 63, height: 28, visibility: "hidden" } as const;

let installed: SystemControls | null = null;

/** The phone app installs its platform's controls here, so shared controls use them without knowing the phone layer. */
export function installSystemControls(next: SystemControls | null): void {
  installed = next;
}

function scrollingArea(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

const hexColours = new Map<string, string | undefined>();

/** A css colour as #rrggbb, read in `el`'s place in the page so its custom properties resolve. */
function hexColour(css: string, el: HTMLElement): string | undefined {
  const skin = document.documentElement.dataset.skin ?? "";
  const key = `${skin}|${css}`;
  if (hexColours.has(key)) return hexColours.get(key);
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  probe.style.color = css;
  el.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  let hex: string | undefined;
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (context && resolved) {
    context.fillStyle = resolved;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    hex = `#${[r, g, b].map((part) => (part ?? 0).toString(16).padStart(2, "0")).join("")}`;
  }
  hexColours.set(key, hex);
  return hex;
}

let safeTopProbe: HTMLElement | null = null;

/** Where the system's bar ends, in css px: the top safe area, which a custom property cannot be read back as. */
function safeTop(): number {
  if (!safeTopProbe?.isConnected) {
    safeTopProbe = document.createElement("div");
    safeTopProbe.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px)";
    document.body.append(safeTopProbe);
  }
  return Number.parseFloat(getComputedStyle(safeTopProbe).paddingTop) || 0;
}

const waiters = new Set<() => void>();
const pokers = new Set<() => void>();
const flushers = new Set<() => Promise<void>>();
const triggers = new WeakMap<HTMLElement, () => Promise<boolean>>();
let domObserver: MutationObserver | null = null;
let pokeQueued = false;

function schedulePoke(): void {
  if (pokeQueued || pokers.size === 0) return;
  pokeQueued = true;
  queueMicrotask(() => {
    pokeQueued = false;
    for (const poke of pokers) poke();
  });
}

function syncDomObserver(): void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined" || !document.body) return;
  if (pokers.size > 0 && !domObserver) {
    domObserver = new MutationObserver(schedulePoke);
    domObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-leaving", "data-moving", "inert", "hidden", "aria-hidden", "open"],
    });
  } else if (pokers.size === 0 && domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }
}

/** Tells mounted system controls to track frame-by-frame while a view transition (such as a tab swap) runs. */
export function wakeSystemControls(): void {
  for (const wake of waiters) wake();
}

/** Syncs every mounted system control immediately and resolves once their native placements commit (or `timeoutMs` passes). */
export function flushSystemControls(timeoutMs = 150): Promise<void> {
  if (flushers.size === 0) return Promise.resolve();
  const pending = [...flushers].map((flush) => flush().catch(() => {}));
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    void Promise.all(pending).then(finish, finish);
  });
}

/** Triggers a mounted native control's primary action (e.g. opening a pop-up button's menu from a row tap). */
export async function triggerSystemControl(el: HTMLElement | null): Promise<boolean> {
  if (!el) return false;
  const run = triggers.get(el);
  return run ? run() : false;
}

const OVERLAY_SEL = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[aria-modal="true"]',
  '[data-panel-scrim]',
  '[data-modal-scrim]',
  '[data-phone-modal-layer]',
  '[data-phone-pushed-page]',
  '[data-phone-bot-page]',
  '.popover-surface',
  '.menu-surface',
  '.dusk-mobile-overlay',
  '.ui-toast',
].join(", ");

const ACTIVE_SLIDE_SEL = [
  "[data-phone-pushed-page][data-leaving]",
  "[data-phone-pushed-page][data-moving]",
  ".mobile-page[data-leaving]",
  ".mobile-page[data-moving]",
].join(", ");

const ROW_SEL = "[data-panel-row], [data-panel-routine], [data-select-row], [data-simple-app], [data-settings-row], .mobile-row, [role='switch'], [role='group'], label";

function coveredByForeignLayer(el: HTMLElement, hit: Element | null): boolean {
  if (!hit) return false;
  const overlay = hit.closest(OVERLAY_SEL);
  if (overlay && !overlay.contains(el)) return true;
  const page = hit.closest(".mobile-page");
  if (page && !page.contains(el)) return true;
  return false;
}

function ownHit(el: HTMLElement, hit: Element | null): boolean {
  if (el.closest(".mobile-nav > [inert]")) {
    return !coveredByForeignLayer(el, hit);
  }
  if (!hit) return false;
  const overlay = hit.closest(OVERLAY_SEL);
  if (overlay && !overlay.contains(el)) return false;
  if (el.contains(hit) || hit.contains(el)) return true;
  const row = el.parentElement?.closest(ROW_SEL);
  return Boolean(row && row.contains(hit));
}

function areaUncovered(area: HTMLElement, hit: Element | null): boolean {
  if (area.closest(".mobile-nav > [inert]")) {
    return !coveredByForeignLayer(area, hit);
  }
  if (!hit || !area.contains(hit)) return false;
  const overlay = hit.closest(OVERLAY_SEL);
  return !overlay || overlay.contains(area);
}

function ancestorOpacity(el: HTMLElement): number {
  let opacity = 1;
  for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
    const value = Number.parseFloat(getComputedStyle(node).opacity);
    if (Number.isFinite(value)) opacity *= value;
    if (opacity <= 0.001) return 0;
  }
  return Math.max(0, Math.min(1, opacity));
}

function coveringLeft(el: HTMLElement): number | null {
  const modal = document.querySelector("[data-phone-modal-layer]:not([data-leaving])");
  if (modal && !modal.contains(el)) return -Infinity;
  const inModal = Boolean(el.closest("[data-phone-modal-layer]"));
  let left = Infinity;
  if (!inModal) {
    const ownPushed = el.closest<HTMLElement>("[data-phone-pushed-page], [data-phone-bot-page]");
    const ownZ = ownPushed ? Number.parseInt(getComputedStyle(ownPushed).zIndex, 10) || 0 : -Infinity;
    for (const pushed of document.querySelectorAll<HTMLElement>("[data-phone-pushed-page]:not([data-preparing]), [data-phone-bot-page]:not([data-preparing])")) {
      if (pushed === ownPushed || pushed.contains(el)) continue;
      if (ownPushed) {
        const z = Number.parseInt(getComputedStyle(pushed).zIndex, 10) || 0;
        if (z < ownZ) continue;
        if (z === ownZ && (ownPushed.compareDocumentPosition(pushed) & Node.DOCUMENT_POSITION_PRECEDING) !== 0) continue;
      }
      left = Math.min(left, pushed.getBoundingClientRect().left);
    }
  }
  const nav = el.closest(".mobile-nav");
  if (nav) {
    for (const page of nav.querySelectorAll<HTMLElement>(":scope > .mobile-page")) {
      if (page.contains(el)) continue;
      left = Math.min(left, page.getBoundingClientRect().left);
    }
  }
  return Number.isFinite(left) ? left : null;
}

function probeHidden(
  el: HTMLElement,
  rect: DOMRect,
  clip: DOMRect,
  visibleTop: number,
  visibleBottom: number,
  maskRight: number | undefined,
  area: HTMLElement | null,
  lastHidden: boolean,
): boolean {
  if (typeof document.elementFromPoint !== "function") return lastHidden;
  const rightBound = maskRight !== undefined ? Math.min(clip.right, maskRight) : clip.right;
  const visLeft = Math.max(clip.left + 2, rect.left + 4);
  const visRight = Math.min(rightBound - 2, rect.right - 4);
  const visTop = Math.max(visibleTop + 2, rect.top + 3);
  const visBottom = Math.min(visibleBottom - 2, rect.bottom - 3);
  if (visRight > visLeft && visBottom > visTop) {
    const midX = (visLeft + visRight) / 2;
    const midY = (visTop + visBottom) / 2;
    const points: Array<[number, number]> = [
      [midX, midY],
      [visLeft, midY],
      [visRight, midY],
      [midX, visTop],
      [midX, visBottom],
    ];
    for (const [x, y] of points) {
      if (!ownHit(el, document.elementFromPoint(x, y))) return true;
    }
    return false;
  }
  if (visibleBottom - visibleTop > 16 && rightBound - clip.left > 16) {
    const hit = document.elementFromPoint((clip.left + rightBound) / 2, (visibleTop + visibleBottom) / 2);
    return area ? !areaUncovered(area, hit) : !ownHit(el, hit);
  }
  return lastHidden;
}

function placeOf(el: HTMLElement, lastHidden: boolean): ControlPlace {
  const rect = el.getBoundingClientRect();
  const area = scrollingArea(el);
  const clip = area?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  const inset = Math.max(0, safeTop() - clip.top);
  const visibleTop = Math.max(0, clip.top + inset);
  const visibleBottom = Math.min(window.innerHeight, clip.bottom);
  const coverLeft = coveringLeft(el);
  const fullyCovered = coverLeft !== null && coverLeft <= Math.max(clip.left, rect.left) + 1;
  const maskRight = !fullyCovered && coverLeft !== null && coverLeft < clip.right - 0.5 ? Math.round(coverLeft * 10) / 10 : undefined;
  const hidden = fullyCovered || probeHidden(el, rect, clip, visibleTop, visibleBottom, maskRight, area, lastHidden);
  const alpha = Math.round(ancestorOpacity(el) * 1000) / 1000;
  return {
    room: { x: rect.left - clip.left + (area?.scrollLeft ?? 0), y: rect.top - clip.top + (area?.scrollTop ?? 0), width: rect.width, height: rect.height },
    clip: { x: clip.left, y: clip.top, width: clip.width, height: clip.height },
    inset,
    scrollTop: area?.scrollTop ?? 0,
    scrollHeight: area?.scrollHeight ?? 0,
    scrollable: Boolean(area && area.scrollHeight > area.clientHeight + 1),
    hidden,
    alpha,
    ...(maskRight !== undefined ? { maskRight } : {}),
  };
}

/** Draws the system's own control in the room `ref` leaves for it, and hears its changes. False where the device has
 * none, or cannot keep it in step with the page there: the caller draws its own control then. The room's place is read
 * again a few times a second, since nothing tells a page that something above the room grew. */
export function useSystemControl(ref: RefObject<HTMLElement | null>, control: SystemControl | null, onChange: (value: number | boolean | string) => void): boolean {
  const controls = control ? installed : null;
  const id = useId();
  const [refused, setRefused] = useState(false);
  const latest = useRef({ control, onChange });
  latest.current = { control, onChange };
  const syncRef = useRef<(() => void) | null>(null);
  const active = Boolean(controls) && !refused;
  const signature = active && control ? JSON.stringify(control) : "";
  useEffect(() => {
    if (!controls || refused) return;
    let sent = "";
    let hidden = false;
    let stopped = false;
    let frame = 0;
    let steady = 0;
    let syncing = false;
    let inFlight: Promise<unknown> = Promise.resolve();
    let lastPos: { x: number; y: number; clipX: number; maskRight?: number; alpha: number } | null = null;
    // the device learns of a scrolling area a moment after the page draws it: only an area it still cannot follow after
    // sustained retries (never a burst of microtask/frame checks during a transition) is given up on
    let misses = 0;
    let lastMissAt = 0;
    const schedule = () => {
      if (stopped || frame || syncing) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        sync(true);
      });
    };
    const sync = (fromFrame = false) => {
      const el = ref.current;
      if (stopped || syncing) return;
      syncing = true;
      let needNext = false;
      try {
        // the room left the page while its owner stays (a sheet's content closed): the control goes with it
        if (!el) { if (sent) { sent = ""; controls.remove(id); } return; }
        if (controls.trigger) triggers.set(el, () => controls.trigger!(id));
        const prevHidden = hidden;
        const place = placeOf(el, hidden);
        hidden = place.hidden;
        const moved = lastPos !== null && (
          Math.abs(place.room.x - lastPos.x) > 0.25
          || Math.abs(place.room.y - lastPos.y) > 0.25
          || Math.abs(place.clip.x - lastPos.clipX) > 0.25
          || place.maskRight !== lastPos.maskRight
          || Math.abs(place.alpha - lastPos.alpha) > 0.005
        );
        lastPos = { x: place.room.x, y: place.room.y, clipX: place.clip.x, maskRight: place.maskRight, alpha: place.alpha };
        const activeSlide = document.querySelector(ACTIVE_SLIDE_SEL) !== null;
        if (activeSlide || place.alpha < 0.995 || moved || place.maskRight !== undefined || place.hidden !== prevHidden) {
          steady = 0;
          needNext = true;
        } else if (fromFrame) {
          steady += 1;
          if (steady < 4) needNext = true;
        }
        const asked = latest.current.control;
        if (!asked) return;
        const shown = asked.kind === "switch" && asked.tint ? { ...asked, tint: hexColour(asked.tint, el) } : asked;
        const next = JSON.stringify([shown, place]);
        if (next === sent) return;
        sent = next;
        const placing = controls.place(id, shown, place).then((tracked) => {
          if (stopped) return;
          if (tracked) { misses = 0; lastMissAt = 0; return; }
          if (place.alpha < 0.99 || place.maskRight !== undefined || place.hidden) { sent = ""; return; }
          const now = performance.now();
          if (now - lastMissAt >= 200) {
            misses += 1;
            lastMissAt = now;
          }
          sent = "";
          if (misses >= 6) setRefused(true);
        }, () => {});
        inFlight = placing;
      } finally {
        syncing = false;
      }
      if (needNext) schedule();
    };
    const wake = () => {
      steady = 0;
      sync(true);
      schedule();
    };
    const flush = (): Promise<void> => {
      steady = 0;
      sync(true);
      schedule();
      return inFlight.then(() => {}, () => {});
    };
    const poke = () => sync(false);
    syncRef.current = poke;
    waiters.add(wake);
    pokers.add(poke);
    flushers.add(flush);
    syncDomObserver();
    sync(false);
    const timer = window.setInterval(() => sync(false), 250);
    const stopChanges = controls.onChange((changed, value) => {
      if (changed !== id) return;
      latest.current.onChange(value);
      if (latest.current.control?.kind === "segmented") wakeSystemControls();
    });
    return () => {
      stopped = true;
      syncRef.current = null;
      waiters.delete(wake);
      pokers.delete(poke);
      flushers.delete(flush);
      syncDomObserver();
      if (ref.current) triggers.delete(ref.current);
      if (frame) window.cancelAnimationFrame(frame);
      window.clearInterval(timer);
      stopChanges();
      controls.remove(id);
    };
  }, [controls, refused, id, ref]);
  useEffect(() => {
    if (signature) syncRef.current?.();
  }, [signature]);
  return active;
}
