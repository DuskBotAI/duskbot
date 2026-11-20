// The phone's interactions at feels b, b+ and b++ of src/mobile/phone-feel.ts, side by side. The surfaces are drawn
// here, not mounted from the app; the springs, durations and curves are the feel's own.
import { feel as phone, springPath } from "../../src/mobile/motion";
import { PHONE_FEELS, type PhoneFeel, type PhoneFeelPick } from "../../src/mobile/phone-feel";

export type Device = "iphone-light" | "pixel-dark";
export type PhoneScene = "push" | "swipe" | "sheet" | "hold" | "viewer" | "send" | "reply" | "rows" | "pill" | "toast" | "refresh";

const DEVICE: Record<Device, { w: number; h: number; dark: boolean; radius: number; top: number }> = {
  "iphone-light": { w: 390, h: 844, dark: false, radius: 48, top: 54 },
  "pixel-dark": { w: 412, h: 915, dark: true, radius: 34, top: 36 },
};

export const PICKS: PhoneFeelPick[] = ["b", "b+", "b++"];
export const PICK_LABEL: Record<PhoneFeelPick, string> = { b: "B  now", "b+": "B+  Emil's rules", "b++": "B++  more expressive" };


const LEAD = 300;

type Ctx = { stage: HTMLElement; feel: PhoneFeel; d: (typeof DEVICE)[Device]; c: Palette };
type Palette = { ground: string; ink: string; soft: string; tone: string; mine: string; mineInk: string; scrim: string; card: string };

const palette = (dark: boolean): Palette => dark
  ? { ground: "#121212", ink: "#f2f2f2", soft: "#a3a3a3", tone: "#262626", mine: "#3b82f6", mineInk: "#f8fafc", scrim: "rgb(0 0 0 / 0.5)", card: "#1d1d1d" }
  : { ground: "#fcfcfb", ink: "#1c1c1c", soft: "#6b6b6b", tone: "#f0f0ef", mine: "#1477e8", mineInk: "#fbfdff", scrim: "rgb(0 0 0 / 0.25)", card: "#ffffff" };

function h(tag: string, css: string, text = "", parent?: Element): HTMLElement {
  const el = document.createElement(tag);
  el.style.cssText = css;
  if (text) el.textContent = text;
  parent?.appendChild(el);
  return el;
}

function play(el: Element, frames: Keyframe[], at: number, ms: number, easing: string, fill: FillMode = "both"): number {
  el.animate(frames, { duration: Math.max(1, ms), delay: at, easing, fill });
  return at + ms;
}

/** a spring from `from` to `to` leaving at `velocity` units/s, as per-frame keyframes */
function spring(el: Element, from: number, to: number, velocity: number, s: { stiffness: number; damping: number; mass?: number }, at: number, frame: (p: number) => Keyframe, fill: FillMode = "both"): number {
  const path = springPath(from, to, velocity, s, Math.abs(to - from) > 2 ? 0.25 : 0.002);
  return play(el, path.points.map(frame), at, path.duration, "linear", fill);
}

function haptic(ctx: Ctx, at: number, strong = false): void {
  const tag = h("div", `position:absolute;left:50%;top:${ctx.d.top - 30}px;transform:translateX(-50%);padding:3px 10px;border-radius:999px;background:#f59e0b;color:#1c1c1c;font:600 11px -apple-system,system-ui;z-index:50;opacity:0;`, strong ? "haptic: medium" : "haptic", ctx.stage);
  play(tag, [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], at, 520, "linear");
}

function finger(ctx: Ctx, path: Array<{ x: number; y: number; t: number }>): void {
  const dot = h("div", "position:absolute;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;background:rgb(128 128 128 / 0.35);border:2px solid rgb(255 255 255 / 0.7);z-index:60;opacity:0;", "", ctx.stage);
  const start = path[0]!.t, end = path[path.length - 1]!.t;
  const span = Math.max(1, end - start);
  const frames: Keyframe[] = path.map((p, i) => ({ transform: `translate(${p.x}px, ${p.y}px)`, opacity: i === path.length - 1 ? 0 : 1, offset: (p.t - start) / span }));
  play(dot, frames, start, span, "linear", "forwards");
}

function topBar(ctx: Ctx, parent: HTMLElement, title: string): void {
  const bar = h("div", `height:${ctx.d.top + 44}px;display:flex;align-items:flex-end;justify-content:center;padding-bottom:10px;font:600 17px -apple-system,system-ui;color:${ctx.c.ink};position:relative;`, title, parent);
  h("div", `position:absolute;left:16px;bottom:6px;width:36px;height:36px;border-radius:50%;background:${ctx.c.tone};`, "", bar);
}

