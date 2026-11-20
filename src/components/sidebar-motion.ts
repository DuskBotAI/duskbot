import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";

const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

function reducedMotion(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (document.documentElement.dataset.reducedMotion === "true") return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A bot that moves up on activity slides to its new place, and the rows it passes slide a slot to make room (FLIP over
 * 300ms on the out curve, the layout spring's feel with no bounce). Only lists that order themselves move this way:
 * a draggable list keeps the order it was given, and a drop or a keyboard move lands where it is put. Rows share a
 * height in a list, so a row's old place is where the row now at its old index sits. Searching changes rows at once. */
export function useActivityReorder(root: RefObject<HTMLElement | null>, enabled: boolean) {
  const last = useRef<Map<Element, string[]>>(new Map());
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const next = new Map<Element, string[]>();
    for (const row of el.querySelectorAll<HTMLElement>("[data-sidebar-bot-row]")) {
      const box = row.parentElement;
      const list = box?.parentElement;
      if (!box || !list || box.hasAttribute("data-bot-reorder-row")) continue;
      const ids = next.get(list) ?? [];
      ids.push(row.dataset.sidebarBotRow ?? "");
      next.set(list, ids);
    }
    const prev = last.current;
    last.current = next;
    if (!enabled || reducedMotion()) return;
    for (const [list, ids] of next) {
      const was = prev.get(list);
      if (!was || was.length !== ids.length || was.join("\n") === ids.join("\n") || ids.some((id) => !was.includes(id))) continue;
      const boxes = ids.map((id) => list.querySelector<HTMLElement>(`[data-sidebar-bot-row="${CSS.escape(id)}"]`)?.parentElement ?? null);
      if (boxes.some((box) => !box || typeof box.animate !== "function")) continue;
      const tops = boxes.map((box) => box!.offsetTop);
      ids.forEach((id, index) => {
        const from = was.indexOf(id);
        if (from === index) return;
        const dy = tops[from]! - tops[index]!;
        boxes[index]!.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 300, easing: EASE_OUT });
      });
    }
  });
}

/** Critically damped, response 0.3s: x(t) = 1 - (1 + wt)e^(-wt), 99% there by 0.34s, no overshoot. */
export const RAIL_MORPH_MS = 340;
const OMEGA = (2 * Math.PI) / 300;
export const RAIL_MORPH_EASING = `linear(${Array.from({ length: 35 }, (_, step) => {
  const t = (step / 34) * RAIL_MORPH_MS * OMEGA;
  return step === 34 ? 1 : +(1 - (1 + t) * Math.exp(-t)).toFixed(4);
}).join(", ")})`;
const GHOST_FADE_MS = 140;

type Morph = { animations: Animation[]; leftovers: HTMLElement[]; held: HTMLElement[] };

function morphKeys(root: ParentNode, skip?: Element): Map<string, HTMLElement> {
  const found = new Map<string, HTMLElement>();
  const twice = new Set<string>();
  for (const node of root.querySelectorAll<HTMLElement>("[data-morph]")) {
    if (skip?.contains(node)) continue;
    const key = node.dataset.morph!;
    if (found.has(key)) twice.add(key);
    found.set(key, node);
  }
  for (const key of twice) found.delete(key);
  return found;
}

/** Everything new that has no counterpart to glide from fades in: the smallest boxes that hold no gliding element. */
function fadeTargets(node: Element, out: Element[]) {
  for (const child of node.children) {
    if (child.hasAttribute("data-morph") || child.hasAttribute("data-morph-layer")) continue;
    if (child.querySelector("[data-morph]")) fadeTargets(child, out);
    else out.push(child);
  }
}

function sameScroll(from: Element, to: Element) {
  const source = [from, ...from.querySelectorAll("*")];
  const copy = [to, ...to.querySelectorAll("*")];
  source.forEach((node, index) => { if (node.scrollTop && copy[index]) copy[index]!.scrollTop = node.scrollTop; });
}

/** A copy that still shows the mascots: a cloned canvas comes out blank, so each is painted again from its original. */
function copyOf<T extends HTMLElement>(node: T): T {
  const copy = node.cloneNode(true) as T;
  const painted = node.querySelectorAll("canvas");
  copy.querySelectorAll("canvas").forEach((canvas, index) => {
    const source = painted[index];
    if (source?.width && source.height) canvas.getContext("2d")?.drawImage(source, 0, 0);
  });
  return copy;
}

function overlay(z: number, style: Partial<CSSStyleDeclaration>): HTMLDivElement {
  const node = document.createElement("div");
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("data-morph-layer", "");
  node.inert = true;
  Object.assign(node.style, { position: "absolute", top: "0", pointerEvents: "none", zIndex: String(z) }, style);
  return node;
}

/** The sidebar between names and avatars as one move on one clock: the chat column takes the width it ends at once and
 * only slides, the sidebar's edge rides with it, each avatar glides from where it was to its new place, the words it
 * leaves fade out where they stood and the new ones fade in at a width that never changes under them. A second toggle
 * mid-move starts from wherever everything is. Reduced motion swaps at once. */
