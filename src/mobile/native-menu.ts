import { useEffect, useState } from "react";
import { frameOf, type GlassFrame } from "./native-glass";

export interface NativeMenuItem {
  key: string;
  title: string;
  /** an SF Symbol name */
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
}

export interface NativeMenuReaction { key: string; title: string; glyph: string; selected?: boolean }

export interface NativeMenuContent { items: NativeMenuItem[]; reactions?: NativeMenuReaction[] }

export interface NativeMenuArm {
  id: string;
  rect: GlassFrame;
  /** corner radii in css order: top left, top right, bottom right, bottom left */
  radii: number[];
  point?: { x: number; y: number };
  content?: NativeMenuContent;
}

export type NativeMenuEvent =
  | { type: "request"; id: string }
  | { type: "open"; id: string }
  | { type: "close"; id: string }
  | { type: "select"; id: string; key: string }
  | { type: "react"; id: string; key: string };

/** The system context menu (ios/App/App/NativeMenuPlugin.swift), iOS 26 and later: the page arms what is under the
 * finger on touchstart and the system lifts it and shows its menu when the press is long enough. */
export interface MenuBridge {
  arm(options: NativeMenuArm): void;
  disarm(id?: string): void;
  /** answers a `request` for an item armed without its content */
  resolve(id: string, content: NativeMenuContent): void;
  onEvent(listener: (event: NativeMenuEvent) => void): () => void;
}

/** What a held item offers, and what choosing each entry does. */
export interface HeldMenu {
  content: NativeMenuContent;
  select(key: string): void;
  react?(key: string): void;
}

export interface NativeHold {
  /** a finger came down on `el`: arm it, and read its menu after `prefetchMs` of holding still (0 reads it at once) */
  press(
    el: HTMLElement,
    describe: () => HeldMenu | null | Promise<HeldMenu | null>,
    options?: { prefetchMs?: number; point?: { x: number; y: number }; onOpen?: (el: HTMLElement) => void },
  ): void;
  /** the finger moved off or a second one came down */
  cancel(): void;
  dispose(): void;
}

export function cornerRadii(el: Element): number[] {
  const style = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map((value) => {
    const first = (value || "0").trim().split(/\s+/)[0];
    const n = parseFloat(first) || 0;
    return first.endsWith("%") ? (n / 100) * Math.min(box.width, box.height) : n;
  });
}

type Press = {
  el: HTMLElement;
  describe: () => HeldMenu | null | Promise<HeldMenu | null>;
  menu?: Promise<HeldMenu | null>;
  timer: ReturnType<typeof setTimeout> | undefined;
  opened: boolean;
  onOpen?: (el: HTMLElement) => void;
};

const KEEP = 4;

export function createNativeHold(bridge: MenuBridge, prefix: string): NativeHold {
  let seq = 0;
  let current: string | null = null;
  const presses = new Map<string, Press>();
  const load = (press: Press) => press.menu ??= Promise.resolve().then(press.describe).catch(() => null);

  const stop = bridge.onEvent((event) => {
    const press = presses.get(event.id);
    if (!press) return;
    switch (event.type) {
      case "request":
        void load(press).then((menu) => bridge.resolve(event.id, menu?.content ?? { items: [] }));
        break;
      case "open":
        if (press.opened) break;
        press.opened = true;
        clearTimeout(press.timer);
        // the system lifts a snapshot; the page's own copy would show through the blur under it
        press.el.style.visibility = "hidden";
        press.onOpen?.(press.el);
        break;
      case "close":
        press.el.style.visibility = "";
        break;
      case "select":
        void load(press).then((menu) => menu?.select(event.key));
        break;
      case "react":
        void load(press).then((menu) => menu?.react?.(event.key));
        break;
    }
  });

  return {
    press(el, describe, options = {}) {
      const id = `${prefix}:${++seq}`;
      if (current) clearTimeout(presses.get(current)?.timer);
      current = id;
      const press: Press = { el, describe, timer: undefined, opened: false, onOpen: options.onOpen };
      presses.set(id, press);
      for (const key of presses.keys()) {
        if (presses.size <= KEEP) break;
        if (key !== id && !presses.get(key)?.opened) presses.delete(key);
      }
      const base: NativeMenuArm = {
        id,
        rect: frameOf(el),
        radii: cornerRadii(el),
        ...(options.point ? { point: { x: Math.round(options.point.x), y: Math.round(options.point.y) } } : {}),
      };
      bridge.arm(base);
      const send = () => {
        void load(press).then((menu) => {
          if (current !== id || press.opened) return;
          if (menu) bridge.arm({ ...base, content: menu.content });
          else { bridge.disarm(id); current = null; }
        });
      };
      const wait = options.prefetchMs ?? 0;
      if (wait <= 0) send();
      else press.timer = setTimeout(send, wait);
    },
    cancel() {
      if (!current) return;
      const press = presses.get(current);
      if (press?.opened) return;
      clearTimeout(press?.timer);
      bridge.disarm(current);
      presses.delete(current);
      current = null;
    },
    dispose() {
      stop();
      for (const press of presses.values()) {
        clearTimeout(press.timer);
        if (press.opened) press.el.style.visibility = "";
      }
      presses.clear();
      if (current) bridge.disarm(current);
      current = null;
    },
  };
}

/** One hold controller for as long as the bridge stays the same. */
export function useNativeHold(bridge: MenuBridge | undefined, prefix: string): NativeHold | undefined {
  const [hold, setHold] = useState<NativeHold>();
  useEffect(() => {
    if (!bridge) { setHold(undefined); return; }
    const next = createNativeHold(bridge, prefix);
    setHold(next);
    return () => next.dispose();
  }, [bridge, prefix]);
  return hold;
}
