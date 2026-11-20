/** One step of an envelope follower: rises with `attackMs`, falls with `releaseMs`, the same at any frame rate. */
export function followLevel(current: number, target: number, dtMs: number, attackMs = 40, releaseMs = 180): number {
  const tau = target > current ? attackMs : releaseMs;
  return current + (target - current) * (1 - Math.exp(-Math.max(0, dtMs) / tau));
}

/** Eases a value toward its target over roughly `ms`, frame-rate independent. */
export function ease(current: number, target: number, dtMs: number, ms: number): number {
  return current + (target - current) * (1 - Math.exp(-Math.max(0, dtMs) / ms));
}

/** Bar heights, centre out: the newest level sits in the middle and older ones travel outward, so the bars ripple from
 * the voice instead of jittering. `history[0]` is the newest. */
export function barTargets(history: ArrayLike<number>, bars: number, height: number, dot: number): number[] {
  const mid = (bars - 1) / 2;
  const out: number[] = [];
  for (let i = 0; i < bars; i += 1) {
    const away = Math.abs(i - mid);
    const level = history[Math.min(history.length - 1, Math.round(away))] ?? 0;
    const taper = 1 - (away / (mid + 1)) * 0.45;
    out.push(Math.max(dot, Math.min(height, dot + level * taper * (height - dot))));
  }
  return out;
}

/** Silence: the dots swell and settle in a slow wave, about one breath every 3.2 s. */
export function breath(index: number, timeMs: number, amount = 1.6): number {
  return amount * (0.5 + 0.5 * Math.sin((timeMs / 3200) * Math.PI * 2 - index * 0.32));
}

export type Rgb = [number, number, number, number];

export function parseRgb(css: string): Rgb {
  const m = /rgba?\(([^)]+)\)/.exec(css);
  if (!m) return [28, 27, 34, 1];
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
}

export function mixRgb(a: Rgb, b: Rgb, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const c = a.map((v, i) => v + (b[i]! - v) * k);
  return `rgba(${Math.round(c[0]!)}, ${Math.round(c[1]!)}, ${Math.round(c[2]!)}, ${c[3]!.toFixed(3)})`;
}