export function useRailMorph(root: RefObject<HTMLElement | null>) {
  const running = useRef<Morph | null>(null);
  return useCallback((commit: () => void) => {
    const el = root.current;
    const stop = () => {
      const morph = running.current;
      running.current = null;
      morph?.animations.forEach((animation) => animation.cancel());
      morph?.leftovers.forEach((node) => node.remove());
      morph?.held.forEach((node) => { node.style.visibility = ""; });
    };
    if (!el || reducedMotion() || typeof el.animate !== "function") { stop(); commit(); return; }
    const main = el.nextElementSibling instanceof HTMLElement ? el.nextElementSibling : null;
    const frame = el.querySelector<HTMLElement>(":scope > [data-glass-frame]");
    const box = el.getBoundingClientRect();
    const edgeBefore = main ? main.getBoundingClientRect().left : box.right;
    const before = new Map([...morphKeys(el)].map(([key, node]) => [key, node.getBoundingClientRect()]));
    for (const flyer of el.querySelectorAll<HTMLElement>("[data-morph-fly]")) before.set(flyer.dataset.morphFly!, flyer.getBoundingClientRect());
    const ghost = frame ? overlay(30, { left: "0", height: `${box.height}px`, width: `${edgeBefore - box.left}px`, display: "flex", flexDirection: "column" }) : null;
    if (ghost && frame) {
      const copy = copyOf(frame);
      copy.querySelectorAll("[data-morph-layer]").forEach((node) => node.remove());
      copy.style.flex = "1 1 0%";
      ghost.append(copy);
    }
    stop();
    el.style.transition = "none";
    flushSync(commit);
    const after = el.getBoundingClientRect();
    const edgeAfter = main ? main.getBoundingClientRect().left : after.right;
    const delta = edgeBefore - edgeAfter;
    const timing: KeyframeAnimationOptions = { duration: RAIL_MORPH_MS, easing: RAIL_MORPH_EASING };
    const animations: Animation[] = [];
    const leftovers: HTMLElement[] = [];
    const moved = morphKeys(el);
    const fresh: Element[] = [];
    const newFrame = el.querySelector(":scope > [data-glass-frame]");
    if (newFrame) fadeTargets(newFrame, fresh);
    if (ghost && frame) {
      el.append(ghost);
      leftovers.push(ghost);
      sameScroll(frame, ghost.firstElementChild!);
      for (const node of ghost.querySelectorAll<HTMLElement>("[data-morph]")) if (moved.has(node.dataset.morph!)) node.style.visibility = "hidden";
      animations.push(ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: GHOST_FADE_MS, easing: EASE_OUT, fill: "forwards" }));
      if (delta > 0) animations.push(ghost.animate([{ clipPath: "inset(0 0 0 0)" }, { clipPath: `inset(0 ${delta}px 0 0)` }], { ...timing, fill: "forwards" }));
    }
    if (main && delta !== 0) {
      const covered = main.getBoundingClientRect().right < (main.parentElement?.getBoundingClientRect().right ?? Infinity) - 1;
      animations.push(main.animate(covered && delta > 0
        ? [{ transform: `translateX(${delta}px)`, clipPath: `inset(0 ${delta}px 0 0)` }, { transform: "none", clipPath: "inset(0 0 0 0)" }]
        : [{ transform: `translateX(${delta}px)` }, { transform: "none" }], timing));
    }
    if (delta < 0) animations.push(el.animate([{ clipPath: `inset(0 ${-delta}px 0 0)` }, { clipPath: "inset(0 0 0 0)" }], timing));
    if (delta > 0) {
      const fill = overlay(29, { bottom: "0", left: "100%", width: `${delta}px`, background: getComputedStyle(el).backgroundColor, transformOrigin: "0 0" });
      el.append(fill);
      leftovers.push(fill);
      animations.push(fill.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], { ...timing, fill: "forwards" }));
    }
    // each avatar flies as a copy above the lists, so neither list's scroll box clips it on the way
    const flyers = overlay(31, { left: "0", width: "0", height: "0", overflow: "visible" });
    const held: HTMLElement[] = [];
    for (const [key, node] of moved) {
      const from = before.get(key);
      const to = node.getBoundingClientRect();
      if (!from || !to.width || !from.width) continue;
      const dx = from.left - to.left, dy = from.top - to.top, scale = from.width / to.width;
      if (Math.abs(dy) > after.height || (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(scale - 1) < 0.01)) continue;
      const flyer = copyOf(node);
      flyer.removeAttribute("data-morph");
      flyer.dataset.morphFly = key;
      Object.assign(flyer.style, { position: "absolute", margin: "0", left: `${to.left - after.left}px`, top: `${to.top - after.top}px`, width: `${to.width}px`, height: `${to.height}px` });
      flyers.append(flyer);
      node.style.visibility = "hidden";
      held.push(node);
      animations.push(flyer.animate([{ transformOrigin: "0 0", transform: `translate(${dx}px, ${dy}px) scale(${scale})` }, { transformOrigin: "0 0", transform: "none" }], timing));
    }
    if (held.length) { el.append(flyers); leftovers.push(flyers); }
    for (const node of fresh) animations.push(node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: RAIL_MORPH_MS * 0.7, delay: RAIL_MORPH_MS * 0.15, easing: EASE_OUT, fill: "backwards" }));
    const morph = { animations, leftovers, held };
    running.current = morph;
    const settle = () => {
      if (running.current !== morph) return;
      running.current = null;
      leftovers.forEach((node) => node.remove());
      held.forEach((node) => { node.style.visibility = ""; });
      animations.forEach((animation) => animation.cancel());
      el.style.transition = "";
    };
    void Promise.all(animations.map((animation) => animation.finished)).then(settle, () => undefined);
  }, [root]);
}

