import { useEffect, useRef } from "react";
import type { GlassBridge, GlassFrame } from "./native-glass";

export interface TakeoverGlassMenuItem {
  key: string;
  label: string;
  detail?: string;
  symbol?: string;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  separated?: boolean;
}

export type TakeoverGlassButtonId = "back" | "help" | "more" | "clipboard" | "control" | "keyboard";

export interface TakeoverGlassButton {
  id: TakeoverGlassButtonId;
  frame: GlassFrame;
  label: string;
  symbol?: string;
  symbolSize?: number;
  symbolWeight?: "medium" | "semibold";
  title?: string;
  compact?: boolean;
  disabled?: boolean;
  busy?: boolean;
  interactive?: boolean;
  menu?: TakeoverGlassMenuItem[];
}

export interface TakeoverGlassState {
  buttons: TakeoverGlassButton[];
}

export interface SwipeReplyGlassState {
  x: number;
  y: number;
  restX: number;
  size: number;
  progress: number;
  overscroll?: number;
  armed: boolean;
  dark: boolean;
}

export interface PullRefreshGlassState {
  y: number;
  progress: number;
  armed: boolean;
  refreshing: boolean;
  dark: boolean;
}

export interface ViewerGlassState {
  visible: boolean;
  close: GlassFrame;
  closeLabel: string;
  share?: GlassFrame | null;
  shareLabel?: string;
  sharing?: boolean;
  countText?: string | null;
  countY?: number;
}

export interface FloatingPillGlassState {
  slot: "top" | "bottom";
  id: string;
  text: string;
  tone?: "neutral" | "success" | "error";
  symbol?: string;
  trailingSymbol?: string;
  spinner?: boolean;
  offset: number;
  dark: boolean;
  tappable?: boolean;
  actionLabel?: string;
  actionDisabled?: boolean;
  dismissible?: boolean;
}

export function cssPx(root: HTMLElement, expression: string): number {
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;visibility:hidden;height:${expression}`;
  root.appendChild(probe);
  const value = probe.getBoundingClientRect().height;
  probe.remove();
  return value;
}

export function isGlassDark(): boolean {
  const html = typeof document === "undefined" ? null : document.documentElement;
  if (html?.dataset?.skin === "grok-dark") return true;
  if (html?.dataset?.skin === "grok-light") return false;
  const shell = html?.querySelector?.<HTMLElement>(".dusk-mobile");
  if (shell?.dataset?.scheme === "dark") return true;
  if (shell?.dataset?.scheme === "light") return false;
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

let safeInsetCache: { w: number; h: number; host: HTMLElement; values: Partial<Record<"top" | "bottom", number>> } | null = null;
let safeInsetListening = false;

export function safeInsetPx(edge: "top" | "bottom"): number {
  if (typeof document === "undefined" || !document.body) return 0;
  const host = document.querySelector<HTMLElement>(".dusk-mobile") ?? document.body;
  const w = typeof window === "undefined" ? 0 : window.innerWidth;
  const h = typeof window === "undefined" ? 0 : window.innerHeight;
  if (!safeInsetListening && typeof window !== "undefined") {
    safeInsetListening = true;
    const clear = () => { safeInsetCache = null; };
    window.addEventListener("resize", clear);
    window.addEventListener("orientationchange", clear);
  }
  if (!safeInsetCache || safeInsetCache.w !== w || safeInsetCache.h !== h || safeInsetCache.host !== host) {
    safeInsetCache = { w, h, host, values: {} };
  }
  if (safeInsetCache.values[edge] === undefined) {
    safeInsetCache.values[edge] = cssPx(host, `var(--m-safe-${edge}, 0px)`);
  }
  return safeInsetCache.values[edge]!;
}

export function useGlassPill(
  glass: GlassBridge | undefined,
  slot: "top" | "bottom",
  state: Omit<FloatingPillGlassState, "slot"> | null,
  handlers?: { onPill?: () => void; onAction?: () => void; onDismiss?: () => void },
): boolean {
  const pill = glass?.pill;
  const activeId = useRef<string | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const payload = state ? JSON.stringify(state) : "";
  const hasState = payload !== "";

  useEffect(() => {
    if (!pill) return;
    if (!payload) {
      if (activeId.current) {
        pill(slot, null, activeId.current);
        activeId.current = null;
      }
      return;
    }
    const next = JSON.parse(payload) as Omit<FloatingPillGlassState, "slot">;
    activeId.current = next.id;
    pill(slot, { slot, ...next });
  }, [pill, slot, payload]);

  useEffect(() => {
    if (!pill) return;
    return () => {
      if (activeId.current) {
        pill(slot, null, activeId.current);
        activeId.current = null;
      }
    };
  }, [pill, slot]);

  useEffect(() => {
    if (!glass?.pill || !hasState) return;
    return glass.onEvent((event) => {
      if (event.type !== "pillTap" || event.slot !== slot || event.id !== activeId.current) return;
      if (event.kind === "pill") handlersRef.current?.onPill?.();
      else if (event.kind === "action") handlersRef.current?.onAction?.();
      else if (event.kind === "dismiss") handlersRef.current?.onDismiss?.();
    });
  }, [glass, slot, hasState]);

  return Boolean(pill);
}
