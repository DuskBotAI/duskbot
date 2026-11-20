import type { PixelState } from "@/pixel/engine";
import type { WorkingMood } from "./working-mood";

export type MascotVariant = "flat-gentle";
export type MascotMotionPick = "current" | MascotVariant;

/** How the chat's working mascot moves: "current" keeps the old CSS loops; "flat-gentle" moves the flat sprite
 * smoothly in 2D at a gentle pace. */
export const MASCOT_MOTION: MascotMotionPick = "flat-gentle";

/** No two delights (a spin, a flip, a bounce) start closer than this. */
export const DELIGHT_GAP_MS = 18_000;
const DELIGHT_EVERY: readonly [number, number] = [18_000, 25_000];
/** A new step (other than the reply, the end or a failure) moves the body only once it has lasted this long. */
export const SETTLE_MS = 3000;
/** A change of step glides from wherever the mascot is to the new motion over this long. */
export const BLEND_MS = 800;
/** Every move plays this many times slower than its written timing. */
const TEMPO = 1.5;
/** Share of the full squash and stretch. */
const GIVE = 0.6;
const HOP = 0.09;
const PERIOD = 0.68;

/** Where the mascot is at one moment: x and y in box sizes (negative y is up), squash as x and y scale about its
 * feet, rot in degrees about its middle. */
export type MascotMotion = { x: number; y: number; sx: number; sy: number; rot: number; face: PixelState; look: number; blink: boolean };

type Delight = "spin" | "flip" | "bounce";
const DELIGHTS: readonly Delight[] = ["spin", "flip", "bounce"];
const DELIGHT_MS: Record<Delight, number> = { spin: 900, flip: 1000, bounce: 1100 };

type Faced = { face: PixelState; ms: number; once?: boolean };
const FACES: Record<WorkingMood, readonly Faced[]> = {
  thinking: [{ face: "thinking", ms: 5600 }, { face: "confused", ms: 2200 }],
  reading: [{ face: "working", ms: 3000 }],
  writing: [{ face: "working", ms: 3000 }],
  replying: [{ face: "happy", ms: 2000, once: true }, { face: "working", ms: 3000 }],
  running: [{ face: "working", ms: 3200 }, { face: "listening", ms: 2000 }],
  searching: [{ face: "searching", ms: 2800 }],
  browsing: [{ face: "listening", ms: 2800 }, { face: "working", ms: 2400 }],
  waiting: [{ face: "idle", ms: 3000 }, { face: "confused", ms: 2000 }],
  error: [{ face: "sad", ms: 4000 }],
  done: [{ face: "happy", ms: 4000 }],
};

const DELIGHT_MOODS = new Set<WorkingMood>(["thinking", "searching", "browsing", "running", "reading", "writing"]);
const LOOKING_MOODS = new Set<WorkingMood>(["thinking", "searching", "reading"]);
const HOP_IN_MOODS = new Set<WorkingMood>(["replying", "done"]);
const AT_ONCE_MOODS = new Set<WorkingMood>(["replying", "done", "error"]);
const HOP_IN_MS = 1000;

const TAU = Math.PI * 2;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const span = (k: number, a: number, b: number) => clamp01((k - a) / (b - a));
const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const easeInOutSine = (k: number) => (1 - Math.cos(Math.PI * k)) / 2;
const arc = (k: number) => 4 * k * (1 - k);
/** -1..1 that holds at each side and glides between them, one full cycle per `period` */
const sideToSide = (t: number, period: number) => Math.max(-1, Math.min(1, Math.sin((TAU * t) / period) * 1.6));
const wrap = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

const REST: MascotMotion = { x: 0, y: 0, sx: 1, sy: 1, rot: 0, face: "idle", look: 0, blink: false };

function breathe(m: MascotMotion, t: number, amount = 1): void {
  const b = Math.sin((TAU * t) / 2.6) * amount;
  m.sy += 0.03 * b;
  m.sx -= 0.018 * b;
  m.y -= 0.012 * (b + 1);
}

function hopCycle(m: MascotMotion, t: number, period: number, height: number): void {
  const u = (t / period) % 1, scale = height / 0.15;
  if (u < 0.6) {
    const a = u / 0.6;
    m.y -= height * arc(a);
    m.sy += 0.07 * Math.sin(Math.PI * a) * scale;
    m.sx -= 0.04 * Math.sin(Math.PI * a) * scale;
  } else {
    const s = Math.sin((Math.PI * (u - 0.6)) / 0.4) * scale;
    m.sy -= 0.13 * s;
    m.sx += 0.09 * s;
  }
}