function bubble(ctx: Ctx, parent: Element, text: string, mine: boolean): HTMLElement {
  const row = h("div", `display:flex;justify-content:${mine ? "flex-end" : "flex-start"};`, "", parent);
  return h("div", `max-width:76%;padding:10px 15px;border-radius:20px;font:16px/1.45 -apple-system,system-ui;background:${mine ? ctx.c.mine : ctx.c.tone};color:${mine ? ctx.c.mineInk : ctx.c.ink};`, text, row);
}

function chat(ctx: Ctx, parent: HTMLElement): { column: HTMLElement; composer: HTMLElement } {
  topBar(ctx, parent, "Juno");
  const body = h("div", `position:absolute;left:0;right:0;top:${ctx.d.top + 44}px;bottom:96px;overflow:hidden;`, "", parent);
  const column = h("div", "position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;gap:12px;padding:14px 16px;", "", body);
  bubble(ctx, column, "Hi, I'm Juno. What would you like me to do?", false);
  bubble(ctx, column, "Book the dentist for next week", true);
  bubble(ctx, column, "Booked Tuesday at 9:30 and added it to your calendar with a 30 minute reminder.", false);
  const composer = h("div", `position:absolute;left:12px;right:12px;bottom:30px;height:50px;border-radius:25px;background:${ctx.c.tone};display:flex;align-items:center;padding:0 18px;font:16px -apple-system,system-ui;color:${ctx.c.soft};`, "Message Juno", parent);
  return { column, composer };
}

const NAMES = [["Juno", "Booked Tuesday at 9:30."], ["Basil", "Found 3 flats under budget."], ["Echo", "Inbox is down to 4."], ["Tally", "This month's spend is $1,284."], ["Quill", "Drafted the launch note."], ["Rivet", "The build passed."], ["Nova", "Your flight moved to 9:40."], ["Moss", "Watered the plan, so to speak."], ["Launch room", "No messages yet"]];
const HUES = ["#38bdf8", "#3b82f6", "#f97316", "#a78bfa", "#ec4899", "#a16207", "#eab308", "#22c55e", "#94a3b8"];

function list(ctx: Ctx, parent: HTMLElement): HTMLElement[] {
  h("div", `height:${ctx.d.top + 44}px;`, "", parent);
  h("div", `padding:0 20px 10px;font:700 30px -apple-system,system-ui;color:${ctx.c.ink};`, "Chats", parent);
  return NAMES.map(([name, line], i) => {
    const row = h("div", "display:flex;gap:12px;align-items:center;padding:10px 20px;", "", parent);
    h("div", `width:48px;height:48px;border-radius:14px;background:${HUES[i]};flex:none;`, "", row);
    const text = h("div", "min-width:0;", "", row);
    h("div", `font:600 16px -apple-system,system-ui;color:${ctx.c.ink};`, name, text);
    h("div", `font:14px -apple-system,system-ui;color:${ctx.c.soft};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`, line, text);
    return row;
  });
}

function navLayers(ctx: Ctx) {
  const W = ctx.d.w;
  const base = h("div", `position:absolute;inset:0;background:${ctx.c.ground};`, "", ctx.stage);
  list(ctx, base);
  const dim = h("div", "position:absolute;inset:0;background:rgb(0 0 0 / 0.14);opacity:0;", "", ctx.stage);
  const page = h("div", `position:absolute;inset:0;background:${ctx.c.ground};box-shadow:-10px 0 30px rgb(0 0 0 / 0.08);transform:translateX(${W}px);`, "", ctx.stage);
  chat(ctx, page);
  const move = (from: number, to: number, v: number, s: { stiffness: number; damping: number }, at: number, fill: FillMode) => {
    spring(base, from, to, v, s, at, (p) => ({ transform: `translateX(${-0.3 * (W - p)}px)` }), fill);
    spring(dim, from, to, v, s, at, (p) => ({ opacity: 1 - p / W }), fill);
    return spring(page, from, to, v, s, at, (p) => ({ transform: `translateX(${p}px)` }), fill);
  };
  return { base, dim, page, move, W };
}

function push(ctx: Ctx): number {
  const { move, W } = navLayers(ctx);
  const v = 10 / 1.4;
  finger(ctx, [{ x: 120, y: 330, t: LEAD - 80 }, { x: 120, y: 330, t: LEAD + 20 }]);
  move(W, 0, -v * W, ctx.feel.nav.push, LEAD, "both");
  finger(ctx, [{ x: 40, y: ctx.d.top + 22, t: 1900 }, { x: 40, y: ctx.d.top + 22, t: 2000 }]);
  return move(0, W, v * W, ctx.feel.nav.pop, 2000, "forwards") + 300;
}

