import { useLayoutEffect, useRef, type ReactNode } from "react";
import { reducedMotion } from "@/lib/onboarding";
import { NOTICE_MOTION } from "./ComposerNoticeSlot";

export type CardSlotChange = "appear" | "leave";

/** One change of the slot: the slot's height keyframes (none: it takes its natural height at once) and the card's fade. */
export interface CardSlotPlan {
  height: { from: number; to: number; ms: number; easing: string } | null;
  fade: { from: number; to: number; ms: number; delay: number; easing: string };
}

/** How the card in the transcript comes and goes. Coming: the slot opens on the collapse curve, then the card fades in.
 * Going: the card fades where it is while the slot collapses under it, as the notice above the composer leaves. A change
 * that interrupts another starts from the height the slot is drawn at. Reduced motion keeps the fades and moves nothing:
 * the space opens at once before a fade in, and holds through a fade out. */
export function cardSlotPlan(change: CardSlotChange, from: number, to: number, reduced: boolean): CardSlotPlan {
  const { fadeOutMs, collapseMs, collapseEase, ease } = NOTICE_MOTION;
  if (change === "appear") {
    const open = to > 0 ? Math.max(0, Math.min(1, 1 - from / to)) : 0;
    if (reduced || open === 0) return { height: null, fade: { from: 0, to: 1, ms: fadeOutMs, delay: 0, easing: ease } };
    return {
      height: { from, to, ms: Math.round(collapseMs * open), easing: collapseEase },
      fade: { from: 0, to: 1, ms: fadeOutMs, delay: Math.round(collapseMs * open), easing: ease },
    };
  }
  if (reduced) return { height: { from, to: from, ms: fadeOutMs, easing: "linear" }, fade: { from: 1, to: 0, ms: fadeOutMs, delay: 0, easing: ease } };
  return {
    height: from > 0 ? { from, to: 0, ms: collapseMs, easing: collapseEase } : null,
    fade: { from: 1, to: 0, ms: fadeOutMs, delay: 0, easing: ease },
  };
}

const canAnimate = (node: Element) => typeof (node as HTMLElement).animate === "function";

// the column's 16px gap above the slot moves inside it, so an empty slot takes no room and the gap opens and closes
// with the card
const CARD_ROW = "pt-4 [&>[data-failed-reply]]:mb-0 [&>[data-failed-reply]]:px-0";

/** A card at the end of the transcript (one root element, or nothing). A card that leaves is kept, out of React's tree,
 * until its exit has played; a card there when the slot mounts (a chat opened) just shows. */
export function TranscriptCardSlot({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement | null>(null);
  const inner = useRef<HTMLDivElement | null>(null);
  const ghosts = useRef<HTMLDivElement | null>(null);
  const known = useRef<Element | null | undefined>(undefined);
  const shownHeight = useRef(0);
  const running = useRef<Animation[]>([]);
  const sizing = useRef<Animation | null>(null);
  const sync = useRef<() => void>(() => {});

  sync.current = () => {
    const box = outer.current, rows = inner.current, layer = ghosts.current;
    if (!box || !rows || !layer) return;
    const card = rows.firstElementChild;
    const was = known.current;
    known.current = card;
    if (was === undefined || card === was) return;
    if (card && was) return;
    const drawn = sizing.current ? box.getBoundingClientRect().height : was ? shownHeight.current : 0;
    for (const anim of running.current) anim.cancel();
    running.current = [];
    sizing.current = null;
    layer.replaceChildren();
    if (!canAnimate(box)) return;
    const reduced = reducedMotion();
    const settle = (anim: Animation) => {
      running.current.push(anim);
      anim.addEventListener("finish", () => {
        running.current = running.current.filter((one) => one !== anim);
        if (running.current.length === 0) box.style.overflow = "";
      });
    };
    let target: HTMLElement;
    let plan: CardSlotPlan;
    if (card instanceof HTMLElement && canAnimate(card)) {
      shownHeight.current = rows.offsetHeight;
      plan = cardSlotPlan("appear", drawn, shownHeight.current, reduced);
      target = card;
    } else if (!card && was instanceof HTMLElement && canAnimate(was)) {
      plan = cardSlotPlan("leave", drawn, 0, reduced);
      was.setAttribute("aria-hidden", "true");
      was.style.pointerEvents = "none";
      layer.appendChild(was);
      target = was;
    } else return;
    box.style.overflow = "hidden";
    if (plan.height) {
      const height = box.animate([{ height: `${plan.height.from}px` }, { height: `${plan.height.to}px` }], { duration: plan.height.ms, easing: plan.height.easing });
      sizing.current = height;
      height.addEventListener("finish", () => { if (sizing.current === height) sizing.current = null; });
      settle(height);
    }
    const fade = target.animate([{ opacity: plan.fade.from }, { opacity: plan.fade.to }], { duration: plan.fade.ms, delay: plan.fade.delay, easing: plan.fade.easing, fill: "both" });
    settle(fade);
    if (target === card) fade.addEventListener("finish", () => fade.cancel());
    else fade.addEventListener("finish", () => target.remove());
  };

  // before the transcript's own layout effects (a child's run first), so the end it pins to already has the card's
  // opening height
  useLayoutEffect(() => sync.current());

  useLayoutEffect(() => {
    const rows = inner.current;
    if (!rows) return;
    known.current = rows.firstElementChild;
    shownHeight.current = rows.offsetHeight;
    const observer = new MutationObserver(() => sync.current());
    observer.observe(rows, { childList: true });
    const resized = typeof ResizeObserver === "function" ? new ResizeObserver(() => { shownHeight.current = rows.offsetHeight; }) : null;
    resized?.observe(rows);
    const all = running;
    return () => { observer.disconnect(); resized?.disconnect(); for (const anim of all.current) anim.cancel(); };
  }, []);

  return (
    <div ref={outer} data-failed-reply-row="" className="relative -mt-4">
      <div ref={inner} className={`${CARD_ROW} empty:hidden`}>{children}</div>
      <div ref={ghosts} aria-hidden="true" className={`pointer-events-none absolute inset-x-0 top-0 empty:hidden ${CARD_ROW}`} />
    </div>
  );
}
