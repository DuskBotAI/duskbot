import { SEND_FLOW, springTiming } from "@/hooks/use-arrival-flow";
import { pacedSpring } from "@/lib/motion-speed";

/** The person's bubble comes out of the composer: it fades in, grows from 0.9 and rises 16px from its bottom end corner,
 * on the same 200ms ease-out as the column's follow, so the two land together. */
export const SEND_ENTER = SEND_FLOW;
export const SEND_ENTER_FROM = 0.9;
export const SEND_ENTER_RISE_PX = 16;
/** A reply grows out of its top corner, by the mascot, its words with it. */
const REPLY_SPRING = pacedSpring({ stiffness: 420, damping: 32 });
export const REPLY_GROW = springTiming(REPLY_SPRING.stiffness, REPLY_SPRING.damping);
export const REPLY_GROW_FROM = 0.94;

const STALE_MS = 2_000;
let launch: { sendId: string; at: number } | null = null;

/** A send from this window's composer, noted as it goes, so only its own bubble plays the entrance. */
export function noteSendLaunch(sendId: string): void {
  launch = { sendId, at: Date.now() };
}

export function hasSendLaunch(sendId: string | undefined): boolean {
  return Boolean(sendId && launch?.sendId === sendId && Date.now() - launch.at < STALE_MS);
}

const canAnimate = (el: Element) => typeof (el as HTMLElement).animate === "function";

/** Right to left by the element's own `dir`, read without computing its style: a computed style here restyled the whole
 * transcript for every bubble that arrived. */
function rightToLeft(el: Element): boolean {
  try { return el.matches(":dir(rtl)"); } catch { return el.closest("[dir]")?.getAttribute("dir") === "rtl"; }
}

/** The person's bubble scales up out of the composer from its bottom end corner; under reduced motion it only fades.
 * Transform and opacity alone, so it runs on the compositor and the layer it needs lives only as long. */
export function enterFromComposer(bubble: HTMLElement, sendId: string | undefined, reduced: boolean): void {
  if (!hasSendLaunch(sendId) || !canAnimate(bubble)) return;
  launch = null;
  const rtl = rightToLeft(bubble);
  bubble.style.transformOrigin = rtl ? "0% 100%" : "100% 100%";
  bubble.animate(reduced
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [{ opacity: 0, transform: `translateY(${SEND_ENTER_RISE_PX}px) scale(${SEND_ENTER_FROM})` }, { opacity: 1, transform: "translateY(0px) scale(1)" }], SEND_ENTER);
}

/** The reply grows out of its top start corner, the mascot's side, so its top edge moves only with the conversation;
 * its words come with it, so no frame shows an empty bubble where the working line just was. Under reduced motion it
 * only fades. */
export function growFromMascot(bubble: HTMLElement, reduced: boolean): void {
  if (!canAnimate(bubble)) return;
  const rtl = rightToLeft(bubble);
  bubble.style.transformOrigin = rtl ? "100% 0%" : "0% 0%";
  bubble.animate(reduced
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [{ opacity: 0, transform: `scale(${REPLY_GROW_FROM})` }, { opacity: 1, transform: "scale(1)" }], REPLY_GROW);
}
