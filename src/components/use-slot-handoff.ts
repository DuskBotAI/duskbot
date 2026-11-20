import { useLayoutEffect, useRef } from "react";

type Resting = { el: HTMLElement; fill: string; ink: string };

/** The round button at the end of the phone's bar is a different control from one moment to the next (Send, Stop, the
 * mic, the keep tick): each newcomer takes over the last one's fill and glyph colour and turns to its own together. */
export function useSlotHandoff(on: boolean) {
  const actionsRef = useRef<HTMLDivElement>(null);
  const was = useRef<Resting | null>(null);
  const buttons = useRef<HTMLElement[]>([]);
  useLayoutEffect(() => {
    if (!on) return;
    const now = [...actionsRef.current?.querySelectorAll<HTMLElement>(":scope > button") ?? []];
    // reading the slot forces style and layout of the whole page: only a changed set of buttons can hand it over
    if (now.length === buttons.current.length && now.every((el, index) => el === buttons.current[index])) return;
    buttons.current = now;
    const before = was.current;
    if (!before) {
      // nothing to hand over yet: the first colours are read once the page has drawn, when they cost nothing
      const timer = setTimeout(() => { if (!was.current) was.current = resting(now); });
      return () => clearTimeout(timer);
    }
    const next = resting(now);
    was.current = next;
    const slot = next?.el;
    if (!next || !slot || before.el === slot || !slot.isConnected || typeof slot.animate !== "function") return;
    if (before.fill === next.fill && before.ink === next.ink) return;
    slot.animate([{ backgroundColor: before.fill, color: before.ink }, { backgroundColor: next.fill, color: next.ink }], { duration: 200, easing: "ease" });
  });
  return actionsRef;
}

function resting(buttons: HTMLElement[]): Resting | null {
  let slot: HTMLElement | null = null;
  for (const el of buttons) {
    if (!slot || el.offsetLeft >= slot.offsetLeft) slot = el;
  }
  if (!slot) return null;
  const style = getComputedStyle(slot);
  return { el: slot, fill: style.backgroundColor, ink: style.color };
}