function swipe(ctx: Ctx): number {
  const { base, dim, page, move, W } = navLayers(ctx);
  for (const el of [base, dim, page]) el.getAnimations().forEach((a) => a.cancel());
  page.style.transform = "translateX(0)";
  base.style.transform = `translateX(${-0.3 * W}px)`;
  dim.style.opacity = "1";
  const drag = 260, dragMs = 220, x0 = 8, y = 420;
  const steps = 14;
  const track: Keyframe[] = [], under: Keyframe[] = [], fade: Keyframe[] = [];
  const path: Array<{ x: number; y: number; t: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const p = (drag * i) / steps;
    track.push({ transform: `translateX(${p}px)` });
    under.push({ transform: `translateX(${-0.3 * (W - p)}px)` });
    fade.push({ opacity: 1 - p / W });
    path.push({ x: x0 + p, y, t: LEAD + (dragMs * i) / steps });
  }
  play(page, track, LEAD, dragMs, "linear");
  play(base, under, LEAD, dragMs, "linear");
  play(dim, fade, LEAD, dragMs, "linear");
  path.push({ x: x0 + drag + 30, y, t: LEAD + dragMs + 60 });
  finger(ctx, path);
  const velocity = (drag / dragMs) * 1000;
  return move(drag, W, velocity, ctx.feel.nav.release, LEAD + dragMs, "forwards") + 400;
}

function sheet(ctx: Ctx): number {
  const { d, feel, c } = ctx;
  ctx.stage.style.background = "#000";
  const page = h("div", `position:absolute;inset:0;background:${c.ground};transform-origin:50% 0;overflow:hidden;`, "", ctx.stage);
  chat(ctx, page);
  const scrim = h("div", `position:absolute;inset:0;background:${c.scrim};opacity:0;`, "", ctx.stage);
  const H = d.h - d.top - 12;
  const box = h("div", `position:absolute;left:0;right:0;bottom:0;height:${H}px;border-radius:16px 16px 0 0;background:${c.card};transform:translateY(${H}px);padding:12px 20px;`, "", ctx.stage);
  h("div", "width:36px;height:5px;border-radius:3px;background:#a3a3a3;margin:0 auto 18px;", "", box);
  h("div", `font:700 22px -apple-system,system-ui;color:${c.ink};margin-bottom:12px;`, "Juno", box);
  for (const row of ["Model", "Thinking", "Memory", "Skills", "Routines", "Computer", "Advanced"]) h("div", `padding:15px 0;font:16px -apple-system,system-ui;color:${c.ink};border-bottom:1px solid ${c.tone};`, row, box);
  const prog = (p: number) => Math.max(0, Math.min(1, 1 - p / H));
  const frame = (p: number): Keyframe => ({ transform: `translateY(${(prog(p) * 0.5 * d.top).toFixed(2)}px) scale(${(1 - feel.sheet.recede * prog(p)).toFixed(4)})`, borderRadius: `${(prog(p) * 14).toFixed(1)}px` });
  const run = (from: number, to: number, v: number, s: { stiffness: number; damping: number }, at: number, fill: FillMode) => {
    spring(scrim, from, to, v, s, at, (p) => ({ opacity: prog(p) }), fill);
    spring(page, from, to, v, s, at, frame, fill);
    return spring(box, from, to, v, s, at, (p) => ({ transform: `translateY(${p}px)` }), fill);
  };
  const push = 10 / 1.4;
  const rest = H * (1 - feel.sheet.detent);
  finger(ctx, [{ x: d.w - 70, y: d.top + 22, t: LEAD - 80 }, { x: d.w - 70, y: d.top + 22, t: LEAD + 20 }]);
  run(H, rest, -push * H, feel.sheet.open, LEAD, "both");
  let at = 1500;
  if (rest > 0) {
    const steps = 10, dragMs = 200, frames: Keyframe[] = [], linked: Keyframe[] = [], pageFrames: Keyframe[] = [];
    const path: Array<{ x: number; y: number; t: number }> = [];
    const pulled = rest * 0.55;
    for (let i = 0; i <= steps; i++) {
      const p = rest - (pulled * i) / steps;
      frames.push({ transform: `translateY(${p}px)` });
      linked.push({ opacity: prog(p) });
      pageFrames.push(frame(p));
      path.push({ x: d.w / 2, y: d.h - H + p + 20, t: at + (dragMs * i) / steps });
    }
    play(box, frames, at, dragMs, "linear", "forwards");
    play(scrim, linked, at, dragMs, "linear", "forwards");
    play(page, pageFrames, at, dragMs, "linear", "forwards");
    path.push({ x: d.w / 2, y: d.h - H + rest - pulled - 20, t: at + dragMs + 60 });
    finger(ctx, path);
    const from = rest - pulled;
    const caught = run(from, 0, -(pulled / dragMs) * 1000, feel.sheet.snap, at + dragMs, "forwards");
    if (feel.haptic !== "press") haptic(ctx, at + dragMs + Math.min(260, caught - at - dragMs) * 0.55);
    at = 2700;
  } else at = 2200;
  finger(ctx, [{ x: d.w - 40, y: d.h - H + 40, t: at - 80 }, { x: d.w - 40, y: d.h - H + 40, t: at + 20 }]);
  return run(0, H + 24, push * H, feel.sheet.close, at, "forwards") + 300;
}

