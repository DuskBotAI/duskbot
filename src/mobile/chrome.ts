import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { PlatformContext, type BarConfig, type MobileChrome } from "./platform";

/** The system's bar and sheet, where the device has them. Null too for a sheet drawn outside the phone's shell. */
export function useChrome(): MobileChrome | null {
  return useContext(PlatformContext)?.chrome ?? null;
}

/** True when the device supports native UIKit navigation pushes inside a sheet. */
export function useNativePush(): boolean {
  const target = useChrome();
  return Boolean(target?.beginPush && target?.commitPush && target?.popPage);
}

/** Depth of pushed views inside a sheet (0 at the sheet's root). */
export const PushDepthContext = createContext(0);

export function useSheetPushDepth(): number {
  return useContext(PushDepthContext);
}

/** Who draws the bar, lowest first: the list, a chat over it, a sheet over both (then a page stacked inside the sheet,
 * then one pushed over that page), then the screens that cover everything (linking a computer, signing in) and the
 * camera over those. */
export const BAR_RANK = { home: 0, chat: 1, sheet: 2, sheetPage: 2.25, sheetPushed: 2.5, screen: 3, camera: 4 } as const;

/** "none": this screen is in front and wants no bar. */
type OwnerBar = BarConfig | "none";
interface Owner { rank: number; config: OwnerBar; press: (id: string) => void }

const owners = new Map<symbol, Owner>();
let chrome: MobileChrome | null = null;
let sent = "";
let queued = false;
let covered = false;
let homeBarShown = false;
let homeBarMeasure = 0;
let stopWatching: (() => void) | null = null;

function top(): Owner | null {
  let best: Owner | null = null;
  for (const owner of owners.values()) if (!best || owner.rank >= best.rank) best = owner;
  return best;
}

function measureHomeBarTop(): void {
  const root = document.querySelector<HTMLElement>(".dusk-mobile") ?? document.documentElement;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;height:var(--m-safe-top)";
  root.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  if (height > 0) document.documentElement.style.setProperty("--m-home-bar-top", `${height}px`);
}

function scheduleHomeBarMeasure(): void {
  cancelAnimationFrame(homeBarMeasure);
  homeBarMeasure = requestAnimationFrame(() => {
    homeBarMeasure = requestAnimationFrame(() => {
      homeBarMeasure = 0;
      if (homeBarShown) measureHomeBarTop();
    });
  });
}

/** Something of the page's own (a call, a viewer, the linking screens) lies over the screen that owns the bar. */
function isCovered(): boolean {
  const owner = top();
  if (!owner || owner.rank >= BAR_RANK.sheet || owner.config === "none") return false;
  const owned = (x: number) => {
    const hit = document.elementFromPoint(x, 30);
    return Boolean(hit?.closest("[data-bar-screen], .mobile-page[data-leaving]"));
  };
  return !owned(4) && !owned(window.innerWidth - 4);
}

function publish(): void {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    if (!chrome) return;
    const owner = top();
    const config = owner && !covered && owner.config !== "none" ? owner.config : null;
    const next = JSON.stringify(config);
    if (next === sent) return;
    const nextHomeShown = Boolean(config && owner?.rank === BAR_RANK.home);
    if (homeBarShown && !nextHomeShown) measureHomeBarTop();
    homeBarShown = nextHomeShown;
    if (config) delete document.documentElement.dataset.nativeBarHidden;
    else document.documentElement.dataset.nativeBarHidden = "";
    sent = next;
    chrome.setBar(config);
    if (nextHomeShown) scheduleHomeBarMeasure();
  });
}

function watch(target: MobileChrome): () => void {
  let frame = 0;
  const check = () => {
    frame = 0;
    const next = isCovered();
    if (next !== covered) { covered = next; publish(); }
  };
  const later = () => { if (!frame) frame = requestAnimationFrame(check); };
  const onResize = () => { if (homeBarShown) scheduleHomeBarMeasure(); };
  const observer = new MutationObserver(later);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", onResize);
  const stopPress = target.onBarPress((id) => top()?.press(id));
  const stopPictures = target.onPictureTaken((key) => { taken.add(key); for (const listener of pictureListeners) listener(); });
  return () => { observer.disconnect(); window.removeEventListener("resize", onResize); cancelAnimationFrame(frame); cancelAnimationFrame(homeBarMeasure); stopPress(); stopPictures(); };
}

/** Puts `config` in the system's bar while this is the frontmost screen that asks, and sends its buttons' presses to
 * `handlers` by item id. False where the device has no bar of its own: the screen draws its own controls then. */
export function useNativeBar(rank: number, config: OwnerBar | null, handlers: Record<string, () => void>): boolean {
  const target = useChrome();
  const key = useRef(Symbol("bar"));
  const latest = useRef(handlers);
  latest.current = handlers;
  const json = config ? JSON.stringify(config) : null;
  useEffect(() => {
    if (!target || !json) return;
    chrome = target;
    stopWatching ??= watch(target);
    owners.set(key.current, { rank, config: JSON.parse(json) as OwnerBar, press: (id) => latest.current[id]?.() });
    covered = isCovered();
    publish();
    const owner = key.current;
    return () => { owners.delete(owner); covered = isCovered(); publish(); };
  }, [target, rank, json]);
  return Boolean(target);
}

const taken = new Set<string>();
const pictureListeners = new Set<() => void>();

/** Whether the device already keeps the picture under `key`; until then the page shows it once to be photographed. */
export function usePictureTaken(key: string): boolean {
  return useSyncExternalStore(
    (listener) => { pictureListeners.add(listener); return () => pictureListeners.delete(listener); },
    () => taken.has(key),
  );
}

/** The system presents one sheet. A sheet opened from inside another draws over it in the same one; a sheet that takes
 * another's place (Settings to Notifications) keeps it up and changes what is in it; it comes down when the last of the
 * page's sheets has closed and none is on its way. `count`: sheets up; `opening`: sheets asked for and not up yet;
 * `system`: the system's sheet is presented. */
export const sheetsUp = { count: 0, opening: 0, system: false };

let chain: Promise<unknown> = Promise.resolve();

/** Sheet steps run one after another: a sheet closing and the next one opening never interleave. */
export function sheetStep(work: () => Promise<void>): void {
  chain = chain.then(work, work);
}

export function frames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => tick(left - 1)));
    tick(count);
  });
}
