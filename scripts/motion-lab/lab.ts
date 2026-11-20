// Side-by-side stand-ins for the transitions the owner feels, each played at speeds a, b and c of src/lib/motion-speed.ts.
// The surfaces are drawn here, not mounted from the app; the timings come from the app's own tokens and functions.
import { springTiming } from "../../src/hooks/use-arrival-flow";
import { cssBezier, MOTION_SPEEDS, pacedInOut, pacedMs, pacedOut, pacedSpring, type MotionPick, type MotionSpeed } from "../../src/lib/motion-speed";
import { springPath } from "../../src/mobile/motion";

export type Size = "phone" | "desktop";
export type SceneName = "push" | "sheet" | "overlay" | "reply" | "error" | "send" | "sidebar";

const STAGE: Record<Size, { w: number; h: number }> = { phone: { w: 390, h: 844 }, desktop: { w: 960, h: 600 } };
const SYSTEM = { stiffness: 600, damping: 54, push: 10 };
const EASE_OUT = [0.22, 1, 0.36, 1] as const;
const MENU_IN = [0.16, 1, 0.3, 1] as const;
const COLLAPSE = [0.645, 0.045, 0.355, 1] as const;
const FOLLOW_CURVE = [0.25, 0.46, 0.45, 0.94] as const;
const SIDEBAR_SPRING = "linear(0, 0.052, 0.172, 0.318, 0.462, 0.592, 0.701, 0.788, 0.855, 0.905, 0.94, 0.964, 0.979, 0.988, 0.994, 0.997, 0.999, 1)";
const LEAD = 300;
const HOLD = 900;
/** Every pane is tapped on the same frame, so each later step starts when the slowest pane has had its hold. */
const SECOND = 2200;

export const LABELS: Record<MotionPick, string> = { a: "A  now", b: "B  1.4x, softer", c: "C  1.8x, extra soft" };

type Play = (el: Element, frames: Keyframe[], at: number, ms: number, easing: string, fill?: FillMode) => number;

function h(tag: string, css: string, text = "", parent?: Element): HTMLElement {
  const el = document.createElement(tag);
  el.style.cssText = css;
  if (text) el.textContent = text;
  parent?.appendChild(el);
  return el;
}

const play: Play = (el, frames, at, ms, easing, fill = "both") => {
  el.animate(frames, { duration: ms, delay: at, easing, fill });
  return at + ms;
};

function springRun(el: Element, from: number, to: number, velocity: number, speed: MotionSpeed, at: number, frame: (p: number) => Keyframe, fill: FillMode): number {
  const path = springPath(from, to, velocity, pacedSpring({ stiffness: SYSTEM.stiffness, damping: SYSTEM.damping }, speed));
  return play(el, path.points.map(frame), at, path.duration, "linear", fill);
}

const ink = "#1c1c1c", soft = "#6b6b6b", tone = "#f2f2f1", ground = "#fdfdfc", side = "#f6f6f5", accent = "#1084fe";

function bubble(parent: Element, text: string, mine: boolean, size: Size): HTMLElement {
  const row = h("div", `display:flex;justify-content:${mine ? "flex-end" : "flex-start"};`, "", parent);
  return h("div", mine
    ? `max-width:72%;padding:9px 14px;border-radius:20px;background:${tone};color:${ink};font-size:${size === "phone" ? 16 : 14}px;line-height:1.45;`
    : `max-width:86%;padding:2px 2px;color:${ink};font-size:${size === "phone" ? 16 : 14}px;line-height:1.55;`, text, row);
}

function transcript(parent: Element, size: Size): HTMLElement {
  const column = h("div", "position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;gap:14px;padding:16px 18px;", "", parent);
  bubble(column, "can you check if the flight on friday moved?", true, size);
  bubble(column, "It moved to 9:40, gate B12. Your seat stayed the same, and the hotel shuttle still lines up.", false, size);
  bubble(column, "nice. and the return?", true, size);
  return column;
}

function chatShell(stage: HTMLElement, size: Size): { body: HTMLElement; composer: HTMLElement; column: HTMLElement } {
  const desk = size === "desktop";
  const top = h("div", `height:${desk ? 44 : 96}px;display:flex;align-items:flex-end;padding:0 18px 10px;font-weight:600;font-size:${desk ? 14 : 17}px;color:${ink};`, desk ? "travel" : "Travel", stage);
  const body = h("div", `position:absolute;left:0;right:0;top:${top.offsetHeight || (desk ? 44 : 96)}px;bottom:${desk ? 84 : 104}px;overflow:hidden;`, "", stage);
  const composer = h("div", `position:absolute;left:${desk ? 120 : 12}px;right:${desk ? 120 : 12}px;bottom:${desk ? 20 : 34}px;height:48px;border-radius:24px;background:${tone};display:flex;align-items:center;padding:0 18px;color:${soft};font-size:15px;`, "", stage);
  const column = transcript(body, size);
  return { body, composer, column };
}