function hold(ctx: Ctx): number {
  const { d, feel, c } = ctx;
  const { column } = chat(ctx, ctx.stage);
  const held = column.children[2]!.firstElementChild as HTMLElement;
  const scrim = h("div", `position:absolute;inset:0;background:${c.scrim};opacity:0;backdrop-filter:blur(${feel.hold.blur}px);-webkit-backdrop-filter:blur(${feel.hold.blur}px);z-index:5;`, "", ctx.stage);
  const box = held.getBoundingClientRect(), stage = ctx.stage.getBoundingClientRect();
  const zoom = stage.width / d.w || 1;
  const top = (box.top - stage.top) / zoom, left = (box.left - stage.left) / zoom, width = box.width / zoom;
  const lifted = h("div", `position:absolute;left:${left}px;top:${top}px;width:${width}px;padding:10px 15px;border-radius:20px;background:${c.tone};color:${c.ink};font:16px/1.45 -apple-system,system-ui;z-index:6;opacity:0;box-sizing:border-box;transform-origin:0 0;`, held.textContent ?? "", ctx.stage);
  const menu = h("div", `position:absolute;left:${left}px;bottom:${d.h - top + 10}px;width:230px;padding:6px;border-radius:16px;background:${c.card};box-shadow:0 12px 32px rgb(0 0 0 / 0.18);z-index:7;opacity:0;transform-origin:${feel.hold.fromBubble ? "0 100%" : "50% 100%"};`, "", ctx.stage);
  const items = ["Reply", "Copy", "React", "Pin", "Delete"].map((item) => h("div", `padding:11px 12px;font:16px -apple-system,system-ui;color:${item === "Delete" ? "#ef4444" : c.ink};`, item, menu));
  finger(ctx, [{ x: left + 80, y: top + 30, t: LEAD - 40 }, { x: left + 80, y: top + 30, t: LEAD + 430 }]);
  play(held, [{ transform: "scale(1)" }, { transform: "scale(1)", offset: 0.28 }, { transform: "scale(0.96)" }], LEAD, 430, "cubic-bezier(.22,1,.36,1)", "forwards");
  const fire = LEAD + 430;
  if (feel.haptic !== "peak") haptic(ctx, fire);
  play(scrim, [{ opacity: 0 }, { opacity: 1 }], fire, 220, "ease-out");
  play(held, [{ opacity: 1 }, { opacity: 0 }], fire, 1, "linear");
  const liftEnd = spring(lifted, 0.96, feel.hold.lift, 0, phone.lift.spring, fire, (s) => ({ opacity: 1, transform: `scale(${s})` }));
  if (feel.haptic !== "press") haptic(ctx, fire + Math.min(160, liftEnd - fire) * 0.6, feel.haptic === "press+peak");
  const from = feel.hold.fromBubble ? 0.9 : 0.96;
  spring(menu, from, 1, 0, feel.hold.menu, fire + 40, (s) => ({ transform: `scale(${s})` }));
  play(menu, [{ opacity: 0 }, { opacity: 1 }], fire + 40, 160, "ease-out");
  if (feel.hold.stagger) items.forEach((item, i) => play(item, [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], fire + 60 + i * feel.hold.stagger, 180, "cubic-bezier(.22,1,.36,1)"));
  const leave = 2400;
  finger(ctx, [{ x: d.w / 2, y: 140, t: leave - 80 }, { x: d.w / 2, y: 140, t: leave + 20 }]);
  play(menu, [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: `scale(${feel.hold.fromBubble ? 0.9 : 0.97})` }], leave, feel.hold.exitMs, "cubic-bezier(.22,1,.36,1)", "forwards");
  play(scrim, [{ opacity: 1 }, { opacity: 0 }], leave, 160, "ease-out", "forwards");
  play(lifted, [{ transform: `scale(${feel.hold.lift})` }, { transform: "scale(1)" }], leave, 200, "cubic-bezier(.22,1,.36,1)", "forwards");
  play(lifted, [{ opacity: 1 }, { opacity: 0 }], leave + 200, 1, "linear", "forwards");
  return play(held, [{ opacity: 0, transform: "scale(1)" }, { opacity: 1, transform: "scale(1)" }], leave + 200, 1, "linear", "forwards") + 500;
}

