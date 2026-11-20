import { useEffect, type RefObject } from "react";
import { covered, cssHex, darkGround, restingFrame, type GlassFrame } from "./native-glass";
import type { MobilePlatform } from "./platform";

export type HomeGlassKind = "search" | "newBot";
export interface HomeGlassButton { kind: HomeGlassKind; frame: GlassFrame; label: string }
/** Home's top buttons for the native glass to draw (ios/App/App/GlassHomeBar.swift); every frame is where the button
 * rests on the list, before the list's own parallax under a chat page. */
export interface HomeGlassState { dark: boolean; buttons: HomeGlassButton[] }

const KINDS: readonly HomeGlassKind[] = ["search", "newBot"];
const IDLE_EVERY = 15;
const FRESH_FRAMES = 30;

/** The list's own offset: it moves a third as far as a chat page sliding over it. */
function listOffset(bar: Element): number {
  return bar.closest(".mobile-nav")?.firstElementChild?.getBoundingClientRect().left ?? 0;
}

/** The buttons the native bar draws now, or null when the page must draw its own: a sheet, menu or dialog covers them,
 * or a chat page rests over the list. */
export function readHomeGlass(root: HTMLElement): HomeGlassButton[] | null {
  const bar = root.querySelector<HTMLElement>("[data-home-bar]");
  if (!bar) return null;
  if (root.querySelector(".mobile-page:not([data-moving])")) return null;
  const dx = listOffset(bar);
  const buttons: HomeGlassButton[] = [];
  for (const kind of KINDS) {
    const el = bar.querySelector<HTMLElement>(`[data-home-glass="${kind}"]`);
    if (!el) continue;
    // a chat page sliding over the list covers the button by design: the native bar is clipped at its edge instead
    if (!root.querySelector(".mobile-page[data-moving]") && covered(el, bar)) return null;
    buttons.push({ kind, frame: restingFrame(el, dx), label: el.getAttribute("aria-label") ?? "" });
  }
  return buttons.length ? buttons : null;
}

/** While the native glass can draw Home's Search and New bot buttons it does, and hands their taps back to the page's
 * own, which stay in place unseen. */
export function useNativeHomeGlass(platform: MobilePlatform, rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const glass = platform.glass;
    const root = rootRef.current;
    if (!glass?.home || !root) return;
    const html = document.documentElement;
    let frame = 0;
    let count = 0;
    let fresh = FRESH_FRAMES;
    let last = "";
    const changed = new MutationObserver(() => { fresh = FRESH_FRAMES; });
    changed.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "data-moving", "data-sheet-open", "aria-hidden"] });
    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (document.hidden) return;
      count += 1;
      if (fresh > 0) fresh -= 1;
      else if (count % IDLE_EVERY !== 0) return;
      const buttons = readHomeGlass(root);
      const state: HomeGlassState | null = buttons && {
        dark: darkGround(cssHex(getComputedStyle(root).getPropertyValue("--color-app"))) ?? root.dataset.scheme === "dark",
        buttons,
      };
      const key = JSON.stringify(state);
      if (key === last) return;
      last = key;
      if (state) html.dataset.nativeGlassHome = ""; else delete html.dataset.nativeGlassHome;
      glass.home!(state);
    };
    const stop = glass.onEvent((event) => {
      if (event.type !== "tap" || (event.target !== "search" && event.target !== "newBot")) return;
      root.querySelector<HTMLElement>(`[data-home-bar] [data-home-glass="${event.target}"]`)?.click();
    });
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      changed.disconnect();
      stop();
      delete html.dataset.nativeGlassHome;
      glass.home!(null);
    };
  }, [platform, rootRef]);
}