function listPage(parent: Element): void {
  h("div", `height:96px;display:flex;align-items:flex-end;padding:0 20px 8px;font-weight:700;font-size:30px;color:${ink};`, "Chats", parent);
  for (const [name, line] of [["Travel", "It moved to 9:40, gate B12."], ["Research", "Three papers fit, the 2025 one best."], ["Inbox", "Two need a reply today."], ["Writer", "Draft two is in your notes."], ["Recipes", "Swap the cream for yoghurt."], ["Ledger", "October closes at 4,120."]]) {
    const row = h("div", "display:flex;gap:12px;align-items:center;padding:10px 20px;", "", parent);
    h("div", `width:48px;height:48px;border-radius:50%;background:${tone};flex:none;`, "", row);
    const text = h("div", "min-width:0;", "", row);
    h("div", `font-weight:600;font-size:16px;color:${ink};`, name, text);
    h("div", `font-size:14px;color:${soft};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`, line, text);
  }
}

function push(stage: HTMLElement, speed: MotionSpeed): number {
  const W = STAGE.phone.w;
  const base = h("div", `position:absolute;inset:0;background:${ground};`, "", stage);
  listPage(base);
  const dim = h("div", "position:absolute;inset:0;background:rgb(0 0 0 / 0.12);opacity:0;", "", stage);
  const page = h("div", `position:absolute;inset:0;background:${ground};box-shadow:-8px 0 24px rgb(0 0 0 / 0.06);transform:translateX(${W}px);`, "", stage);
  chatShell(page, "phone");
  const v = SYSTEM.push / speed.scale;
  const run = (from: number, to: number, vel: number, at: number, fill: FillMode) => {
    springRun(base, from, to, vel, speed, at, (p) => ({ transform: `translateX(${-0.3 * (W - p)}px)` }), fill);
    springRun(dim, from, to, vel, speed, at, (p) => ({ opacity: 1 - p / W }), fill);
    return springRun(page, from, to, vel, speed, at, (p) => ({ transform: `translateX(${p}px)` }), fill);
  };
  run(W, 0, -v * W, LEAD, "both");
  return run(0, W, v * W, SECOND, "forwards");
}

function sheet(stage: HTMLElement, speed: MotionSpeed): number {
  const H = STAGE.phone.h - 70;
  stage.style.background = "#000";
  const page = h("div", `position:absolute;inset:0;background:${ground};transform-origin:50% 0;overflow:hidden;`, "", stage);
  chatShell(page, "phone");
  const scrim = h("div", "position:absolute;inset:0;background:rgb(0 0 0 / 0.28);opacity:0;", "", stage);
  const box = h("div", `position:absolute;left:0;right:0;bottom:0;height:${H}px;border-radius:14px 14px 0 0;background:${ground};transform:translateY(${H}px);padding:14px 20px;`, "", stage);
  h("div", `width:36px;height:5px;border-radius:3px;background:#d9d9d8;margin:0 auto 18px;`, "", box);
  h("div", `font-weight:700;font-size:22px;color:${ink};margin-bottom:16px;`, "Travel", box);
  for (const row of ["Model", "Memory", "Skills", "Routines", "Computer"]) h("div", `padding:14px 0;font-size:16px;color:${ink};border-bottom:1px solid ${tone};`, row, box);
  const v = SYSTEM.push / speed.scale;
  const prog = (p: number) => Math.max(0, Math.min(1, 1 - p / H));
  const run = (from: number, to: number, vel: number, at: number, fill: FillMode) => {
    springRun(scrim, from, to, vel, speed, at, (p) => ({ opacity: prog(p) }), fill);
    springRun(page, from, to, vel, speed, at, (p) => ({ transform: `translateY(${(prog(p) * 0.5 * 54).toFixed(2)}px) scale(${(1 - 0.07 * prog(p)).toFixed(4)})`, borderRadius: `${(prog(p) * 14).toFixed(1)}px` }), fill);
    return springRun(box, from, to, vel, speed, at, (p) => ({ transform: `translateY(${p}px)` }), fill);
  };
  run(H, 0, -v * H, LEAD, "both");
  return run(0, H + 24, v * H, SECOND, "forwards");
}