function viewer(ctx: Ctx): number {
  const { d, feel } = ctx;
  const { column } = chat(ctx, ctx.stage);
  const row = h("div", "display:flex;justify-content:flex-start;", "", column);
  const thumb = h("div", "width:200px;height:150px;border-radius:18px;background:linear-gradient(135deg,#fb923c,#f43f5e 55%,#7c3aed);", "", row);
  const box = thumb.getBoundingClientRect(), stage = ctx.stage.getBoundingClientRect();
  const zoom = stage.width / d.w || 1;
  const tx = (box.left - stage.left) / zoom, ty = (box.top - stage.top) / zoom;
  const fullW = d.w, fullH = d.w * 0.75, fy = (d.h - fullH) / 2;
  const back = h("div", "position:absolute;inset:0;background:#000;opacity:0;z-index:5;", "", ctx.stage);
  const img = h("div", `position:absolute;left:0;top:${fy}px;width:${fullW}px;height:${fullH}px;background:linear-gradient(135deg,#fb923c,#f43f5e 55%,#7c3aed);z-index:6;opacity:0;transform-origin:0 0;`, "", ctx.stage);
  finger(ctx, [{ x: tx + 100, y: ty + 75, t: LEAD - 80 }, { x: tx + 100, y: ty + 75, t: LEAD + 20 }]);
  const sx = 200 / fullW, sy = 150 / fullH;
  const at = (p: number): Keyframe => {
    const s = sx + (1 - sx) * p, sY = sy + (1 - sy) * p;
    const x = tx * (1 - p), y = ty + (fy - ty) * p;
    const r = feel.viewer.radiusMorph ? 18 * (1 - p) / s : 0;
    return { transform: `translate(${x - 0}px, ${y - fy}px) scale(${s}, ${sY})`, borderRadius: `${r}px`, opacity: 1 };
  };
  const close = 2200;
  if (feel.viewer.zoom) {
    play(thumb, [{ opacity: 1 }, { opacity: 0 }], LEAD, 1, "linear");
    spring(img, 0, 1, 0, feel.viewer.open, LEAD, at);
    play(back, [{ opacity: 0 }, { opacity: 1 }], LEAD, 240, "cubic-bezier(.23,1,.32,1)");
    finger(ctx, [{ x: d.w / 2, y: d.h / 2, t: close - 80 }, { x: d.w / 2, y: d.h / 2, t: close + 20 }]);
    play(img, [at(1), at(0)], close, feel.viewer.closeMs, "cubic-bezier(.23,1,.32,1)", "forwards");
    play(back, [{ opacity: 1 }, { opacity: 0 }], close, feel.viewer.closeMs * 0.8, "ease-out", "forwards");
    play(thumb, [{ opacity: 0 }, { opacity: 1 }], close + feel.viewer.closeMs, 1, "linear", "forwards");
    return close + feel.viewer.closeMs + 500;
  }
  img.style.transform = "none";
  const H = d.h;
  spring(img, H, 0, -(10 / 1.4) * H, feel.viewer.open, LEAD, (p) => ({ transform: `translateY(${p}px)`, opacity: 1 }));
  spring(back, H, 0, -(10 / 1.4) * H, feel.viewer.open, LEAD, (p) => ({ opacity: 1 - p / H }));
  finger(ctx, [{ x: d.w / 2, y: d.h / 2, t: close - 80 }, { x: d.w / 2, y: d.h / 2, t: close + 20 }]);
  play(img, [{ transform: "translateY(0)" }, { transform: `translateY(${H}px)` }], close, feel.viewer.closeMs, "cubic-bezier(.22,1,.36,1)", "forwards");
  return play(back, [{ opacity: 1 }, { opacity: 0 }], close, feel.viewer.closeMs, "ease-out", "forwards") + 500;
}

