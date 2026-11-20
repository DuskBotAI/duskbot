import { cssBezier, pacedMs, pacedOut, pacedSpring } from "@/lib/motion-speed";
import { feel, system } from "./motion";

const REPLY_GROW = pacedSpring({ stiffness: 420, damping: 32 });
const SEND_MS = pacedMs(200);

export type PhoneFeelPick = "b" | "b+" | "b++";

type Spring = { stiffness: number; damping: number; mass?: number };

/** How the phone's own interactions move, per pick. "b" is what the app does now; "b+" and "b++" are candidates. */
export interface PhoneFeel {
  pick: PhoneFeelPick;
  /** push and pop by a tap; a swipe-back release carries the finger's speed into `release` */
  nav: { push: Spring; pop: Spring; release: Spring };
  /** a sheet rising to `detent` of the screen, then pulled to full; `exitScale` < 1 leaves faster than it came */
  sheet: { open: Spring; close: Spring; detent: number; snap: Spring; recede: number };
  /** the held bubble's lift and its menu: `fromBubble` grows the menu out of the bubble's corner */
  hold: { lift: number; menu: Spring; exitMs: number; fromBubble: boolean; blur: number; stagger: number };
  /** a picture opening: `zoom` grows it from the thumbnail's own rect instead of rising as a sheet */
  viewer: { zoom: boolean; open: Spring; closeMs: number; radiusMorph: boolean };
  /** the sent bubble: from the composer's rect when `fromComposer`, revealed by a clip from its corner when `clip` */
  send: { ms: number; ease: string; fromComposer: boolean; clip: boolean; spring: Spring | null };
  /** the reply: grown from .94, or revealed top down by a clip when `clip`; the working line blurs out when `blurLine` */
  reply: { grow: Spring; clip: boolean; blurLine: boolean; lineStagger: number };
  /** rows arriving: `limit` rows take their own delay (null: all of them), the rest come with the last */
  rows: { delays: readonly number[] | null; stagger: number; rise: number };
  /** the segmented pill: a spring that moves it, or a clip of the selected copy */
  pill: { mode: "spring" | "clip" | "stretch"; spring: Spring; ms: number };
  /** toasts: from `from` px (or its own height when "self"), out the way they came */
  toast: { from: number | "self"; inMs: number; outMs: number; ease: string; stack: boolean };
  /** pull to refresh: the spinner turns with the pull when `linked`; the release keeps the finger's speed */
  refresh: { linked: boolean; release: Spring; mascot: boolean };
  /** when the tap of the motor lands: at the press, or at the motion's peak (the lift's top, the detent's catch) */
  haptic: "press" | "peak" | "press+peak";
}

const EMIL_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

export const PHONE_FEELS: Record<PhoneFeelPick, PhoneFeel> = {
  b: {
    pick: "b",
    nav: { push: system, pop: system, release: system },
    sheet: { open: system, close: system, detent: 1, snap: system, recede: 0.07 },
    hold: { lift: feel.lift.scale, menu: feel.surface, exitMs: 130, fromBubble: false, blur: feel.scrim.blur, stagger: 0 },
    viewer: { zoom: false, open: system, closeMs: 420, radiusMorph: false },
    send: { ms: SEND_MS, ease: cssBezier(pacedOut([0.22, 1, 0.36, 1])), fromComposer: false, clip: false, spring: null },
    reply: { grow: REPLY_GROW, clip: false, blurLine: false, lineStagger: 0 },
    rows: { delays: null, stagger: feel.stagger * 1000, rise: feel.enter.y },
    pill: { mode: "spring", spring: feel.soft, ms: 0 },
    toast: { from: feel.enter.y, inMs: 200, outMs: 130, ease: "cubic-bezier(0.22, 1, 0.36, 1)", stack: false },
    refresh: { linked: false, release: { stiffness: 380, damping: 34 }, mascot: false },
    haptic: "press",
  },
  "b+": {
    pick: "b+",
    nav: { push: system, pop: { stiffness: 440, damping: 46 }, release: system },
    sheet: { open: system, close: { stiffness: 440, damping: 46 }, detent: 0.6, snap: system, recede: 0.07 },
    hold: { lift: 1.03, menu: { stiffness: 340, damping: 32 }, exitMs: 110, fromBubble: true, blur: feel.scrim.blur, stagger: 0 },
    viewer: { zoom: true, open: system, closeMs: 280, radiusMorph: false },
    send: { ms: SEND_MS, ease: EMIL_OUT, fromComposer: true, clip: false, spring: null },
    reply: { grow: REPLY_GROW, clip: true, blurLine: true, lineStagger: 0 },
    rows: { delays: [0, 40, 70, 95, 115], stagger: 0, rise: 6 },
    pill: { mode: "clip", spring: feel.soft, ms: 250 },
    toast: { from: "self", inMs: 400, outMs: 280, ease: "ease", stack: false },
    refresh: { linked: true, release: system, mascot: false },
    haptic: "peak",
  },
  "b++": {
    pick: "b++",
    nav: { push: system, pop: { stiffness: 440, damping: 46 }, release: { stiffness: 300, damping: 28 } },
    sheet: { open: system, close: { stiffness: 440, damping: 46 }, detent: 0.6, snap: { stiffness: 340, damping: 26 }, recede: 0.09 },
    hold: { lift: 1.04, menu: { stiffness: 360, damping: 28 }, exitMs: 110, fromBubble: true, blur: 14, stagger: 28 },
    viewer: { zoom: true, open: { stiffness: 260, damping: 26 }, closeMs: 280, radiusMorph: true },
    send: { ms: 0, ease: EMIL_OUT, fromComposer: true, clip: true, spring: { stiffness: 300, damping: 28 } },
    reply: { grow: REPLY_GROW, clip: true, blurLine: true, lineStagger: 40 },
    rows: { delays: [0, 40, 70, 95, 115], stagger: 0, rise: 10 },
    pill: { mode: "stretch", spring: feel.soft, ms: 0 },
    toast: { from: "self", inMs: 400, outMs: 280, ease: "ease", stack: true },
    refresh: { linked: true, release: { stiffness: 300, damping: 26 }, mascot: true },
    haptic: "press+peak",
  },
};

export const PHONE_FEEL: PhoneFeel = PHONE_FEELS.b;