/** A one-shot jump that turns `deg` in the air: crouch, launch, turn, land with a squash that springs back once. */
function jump(m: MascotMotion, k: number, deg: number, height: number): void {
  const crouch = span(k, 0, 0.14), air = span(k, 0.14, 0.84), land = span(k, 0.84, 1);
  if (k < 0.14) { m.sy -= 0.14 * Math.sin(Math.PI * crouch); m.sx += 0.08 * Math.sin(Math.PI * crouch); }
  else if (k < 0.84) { m.y -= height * arc(air); m.sy += 0.08 * Math.sin(Math.PI * air); m.sx -= 0.05 * Math.sin(Math.PI * air); }
  else { const give = Math.sin(TAU * land) * (1 - 0.45 * land); m.sy -= 0.17 * give; m.sx += 0.11 * give; }
  m.rot += deg * easeInOutSine(air);
}

const DELIGHT_MOVES: Record<Delight, (m: MascotMotion, k: number) => void> = {
  spin: (m, k) => jump(m, k, 360, HOP * 1.4),
  flip: (m, k) => jump(m, k, -360, HOP * 1.7),
  bounce: (m, k) => { jump(m, Math.min(1, k / 0.55), 0, HOP * 1.8); if (k > 0.55) jump(m, (k - 0.55) / 0.45, 0, HOP); },
};

function moodMotion(mood: WorkingMood, t: number, m: MascotMotion): void {
  switch (mood) {
    case "thinking":
      breathe(m, t);
      m.rot += 5 * sideToSide(t, 5.2);
      break;
    case "searching":
      breathe(m, t, 0.6);
      m.x += 0.07 * sideToSide(t, 3.4);
      m.rot += 4 * sideToSide(t, 3.4);
      break;
    case "reading":
      breathe(m, t, 0.6);
      m.rot += 3 * Math.sin((TAU * t) / 2.8);
      break;
    case "browsing":
    case "running":
      hopCycle(m, t, PERIOD, HOP);
      m.rot += 2 * Math.sin((TAU * t) / (PERIOD * 4));
      break;
    case "writing":
    case "replying":
      hopCycle(m, t, PERIOD * 0.78, HOP * 0.6);
      m.rot += 3 * Math.sin((TAU * t) / (PERIOD * 1.56));
      break;
    case "waiting":
    case "done":
      breathe(m, t);
      m.rot += 2 * Math.sin((TAU * t) / 5);
      break;
    case "error":
      m.sy -= 0.09 - 0.012 * Math.sin((TAU * t) / 3.8);
      m.sx += 0.05;
      m.rot += -6 + 2 * Math.sin((TAU * t) / 4.6);
      break;
  }
}

function stepAt<T extends { ms: number }>(steps: readonly T[], t: number): T {
  let left = t;
  for (const step of steps) { if (left < step.ms) return step; left -= step.ms; }
  return steps[steps.length - 1]!;
}

function faceAt(mood: WorkingMood, ms: number): PixelState {
  const all = FACES[mood], once = all.filter((f) => f.once), loop = all.filter((f) => !f.once);
  const head = once.reduce((sum, f) => sum + f.ms, 0), cycle = loop.reduce((sum, f) => sum + f.ms, 0);
  return (ms < head ? stepAt(once, ms) : stepAt(loop, (ms - head) % cycle)).face;
}