function send(ctx: Ctx): number {
  const { feel, c, d } = ctx;
  const { column, composer } = chat(ctx, ctx.stage);
  composer.textContent = "";
  const typed = h("span", `color:${c.ink};`, "and the cleaning on Friday?", composer);
  const mine = bubble(ctx, column, "and the cleaning on Friday?", true);
  mine.style.transformOrigin = "100% 100%";
  const gap = (mine.parentElement!.offsetHeight || 44) + 12;
  const st = ctx.stage.getBoundingClientRect(), mr = mine.getBoundingClientRect();
  if (feel.send.fromComposer) {
    column.parentElement!.style.overflow = "visible";
    mine.style.position = "relative";
    mine.style.zIndex = "2";
  }
  finger(ctx, [{ x: d.w - 40, y: d.h - 55, t: LEAD - 80 }, { x: d.w - 40, y: d.h - 55, t: LEAD + 20 }]);
  play(typed, [{ opacity: 1 }, { opacity: 0 }], LEAD, 1, "linear");
  const glideMs = feel.send.ms || 320;
  play(column, [{ transform: `translateY(${gap}px)` }, { transform: "translateY(0)" }], LEAD, glideMs, feel.send.ease);
  if (!feel.send.fromComposer) return play(mine, [{ opacity: 0, transform: "translateY(16px) scale(0.9)" }, { opacity: 1, transform: "translateY(0) scale(1)" }], LEAD, feel.send.ms, feel.send.ease) + 900;
  const fromY = d.h - 55 - (mr.top - st.top + mr.height / 2) - gap;
  const startX = 30 + mr.width / 2 - (mr.left - st.left + mr.width / 2);
  if (feel.send.spring) {
    spring(mine, 0, 1, 0, feel.send.spring, LEAD, (p) => ({ transform: `translate(${startX * (1 - p)}px, ${fromY * (1 - p)}px)`, opacity: Math.min(1, p * 3), clipPath: `inset(0 0 0 ${Math.max(0, 1 - p * 1.6) * 60}% round 20px)` }));
    return LEAD + 1300;
  }
  return play(mine, [{ opacity: 0.4, transform: `translate(${startX}px, ${fromY}px)` }, { opacity: 1, transform: "translate(0, 0)" }], LEAD, feel.send.ms, feel.send.ease) + 900;
}

function reply(ctx: Ctx): number {
  const { feel, c } = ctx;
  const { column } = chat(ctx, ctx.stage);
  const end = h("div", "position:relative;", "", column);
  const line = h("div", `position:absolute;top:0;left:0;display:flex;align-items:center;gap:8px;height:26px;font:15px -apple-system,system-ui;color:${c.soft};`, "", end);
  h("div", "width:18px;height:18px;border-radius:5px;background:#38bdf8;", "", line);
  h("span", "", "Checking your calendar", line);
  const answer = bubble(ctx, end, "", false);
  const sentences = ["Friday is clear after 2.", "I booked the cleaning for 3:00", "and sent the confirmation to your email."];
  const lines = sentences.map((text) => h("span", "display:block;", text, answer));
  answer.style.opacity = "0";
  answer.style.transformOrigin = "0 0";
  const shift = Math.max(0, (answer.parentElement!.offsetHeight || 96) - 26);
  const follow = feel.reply.grow;
  play(column, [{ transform: `translateY(${shift}px)` }, { transform: "translateY(0)" }], LEAD, 336, "cubic-bezier(0.25, 0.85, 0.3, 1)");
  if (feel.reply.blurLine) play(line, [{ opacity: 1, filter: "blur(0)" }, { opacity: 0, filter: "blur(4px)" }], LEAD, 200, "ease");
  else play(line, [{ opacity: 1 }, { opacity: 0 }], LEAD, 196, "cubic-bezier(0.25, 0.85, 0.3, 1)");
  if (!feel.reply.clip) return spring(answer, 0.94, 1, 0, follow, LEAD, (s) => ({ opacity: Math.min(1, (s - 0.94) / 0.04), transform: `scale(${s})` })) + 900;
  spring(answer, 0, 1, 0, follow, LEAD, (p) => ({ opacity: Math.min(1, p * 2), clipPath: `inset(0 0 ${(1 - p) * 100}% 0 round 20px)` }));
  if (feel.reply.lineStagger) lines.forEach((el, i) => play(el, [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], LEAD + i * feel.reply.lineStagger, 260, "cubic-bezier(.23,1,.32,1)"));
  return LEAD + 1500;
}

function rows(ctx: Ctx): number {
  const { feel } = ctx;
  const all = list(ctx, ctx.stage);
  all.forEach((row, i) => {
    const delay = feel.rows.delays ? feel.rows.delays[Math.min(i, feel.rows.delays.length - 1)]! : i * feel.rows.stagger;
    play(row, [{ opacity: 0, transform: `translateY(${feel.rows.rise}px)` }, { opacity: 1, transform: "none" }], LEAD + delay, 260, "cubic-bezier(.22,1,.36,1)");
  });
  return LEAD + 1400;
}

