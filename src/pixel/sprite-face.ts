import { stillFrame, type PixelState } from "./engine";

export const BODY = 1, EYE = 2;

/** A body's still sprite wearing a face: `paint` is W by H (0 empty, 1 body, 2 eye) with the G by G body box at
 * (px, pt); `body` and `eyes` are svg path data in that box's own units. */
export type SpriteFace = { G: number; W: number; H: number; px: number; pt: number; paint: Uint8Array; body: string; eyes: string; key: string };

type Base = { paint: Uint8Array; eyeAxis: number; side: number };
const bases = new Map<string, Base>();

function eyeSpan(paint: Uint8Array, W: number): [number, number] {
  let lo = W, hi = -1;
  for (let i = 0; i < paint.length; i++) if (paint[i] === EYE) { const x = i % W; if (x < lo) lo = x; if (x > hi) hi = x; }
  return [lo, hi];
}

function baseOf(body: string, face: PixelState): Base & ReturnType<typeof stillFrame> {
  const frame = stillFrame(body, { scale: 1, state: face });
  const id = `${body}|${face}`;
  let base = bases.get(id);
  if (!base) {
    const [lo, hi] = eyeSpan(stillFrame(body, { scale: 1 }).paint, frame.W);
    const eyeAxis = hi >= 0 ? lo + hi : frame.W - 1;
    const [flo, fhi] = eyeSpan(frame.paint, frame.W);
    base = { paint: frame.paint, eyeAxis, side: fhi >= 0 ? Math.sign(flo + fhi - eyeAxis) : 0 };
    bases.set(id, base);
  }
  return { ...frame, ...base };
}

function runs(paint: Uint8Array, W: number, H: number, test: (v: number) => boolean, ox: number, oy: number): string {
  let d = "";
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!test(paint[y * W + x]!)) continue;
    let e = x;
    while (e + 1 < W && test(paint[y * W + e + 1]!)) e++;
    d += `M${x - ox} ${y - oy}h${e - x + 1}v1h${-(e - x + 1)}z`;
    x = e;
  }
  return d;
}

const faces = new Map<string, SpriteFace>();

/** The sprite with `face`'s eyes, its sideways look turned to `look` (-1 or 1; 0 keeps the face's own), or shut. */
export function spriteFace(body: string, face: PixelState, look = 0, blink = false): SpriteFace {
  const key = `${body}|${face}|${look}|${+blink}`;
  const known = faces.get(key);
  if (known) return known;
  const base = baseOf(body, face);
  const { W, H, G, px, pt } = base;
  const paint = new Uint8Array(base.paint.length);
  for (let i = 0; i < paint.length; i++) paint[i] = base.paint[i] ? BODY : 0;
  const source = blink ? baseOf(body, "sleeping").paint : base.paint;
  const flip = !blink && look !== 0 && base.side !== 0 && base.side !== look;
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== EYE) continue;
    const x = i % W, y = (i / W) | 0, mx = flip ? base.eyeAxis - x : x;
    if (mx >= 0 && mx < W && paint[y * W + mx]) paint[y * W + mx] = EYE;
  }
  const sprite = { G, W, H, px, pt, paint, key, body: runs(paint, W, H, (v) => v !== 0, px, pt), eyes: runs(paint, W, H, (v) => v === EYE, px, pt) };
  if (faces.size > 400) faces.clear();
  faces.set(key, sprite);
  return sprite;
}