function rngOf(seed: string): () => number {
  let a = 2166136261;
  for (let i = 0; i < seed.length; i++) a = Math.imul(a ^ seed.charCodeAt(i), 16777619);
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const REDUCED: Partial<Record<WorkingMood, Partial<MascotMotion>>> = { error: { sy: 0.92, sx: 1.04, rot: -6 } };
type Gap = Pick<MascotMotion, "x" | "y" | "sx" | "sy" | "rot">;

/** One mascot's motion as a function of time: feed it the mood as it changes and ask where it is at each moment, times
 * never going back. A step moves the body only once it has lasted SETTLE_MS (a reply, the end or a failure at once)
 * and then glides over BLEND_MS from wherever it was, even mid-spin; delights start DELIGHT_GAP_MS or more apart, never
 * the same kind twice running and never while it waits, fails or is done. Under reduced motion it holds one still pose
 * per mood. */
export class MascotDirector {
  readonly reducedMotion: boolean;
  private readonly rng: () => number;
  private readonly blinkEvery: number;
  private mood: WorkingMood = "thinking";
  private moodAt: number;
  private pending: { mood: WorkingMood; at: number } | null = null;
  private from: { at: number; gap: Gap } | null = null;
  private nextDelight: number;
  private delight: { kind: Delight; at: number } | null = null;
  private lastKind: Delight | null = null;
  /** every delight played, for tests and the lab */
  readonly played: Array<{ kind: Delight; at: number }> = [];

  constructor({ seed = "", reduced = false, at = 0 }: { seed?: string; reduced?: boolean; at?: number }) {
    this.reducedMotion = reduced;
    this.rng = rngOf(`flat|${seed}`);
    this.blinkEvery = 3400 + Math.floor(this.rng() * 1400);
    this.moodAt = at;
    this.nextDelight = at + this.gap();
  }

  private gap(): number {
    return DELIGHT_EVERY[0] + this.rng() * (DELIGHT_EVERY[1] - DELIGHT_EVERY[0]);
  }

  /** the mood the body is moving by now, which trails a step that has not settled yet */
  get shownMood(): WorkingMood {
    return this.mood;
  }

  setMood(mood: WorkingMood, at: number): void {
    if (mood === this.mood) { this.pending = null; return; }
    if (!AT_ONCE_MOODS.has(mood) && !this.reducedMotion) {
      if (this.pending?.mood !== mood) this.pending = { mood, at };
      return;
    }
    this.shift(mood, at);
  }

  private shift(mood: WorkingMood, at: number): void {
    this.pending = null;
    const was = this.reducedMotion ? null : this.motion(at);
    this.mood = mood;
    this.moodAt = at;
    if (this.delight && (!DELIGHT_MOODS.has(mood) || HOP_IN_MOODS.has(mood))) this.delight = null;
    if (!was) return;
    const next = this.live(at);
    this.from = { at, gap: { x: was.x - next.x, y: was.y - next.y, sx: was.sx - next.sx, sy: was.sy - next.sy, rot: wrap(was.rot - next.rot) } };
  }

  private live(at: number): MascotMotion {
    const mood = this.mood, ms = Math.max(0, at - this.moodAt), t = ms / 1000 / TEMPO;
    const m: MascotMotion = { ...REST, face: faceAt(mood, ms) };
    if (this.delight && at - this.delight.at >= DELIGHT_MS[this.delight.kind] * TEMPO) this.delight = null;
    if (!this.delight && at >= this.nextDelight && DELIGHT_MOODS.has(mood)) {
      const pool = DELIGHTS.filter((kind) => kind !== this.lastKind);
      const kind = pool[Math.floor(this.rng() * pool.length)]!;
      this.delight = { kind, at };
      this.lastKind = kind;
      this.played.push({ kind, at });
      this.nextDelight = at + this.gap();
    }
    moodMotion(mood, t, m);
    if (HOP_IN_MOODS.has(mood) && ms < HOP_IN_MS * TEMPO) jump(m, ms / (HOP_IN_MS * TEMPO), 0, HOP * 1.6);
    if (this.delight) {
      const k = (at - this.delight.at) / (DELIGHT_MS[this.delight.kind] * TEMPO), keep = 1 - Math.sin(Math.PI * k);
      Object.assign(m, { x: m.x * keep, y: m.y * keep, rot: m.rot * keep, sx: 1 + (m.sx - 1) * keep, sy: 1 + (m.sy - 1) * keep });
      DELIGHT_MOVES[this.delight.kind](m, k);
      m.face = "happy";
    }
    m.sx = 1 + (m.sx - 1) * GIVE;
    m.sy = 1 + (m.sy - 1) * GIVE;
    m.look = LOOKING_MOODS.has(mood) && !this.delight ? Math.sign(Math.round(m.x * 40) || Math.round(m.rot / 2)) : 0;
    m.blink = !this.delight && m.face !== "happy" && m.face !== "sad" && at % this.blinkEvery < (mood === "thinking" ? 200 : 120);
    return m;
  }

  motion(at: number): MascotMotion {
    if (this.reducedMotion) {
      const face = FACES[this.mood].find((f) => !f.once)!.face;
      return { ...REST, face, ...REDUCED[this.mood] };
    }
    if (this.pending && at - this.pending.at >= SETTLE_MS) this.shift(this.pending.mood, at);
    const now = this.live(at);
    const from = this.from;
    if (!from || at - from.at >= BLEND_MS) { this.from = null; return now; }
    const left = 1 - easeInOut(clamp01((at - from.at) / BLEND_MS)), gap = from.gap;
    return { ...now, x: now.x + gap.x * left, y: now.y + gap.y * left, sx: now.sx + gap.sx * left, sy: now.sy + gap.sy * left, rot: now.rot + gap.rot * left };
  }
}