function pill(ctx: Ctx): number {
  const { feel, c, d } = ctx;
  topBar(ctx, ctx.stage, "Juno");
  const W = d.w - 40, seg = W / 3;
  const track = h("div", `position:absolute;left:20px;top:${d.top + 70}px;width:${W}px;height:40px;border-radius:20px;background:${c.tone};`, "", ctx.stage);
  const labels = ["Details", "Computer", "Advanced"];
  const base = h("div", "position:absolute;inset:0;display:flex;", "", track);
  for (const label of labels) h("div", `flex:1;display:flex;align-items:center;justify-content:center;font:500 15px -apple-system,system-ui;color:${c.soft};`, label, base);
  const stops = [0, 2, 1];
  const times = [LEAD, 1500];
  if (feel.pill.mode === "clip") {
    const copy = h("div", `position:absolute;inset:0;display:flex;border-radius:20px;background:${c.card};clip-path:inset(4px ${W - seg + 4}px 4px 4px round 16px);`, "", track);
    for (const label of labels) h("div", `flex:1;display:flex;align-items:center;justify-content:center;font:600 15px -apple-system,system-ui;color:${c.ink};`, label, copy);
    const clip = (i: number) => `inset(4px ${W - seg * (i + 1) + 4}px 4px ${seg * i + 4}px round 16px)`;
    times.forEach((t, k) => {
      finger(ctx, [{ x: 20 + seg * stops[k + 1]! + seg / 2, y: d.top + 90, t: t - 80 }, { x: 20 + seg * stops[k + 1]! + seg / 2, y: d.top + 90, t: t + 20 }]);
      play(copy, [{ clipPath: clip(stops[k]!) }, { clipPath: clip(stops[k + 1]!) }], t, feel.pill.ms, "cubic-bezier(0.77, 0, 0.175, 1)", k ? "forwards" : "both");
    });
    return 2600;
  }
  const thumb = h("div", `position:absolute;top:4px;left:4px;height:32px;width:${seg - 8}px;border-radius:16px;background:${c.card};box-shadow:0 1px 3px rgb(0 0 0 / 0.15);`, "", track);
  track.insertBefore(thumb, base);
  times.forEach((t, k) => {
    const from = seg * stops[k]!, to = seg * stops[k + 1]!;
    finger(ctx, [{ x: 20 + to + seg / 2, y: d.top + 90, t: t - 80 }, { x: 20 + to + seg / 2, y: d.top + 90, t: t + 20 }]);
    const fill: FillMode = k ? "forwards" : "both";
    if (feel.pill.mode === "spring") spring(thumb, from, to, 0, feel.pill.spring, t, (x) => ({ transform: `translateX(${x}px)` }), fill);
    else {
      const lead = springPath(from, to, 0, { stiffness: 620, damping: 36 }, 0.25);
      const trail = springPath(from, to, 0, { stiffness: 190, damping: 19 }, 0.25);
      const n = Math.max(lead.points.length, trail.points.length);
      const frames: Keyframe[] = [];
      for (let i = 0; i < n; i++) {
        const a = lead.points[Math.min(i, lead.points.length - 1)]!, b = trail.points[Math.min(i, trail.points.length - 1)]!;
        const left = Math.min(a, b), width = seg - 8 + Math.abs(a - b);
        frames.push({ transform: `translateX(${left}px)`, width: `${width}px` });
      }
      play(thumb, frames, t, Math.round((n - 1) * 1000 / 60), "linear", fill);
    }
  });
  return 2600;
}

function toast(ctx: Ctx): number {
  const { feel, c } = ctx;
  chat(ctx, ctx.stage);
  const make = (text: string) => h("div", `position:absolute;left:16px;right:16px;bottom:96px;padding:14px 16px;border-radius:16px;background:${c.ink};color:${c.ground};font:15px -apple-system,system-ui;z-index:8;opacity:0;`, text, ctx.stage);
  const first = make("Copied to clipboard");
  const from = (el: HTMLElement) => feel.toast.from === "self" ? `${(el.offsetHeight || 48) + 96}px` : `${feel.toast.from}px`;
  play(first, [{ opacity: 0, transform: `translateY(${from(first)})` }, { opacity: 1, transform: "translateY(0)" }], LEAD, feel.toast.inMs, feel.toast.ease);
  if (feel.toast.stack) {
    const second = make("Saved to Juno's notes");
    play(second, [{ opacity: 0, transform: `translateY(${from(second)})` }, { opacity: 1, transform: "translateY(0)" }], 1100, feel.toast.inMs, feel.toast.ease);
    play(first, [{ transform: "translateY(0) scale(1)" }, { transform: "translateY(-14px) scale(0.95)" }], 1100, feel.toast.inMs, feel.toast.ease, "forwards");
    play(second, [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: `translateY(${from(second)})` }], 2300, feel.toast.outMs, feel.toast.ease, "forwards");
    play(first, [{ opacity: 1, transform: "translateY(-14px) scale(0.95)" }, { opacity: 0, transform: `translateY(${from(first)}) scale(0.95)` }], 2300, feel.toast.outMs, feel.toast.ease, "forwards");
    return 2300 + feel.toast.outMs + 500;
  }
  return play(first, [{ opacity: 1, transform: "translateY(0)" }, feel.toast.from === "self" ? { opacity: 0, transform: `translateY(${from(first)})` } : { opacity: 0, transform: "translateY(0)" }], 2000, feel.toast.outMs, feel.toast.ease, "forwards") + 500;
}