function overlay(stage: HTMLElement, speed: MotionSpeed): number {
  const { composer } = chatShell(stage, "desktop");
  composer.textContent = "ask travel anything";
  const out = cssBezier(pacedOut(EASE_OUT, speed));
  const menuIn = cssBezier(pacedOut(MENU_IN, speed));
  const menu = h("div", `position:absolute;left:24px;top:40px;width:200px;padding:6px;border-radius:14px;background:#fff;box-shadow:0 10px 20px -3px rgb(28 28 28 / 0.1),0 4px 6px -4px rgb(28 28 28 / 0.1);transform-origin:24px 0;opacity:0;`, "", stage);
  for (const item of ["rename", "pin", "move to group", "archive"]) h("div", `padding:8px 10px;border-radius:8px;font-size:14px;color:${ink};`, item, menu);
  play(menu, [{ opacity: 0, transform: "translate3d(0,-4px,0) scale(0.97)" }, { opacity: 1, transform: "none" }], LEAD, pacedMs(120, speed), menuIn);
  play(menu, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translate3d(0,-2px,0) scale(0.98)" }], LEAD + HOLD, pacedMs(80, speed), out, "forwards");
  const scrim = h("div", "position:absolute;inset:0;background:rgb(0 0 0 / 0.2);opacity:0;", "", stage);
  const dialog = h("div", `position:absolute;left:50%;top:50%;width:440px;margin:-130px 0 0 -220px;height:260px;border-radius:20px;background:#fff;box-shadow:0 20px 32px -5px rgb(28 28 28 / 0.1),0 8px 12px -6px rgb(28 28 28 / 0.1);padding:24px;opacity:0;`, "", stage);
  h("div", `font-weight:600;font-size:17px;color:${ink};margin-bottom:10px;`, "archive travel?", dialog);
  h("div", `font-size:14px;line-height:1.55;color:${soft};`, "its chats stay in archived, and you can bring it back any time.", dialog);
  const at = LEAD + 2 * HOLD;
  play(scrim, [{ opacity: 0 }, { opacity: 1 }], at, pacedMs(160, speed), out);
  play(dialog, [{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "scale(1)" }], at, pacedMs(200, speed), out);
  play(scrim, [{ opacity: 1 }, { opacity: 0 }], at + HOLD + 300, pacedMs(120, speed), out, "forwards");
  return play(dialog, [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.98)" }], at + HOLD + 300, pacedMs(120, speed), out, "forwards");
}

function workingLine(parent: Element): HTMLElement {
  const line = h("div", `display:flex;align-items:center;gap:8px;height:24px;font-size:14px;color:${soft};`, "", parent);
  h("div", `width:16px;height:16px;border-radius:5px;background:${ink};`, "", line);
  h("span", "", "Checking the airline", line);
  return line;
}

function reply(stage: HTMLElement, speed: MotionSpeed, size: Size): number {
  const { column } = chatShell(stage, size);
  const end = h("div", "position:relative;", "", column);
  const line = workingLine(end);
  const answer = bubble(end, "The return is unchanged: Sunday 18:15 from gate C4, landing 21:05. I set a reminder for check-in on Saturday.", false, size);
  answer.parentElement!.style.cssText += "position:relative;";
  answer.style.opacity = "0";
  line.style.position = "absolute";
  line.style.top = "0";
  const grow = springTiming(pacedSpring({ stiffness: 420, damping: 32 }, speed).stiffness, pacedSpring({ stiffness: 420, damping: 32 }, speed).damping);
  const shift = Math.max(0, (answer.parentElement!.offsetHeight || 70) - 24);
  play(line, [{ opacity: 1 }, { opacity: 0 }], LEAD, pacedMs(140, speed), cssBezier(pacedOut(EASE_OUT, speed)));
  answer.style.transformOrigin = "0% 0%";
  play(column, [{ transform: `translateY(${shift}px)` }, { transform: "translateY(0)" }], LEAD, pacedMs(240, speed), cssBezier(pacedOut(FOLLOW_CURVE, speed)));
  return play(answer, [{ opacity: 0, transform: "scale(0.94)" }, { opacity: 1, transform: "scale(1)" }], LEAD, grow.duration, grow.easing) + HOLD;
}

function error(stage: HTMLElement, speed: MotionSpeed, size: Size): number {
  const { column } = chatShell(stage, size);
  const slot = h("div", "overflow:hidden;height:0;", "", column);
  const card = h("div", `margin-top:2px;padding:14px 16px;border-radius:16px;background:${tone};opacity:0;`, "", slot);
  h("div", `font-weight:600;font-size:14px;color:${ink};margin-bottom:4px;`, "Travel could not reply", card);
  h("div", `font-size:14px;color:${soft};margin-bottom:10px;`, "The engine stopped answering. Your message is kept.", card);
  h("div", `display:inline-block;padding:6px 12px;border-radius:999px;background:${ink};color:#fff;font-size:13px;`, "Try again", card);
  const full = 128;
  const inOut = cssBezier(pacedInOut(COLLAPSE, speed));
  const out = cssBezier(pacedOut(EASE_OUT, speed));
  const opened = play(slot, [{ height: "0px" }, { height: `${full}px` }], LEAD, pacedMs(200, speed), inOut);
  play(card, [{ opacity: 0 }, { opacity: 1 }], opened, pacedMs(140, speed), out);
  const leave = SECOND;
  play(card, [{ opacity: 1 }, { opacity: 0 }], leave, pacedMs(140, speed), out, "forwards");
  return play(slot, [{ height: `${full}px` }, { height: "0px" }], leave, pacedMs(200, speed), inOut, "forwards");
}

function send(stage: HTMLElement, speed: MotionSpeed, size: Size): number {
  const { column, composer } = chatShell(stage, size);
  const typed = h("span", `color:${ink};`, "and the hotel checkout?", composer);
  const mine = bubble(column, "and the hotel checkout?", true, size);
  mine.style.transformOrigin = "100% 100%";
  const ms = pacedMs(200, speed);
  const easing = cssBezier(pacedOut(EASE_OUT, speed));
  play(typed, [{ opacity: 1 }, { opacity: 0 }], LEAD, 1, "linear");
  play(column, [{ transform: `translateY(${(mine.parentElement!.offsetHeight || 42) + 14}px)` }, { transform: "translateY(0)" }], LEAD, ms, easing);
  return play(mine, [{ opacity: 0, transform: "translateY(16px) scale(0.9)" }, { opacity: 1, transform: "translateY(0) scale(1)" }], LEAD, ms, easing) + HOLD;
}

function sidebar(stage: HTMLElement, speed: MotionSpeed): number {
  stage.style.display = "flex";
  const bar = h("div", `width:288px;flex:none;background:${side};overflow:hidden;padding:52px 0 0;`, "", stage);
  for (const name of ["Research", "Inbox", "Writer", "Travel", "Recipes", "Notes", "Ledger"]) {
    const row = h("div", "display:flex;align-items:center;gap:10px;padding:7px 14px;white-space:nowrap;", "", bar);
    h("div", `width:30px;height:30px;border-radius:50%;background:${name === "Travel" ? accent : "#e4e4e2"};flex:none;margin-left:11px;`, "", row);
    h("span", `font-size:14px;color:${ink};`, name.toLowerCase(), row);
  }
  const main = h("div", "position:relative;flex:1;min-width:0;", "", stage);
  chatShell(main, "desktop");
  const ms = pacedMs(500, speed);
  play(bar, [{ width: "288px" }, { width: "80px" }], LEAD, ms, SIDEBAR_SPRING);
  return play(bar, [{ width: "80px" }, { width: "288px" }], SECOND, ms, SIDEBAR_SPRING, "forwards");
}

const SCENES: Record<SceneName, { sizes: Size[]; build: (stage: HTMLElement, speed: MotionSpeed, size: Size) => number }> = {
  push: { sizes: ["phone"], build: (s, v) => push(s, v) },
  sheet: { sizes: ["phone"], build: (s, v) => sheet(s, v) },
  overlay: { sizes: ["desktop"], build: (s, v) => overlay(s, v) },
  reply: { sizes: ["phone", "desktop"], build: reply },
  error: { sizes: ["phone", "desktop"], build: error },
  send: { sizes: ["phone", "desktop"], build: send },
  sidebar: { sizes: ["desktop"], build: (s, v) => sidebar(s, v) },
};

export function sizesOf(scene: SceneName): Size[] {
  return SCENES[scene].sizes;
}

/** Draws the scene three times side by side and returns the clip's length in ms, the slowest pane plus a tail. */
export function mount(root: HTMLElement, scene: SceneName, size: Size): number {
  const { w, h: height } = STAGE[size];
  const zoom = size === "desktop" ? 0.62 : 1;
  root.style.cssText = `display:flex;gap:20px;padding:20px;background:#e9e9e7;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;width:max-content;`;
  let longest = 0;
  for (const pick of ["a", "b", "c"] as const) {
    const pane = h("div", "display:flex;flex-direction:column;gap:10px;", "", root);
    h("div", `font-size:15px;font-weight:600;color:${ink};letter-spacing:0.01em;`, LABELS[pick], pane);
    const frame = h("div", `width:${w * zoom}px;height:${height * zoom}px;overflow:hidden;border-radius:${size === "phone" ? 44 : 12}px;background:${ground};`, "", pane);
    const stage = h("div", `position:relative;width:${w}px;height:${height}px;overflow:hidden;background:${ground};transform:scale(${zoom});transform-origin:0 0;`, "", frame);
    longest = Math.max(longest, SCENES[scene].build(stage, MOTION_SPEEDS[pick], size));
  }
  return longest + 400;
}
