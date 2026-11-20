export type MotionPick = "a" | "b" | "c";

export type MotionSpeed = {
  pick: MotionPick;
  /** every duration is this many times its own */
  scale: number;
  /** extra damping on top of the slower spring; above 1 no spring goes past its rest */
  damping: number;
  /** the entering curve every ease-out takes; null keeps each place's own */
  easeOut: readonly [number, number, number, number] | null;
  /** the curve a morph on screen (a slot collapsing) takes; null keeps each place's own */
  easeInOut: readonly [number, number, number, number] | null;
};

export const MOTION_SPEEDS: Record<MotionPick, MotionSpeed> = {
  a: { pick: "a", scale: 1, damping: 1, easeOut: null, easeInOut: null },
  b: { pick: "b", scale: 1.4, damping: 1.08, easeOut: [0.25, 0.85, 0.3, 1], easeInOut: [0.45, 0.05, 0.25, 1] },
  c: { pick: "c", scale: 1.8, damping: 1.15, easeOut: [0.3, 0.8, 0.25, 1], easeInOut: [0.4, 0.05, 0.2, 1] },
};

export const MOTION: MotionSpeed = MOTION_SPEEDS.b;

type Bezier = readonly [number, number, number, number];
type Spring = { stiffness: number; damping: number; mass?: number };

export function pacedMs(ms: number, speed: MotionSpeed = MOTION): number {
  return Math.round(ms * speed.scale);
}

export function pacedSeconds(seconds: number, speed: MotionSpeed = MOTION): number {
  return speed.scale === 1 ? seconds : Math.round(seconds * speed.scale * 1000) / 1000;
}

/** The same spring played `scale` times slower at the same damping ratio, then damped by `damping`, never past critical
 * once softened. */
export function pacedSpring<T extends Spring>(spring: T, speed: MotionSpeed = MOTION): T {
  if (speed.scale === 1 && speed.damping === 1) return spring;
  const mass = spring.mass ?? 1;
  const stiffness = spring.stiffness / (speed.scale * speed.scale);
  const critical = 2 * Math.sqrt(stiffness * mass);
  return { ...spring, stiffness: Math.round(stiffness * 100) / 100, damping: Math.round(Math.max(critical, (spring.damping / speed.scale) * speed.damping) * 100) / 100 };
}

export function pacedOut<T extends Bezier>(own: T, speed: MotionSpeed = MOTION): Bezier {
  return speed.easeOut ?? own;
}

export function pacedInOut<T extends Bezier>(own: T, speed: MotionSpeed = MOTION): Bezier {
  return speed.easeInOut ?? own;
}

export const cssBezier = (curve: Bezier): string => `cubic-bezier(${curve.join(", ")})`;

/** The CSS custom properties a pick sets on the root: the stylesheets read --motion-scale for durations and
 * --motion-ease-out / --motion-ease-in-out ahead of their own curves. */
export function motionCssVars(speed: MotionSpeed = MOTION): Record<string, string> {
  const vars: Record<string, string> = { "--motion-scale": String(speed.scale) };
  if (speed.easeOut) vars["--motion-ease-out"] = cssBezier(speed.easeOut);
  if (speed.easeInOut) vars["--motion-ease-in-out"] = cssBezier(speed.easeInOut);
  return vars;
}

export function applyMotionSpeed(root: HTMLElement, speed: MotionSpeed = MOTION): void {
  if (speed.pick === "a") return;
  for (const [name, value] of Object.entries(motionCssVars(speed))) root.style.setProperty(name, value);
}

export interface SpringTiming { duration: number; easing: string }

/** A spring from rest at 0 to rest at 1 (mass 1) as a WAAPI duration and linear() easing, so it runs off the main thread
 * and a glide cut short can be read back from the computed transform. */
export function springTiming(stiffness: number, damping: number): SpringTiming {
  const w = Math.sqrt(stiffness);
  const z = Math.min(1, damping / (2 * w));
  const wd = w * Math.sqrt(1 - z * z);
  const at = (t: number) => z >= 1 ? 1 - (1 + w * t) * Math.exp(-w * t)
    : 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
  const envelope = (t: number) => z >= 1 ? (1 + w * t) * Math.exp(-w * t) : Math.exp(-z * w * t) / Math.sqrt(1 - z * z);
  let end = 0.05;
  while (envelope(end) > 0.001 && end < 2) end += 0.005;
  const steps = 48;
  const points = Array.from({ length: steps + 1 }, (_, i) => i === steps ? "1" : String(Math.round(at((end * i) / steps) * 10000) / 10000));
  return { duration: Math.round(end * 1000), easing: `linear(${points.join(", ")})` };
}
