import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MascotDirector } from "@/lib/mascot-motion";
import { mascotTicker } from "@/lib/mascot-ticker";
import type { WorkingMood } from "@/lib/working-mood";
import { spriteFace } from "@/pixel/sprite-face";

type Box = { width: number; height: number; left: number; top: number };

const clockNow = () => (typeof performance === "undefined" ? Date.now() : performance.now());
const useClientLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The working mascot's own flat sprite moving smoothly in 2D (MascotDirector) on the shared frame loop while it is on
 * screen; shifts land on whole device pixels so it stays crisp. `at` drives it from outside (the motion lab) instead of
 * the clock. */
export function LivelyMascot({ body, mood, seed, reduced, box, ink, eyeInk, at }: {
  body: string;
  mood: WorkingMood;
  seed: string;
  reduced: boolean;
  box: Box;
  ink: string;
  eyeInk: string;
  at?: number;
}) {
  const [director] = useState(() => ({ current: new MascotDirector({ seed, reduced, at: at ?? clockNow() }) }));
  if (director.current.reducedMotion !== reduced) director.current = new MascotDirector({ seed, reduced, at: at ?? clockNow() });
  director.current.setMood(mood, at ?? clockNow());
  const host = useRef<HTMLSpanElement>(null);
  const lift = useRef<HTMLSpanElement>(null);
  const tilt = useRef<HTMLSpanElement>(null);
  const paths = useRef<{ body: SVGPathElement | null; eyes: SVGPathElement | null }>({ body: null, eyes: null });
  const shown = useRef({ transform: "", rotate: "", sprite: "" });
  const first = spriteFace(body, "idle");

  const paint = useRef<(now: number) => void>(() => {});
  paint.current = (now: number) => {
    const m = director.current.motion(now);
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    const px = (v: number) => Math.round(v * dpr) / dpr;
    const transform = `translate(${px(m.x * box.width)}px, ${px(m.y * box.height)}px) scale(${r3(m.sx)}, ${r3(m.sy)})`;
    const rotate = `rotate(${r3(m.rot)}deg)`;
    const sprite = spriteFace(body, m.face, m.look, m.blink);
    const last = shown.current;
    if (transform !== last.transform && lift.current) lift.current.style.transform = last.transform = transform;
    if (rotate !== last.rotate && tilt.current) tilt.current.style.transform = last.rotate = rotate;
    if (sprite.key !== last.sprite) {
      last.sprite = sprite.key;
      paths.current.body?.setAttribute("d", sprite.body);
      paths.current.eyes?.setAttribute("d", sprite.eyes);
    }
  };

  useClientLayoutEffect(() => {
    shown.current = { transform: "", rotate: "", sprite: "" };
    paint.current(at ?? clockNow());
  });

  useEffect(() => {
    if (at !== undefined || reduced) return;
    let unsubscribe: (() => void) | null = null;
    const tick = (now: number) => paint.current(now);
    const start = () => { unsubscribe ??= mascotTicker.subscribe(tick); };
    const stop = () => { unsubscribe?.(); unsubscribe = null; };
    const el = host.current;
    if (typeof IntersectionObserver === "undefined" || !el) { start(); return stop; }
    const seen = new IntersectionObserver(([entry]) => (entry?.isIntersecting ? start() : stop()));
    seen.observe(el);
    return () => { seen.disconnect(); stop(); };
  }, [at, reduced]);

  return (
    <span ref={host} className="absolute" style={box}>
      <span ref={lift} className="absolute inset-0" style={{ transformOrigin: "50% 100%" }}>
        <span ref={tilt} className="absolute inset-0" style={{ transformOrigin: "50% 55%" }}>
          <svg width={box.width} height={box.height} viewBox={`0 0 ${first.G} ${first.G}`} shapeRendering="crispEdges" overflow="visible" className="absolute inset-0">
            <path ref={(el) => { paths.current.body = el; }} d={first.body} fill={ink} />
            <path ref={(el) => { paths.current.eyes = el; }} d={first.eyes} fill={eyeInk} />
          </svg>
        </span>
      </span>
    </span>
  );
}