function refresh(ctx: Ctx): number {
  const { feel, c, d } = ctx;
  const page = h("div", `position:absolute;inset:0;background:${c.ground};`, "", ctx.stage);
  list(ctx, page);
  const spinner = h("div", `position:absolute;left:50%;top:${d.top + 20}px;width:26px;height:26px;margin-left:-13px;border-radius:50%;border:3px solid ${c.tone};border-top-color:${c.ink};opacity:0;`, "", ctx.stage);
  const mascot = feel.refresh.mascot ? h("div", `position:absolute;left:50%;top:${d.top + 60}px;width:28px;height:24px;margin-left:-14px;border-radius:6px;background:#38bdf8;opacity:0;`, "", ctx.stage) : null;
  const limit = 140, threshold = 72, dragMs = 520, steps = 20;
  const band = (x: number) => (1 - 1 / ((x * 0.55) / limit + 1)) * limit;
  const frames: Keyframe[] = [], spin: Keyframe[] = [];
  const path: Array<{ x: number; y: number; t: number }> = [];
  let armedAt = 0;
  for (let i = 0; i <= steps; i++) {
    const raw = (300 * i) / steps, p = band(raw);
    if (!armedAt && p >= threshold) armedAt = LEAD + (dragMs * i) / steps;
    frames.push({ transform: `translateY(${p}px)` });
    const turn = feel.refresh.linked ? (p / threshold) * 300 : 0;
    spin.push({ opacity: Math.min(1, p / threshold), transform: `rotate(${turn}deg) scale(${0.7 + 0.3 * Math.min(1, p / threshold)})` });
    path.push({ x: d.w / 2, y: 260 + raw * 0.9, t: LEAD + (dragMs * i) / steps });
  }
  play(page, frames, LEAD, dragMs, "linear");
  play(spinner, spin, LEAD, dragMs, "linear");
  finger(ctx, [...path, { x: d.w / 2, y: 260 + 300 * 0.9 + 20, t: LEAD + dragMs + 60 }]);
  haptic(ctx, armedAt);
  if (mascot) {
    play(mascot, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }], armedAt, 160, "ease-out", "both");
    play(mascot, [{ transform: "translateY(0)" }, { transform: "translateY(-10px)", offset: 0.4 }, { transform: "translateY(0)" }], armedAt + 160, 360, "ease-in-out", "forwards");
  }
  const release = LEAD + dragMs;
  const held = band(300);
  const velocity = feel.refresh.linked ? 260 : 0;
  spring(page, held, 56, -velocity, feel.refresh.release, release, (p) => ({ transform: `translateY(${p}px)` }), "forwards");
  play(spinner, [{ opacity: 1, transform: "rotate(0deg)" }, { opacity: 1, transform: "rotate(720deg)" }], release, 1100, "linear", "forwards");
  const done = release + 1100;
  play(spinner, [{ opacity: 1 }, { opacity: 0 }], done, 160, "ease-out", "forwards");
  if (mascot) play(mascot, [{ opacity: 1 }, { opacity: 0 }], done, 160, "ease-out", "forwards");
  return spring(page, 56, 0, 0, feel.refresh.release, done, (p) => ({ transform: `translateY(${p}px)` }), "forwards") + 400;
}

const BUILD: Record<PhoneScene, (ctx: Ctx) => number> = { push, swipe, sheet, hold, viewer, send, reply, rows, pill, toast, refresh };

/** Draws the scene for b, b+ and b++ side by side; returns the clip's length in ms. */
export function mount(root: HTMLElement, scene: PhoneScene, device: Device): number {
  const d = DEVICE[device];
  const c = palette(d.dark);
  root.style.cssText = `display:flex;gap:22px;padding:20px;background:${d.dark ? "#2a2a2a" : "#e9e9e7"};font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;width:max-content;color-scheme:${d.dark ? "dark" : "light"};`;
  const panes = PICKS.map((pick) => {
    const pane = h("div", "display:flex;flex-direction:column;gap:10px;", "", root);
    h("div", `font:600 15px -apple-system,system-ui;color:${d.dark ? "#f2f2f2" : "#1c1c1c"};`, PICK_LABEL[pick], pane);
    const frame = h("div", `width:${d.w}px;height:${d.h}px;overflow:hidden;border-radius:${d.radius}px;background:${c.ground};`, "", pane);
    const stage = h("div", `position:relative;width:${d.w}px;height:${d.h}px;overflow:hidden;background:${c.ground};`, "", frame);
    return { pick, stage };
  });
  let longest = 0;
  for (const { pick, stage } of panes) longest = Math.max(longest, BUILD[scene]({ stage, feel: PHONE_FEELS[pick], d, c }));
  return longest + 300;
}
