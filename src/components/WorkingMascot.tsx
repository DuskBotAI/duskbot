import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { MASCOT_INK, type MausColor } from "@/lib/mascot";
import { useHalloweenDressed, wornBody } from "@/lib/halloween-dress";
import { stillSvgPaths, type PixelState } from "@/pixel/engine";
import type { WorkingMood } from "@/lib/working-mood";
import { bodyShapeFor, type StoredBodyId } from "../../shared/bot-body";
import { mascotFaceInk, type MascotFaceColor } from "../../shared/bot-avatar";
import { bodyFit } from "./mascot-view";
import { usePrefersReducedMotion } from "./mascot-clock";
import { LivelyMascot } from "./LivelyMascot";
import { MASCOT_MOTION, type MascotMotionPick } from "@/lib/mascot-motion";

type WorkingBot = { id?: string; color: MausColor; mascotBody?: StoredBodyId | null; mascotFaceColor?: MascotFaceColor | null };

/** One look of the working mascot: the sprite's eyes for `state`, mirrored when `flip`, held `ms`. A `once` look plays
 * only when the mood begins. */
export type Face = { state: PixelState; flip?: boolean; ms: number; once?: boolean };

/** The faces each mood runs through, in order and on a loop. */
export const MOOD_FACES: Record<WorkingMood, readonly Face[]> = {
  thinking: [{ state: "thinking", ms: 2800 }, { state: "thinking", flip: true, ms: 2400 }, { state: "confused", ms: 2000 }],
  reading: [{ state: "working", ms: 3000 }],
  writing: [{ state: "working", ms: 3000 }],
  replying: [{ state: "happy", ms: 2000, once: true }, { state: "working", ms: 3000 }],
  running: [{ state: "working", ms: 3200 }, { state: "listening", ms: 2000 }],
  searching: [{ state: "searching", ms: 2400 }, { state: "listening", ms: 2000 }, { state: "searching", flip: true, ms: 2400 }, { state: "listening", ms: 2000 }],
  browsing: [{ state: "listening", ms: 2800 }, { state: "searching", ms: 2000 }, { state: "listening", ms: 2400 }, { state: "searching", flip: true, ms: 2000 }],
  waiting: [{ state: "idle", ms: 3000 }, { state: "confused", ms: 2000 }],
  error: [{ state: "sad", ms: 4000 }],
  done: [{ state: "happy", ms: 4000 }],
};

/** Moods that start with a beat played once (a flinch, a hop), so their layer takes no spread-out start. */
const ONCE = new Set<WorkingMood>(["error", "done", "replying"]);

type Shape = { G: number; body: string; eyes: string; eyeMiddle: number };
const shapes = new Map<string, Shape>();

const eyeRuns = (eyes: string) => [...eyes.matchAll(/M(-?\d+) (-?\d+)h(\d+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]) }));

function shapeOf(body: string, state?: PixelState, flip = false): Shape {
  const id = `${body}|${state ?? ""}|${flip ? "flip" : ""}`;
  const known = shapes.get(id);
  if (known) return known;
  const { G, body: silhouette, eyes } = stillSvgPaths(body, { scale: 1, state });
  const runs = eyeRuns(eyes);
  const rows = runs.map((run) => run.y);
  const eyeMiddle = rows.length ? (Math.min(...rows) + Math.max(...rows) + 1) / 2 / G : 0.6;
  // the other way round: mirrored across the resting eyes' own middle, so a sideways look turns to the other side
  const rest = eyeRuns(stillSvgPaths(body, { scale: 1 }).eyes);
  const axis = rest.length ? Math.min(...rest.map((r) => r.x)) + Math.max(...rest.map((r) => r.x + r.w)) : G;
  const drawn = flip ? runs.map((r) => `M${axis - r.x - r.w} ${r.y}h${r.w}v1h${-r.w}z`).join("") : eyes;
  const shape = { G, body: silhouette, eyes: drawn, eyeMiddle };
  shapes.set(id, shape);
  return shape;
}

function hashOf(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return h >>> 0;
}

const spread = (seed: string, periodMs: number) => `-${hashOf(seed) % periodMs}ms`;

/** Which of a mood's faces shows now: it steps through them on their own times, the `once` faces only at the mood's
 * start; under reduced motion it holds the mood's first looping face. */
export function useMoodFace(mood: WorkingMood | undefined, reduced: boolean): Face | undefined {
  const faces = mood ? MOOD_FACES[mood] : undefined;
  const loopStart = faces ? Math.max(0, faces.findIndex((face) => !face.once)) : 0;
  const [at, setAt] = useState({ mood, index: 0 });
  const index = at.mood === mood ? at.index : 0;
  if (at.mood !== mood) setAt({ mood, index: 0 });
  const shown = reduced ? loopStart : index;
  useEffect(() => {
    if (!faces || reduced || faces.length < 2) return;
    const timer = setTimeout(() => setAt({ mood, index: index + 1 < faces.length ? index + 1 : loopStart }), faces[index]!.ms);
    return () => clearTimeout(timer);
  }, [faces, mood, index, loopStart, reduced]);
  return faces?.[shown];
}

/** The sprite's drawn size nearest `wanted` at which each of its `grid` pixels covers a whole number of screen pixels. */
export function crispSize(wanted: number, grid: number, dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1): number {
  const ratio = Math.max(1, Math.round(dpr));
  return (Math.max(1, Math.round((wanted / grid) * ratio)) * grid) / ratio;
}

/** The bot's own pixel mascot at work, small enough to sit before a word: it bobs, blinks and glances side to side.
 * Each part moves on its own HTML layer by transform alone, so the loop stays on the compositor. A `mood` (what the bot
 * is doing now) gives it the sprite's own expressions in turn (MOOD_FACES) and sets how those layers move, in whole
 * sprite pixels. */
export function WorkingMascot({ bot, size, eyes, seed = "", mood, className, motion = MASCOT_MOTION, at }: {
  bot: WorkingBot;
  size: number;
  eyes?: string;
  seed?: string;
  mood?: WorkingMood;
  className?: string;
  /** "current" moves by the CSS loops; "flat-gentle" moves it smoothly while it has a mood */
  motion?: MascotMotionPick;
  /** the lab's own clock for "flat-gentle", in ms */
  at?: number;
}) {
  const dressed = useHalloweenDressed();
  const reduced = usePrefersReducedMotion() || (typeof document !== "undefined" && document.documentElement.dataset.reducedMotion === "true");
  const body = bodyShapeFor(wornBody(bot.mascotBody, bot.color, dressed));
  const face = useMoodFace(mood, reduced);
  const shape = useMemo(() => shapeOf(body, face?.state, face?.flip), [body, face?.state, face?.flip]);
  const fit = bodyFit(body);
  const drawn = crispSize(size * fit.scale, shape.G);
  const box = { width: drawn, height: drawn, left: Math.round((size - drawn) / 2 + fit.x * size), top: Math.round((size - drawn) / 2 + fit.y * size) };
  const view = `0 0 ${shape.G} ${shape.G}`;
  const key = `${bot.id ?? ""}|${seed}`;
  const ink = MASCOT_INK[bot.color] ?? MASCOT_INK.green;
  const eyeInk = mascotFaceInk(bot.mascotFaceColor) ?? eyes ?? "var(--color-app)";
  if (mood && motion !== "current") {
    return (
      <span aria-hidden="true" data-working-mascot="" data-motion={motion} data-mood={mood} className={cn("relative inline-block shrink-0", className)} style={{ width: size, height: size }}>
        <LivelyMascot body={body} mood={mood} seed={key} reduced={reduced} box={box} ink={ink} eyeInk={eyeInk} at={at} />
      </span>
    );
  }
  return (
    <span aria-hidden="true" data-working-mascot="" data-mood={mood} data-face={face ? `${face.state}${face.flip ? "-flip" : ""}` : undefined} className={cn("relative inline-block shrink-0", className)} style={{ width: size, height: size }}>
      <span className="working-mascot-bob absolute" style={{ ...box, animationDelay: mood && ONCE.has(mood) ? undefined : spread(`${key}|bob`, 1400) }}>
        <svg width={drawn} height={drawn} viewBox={view} shapeRendering="crispEdges" overflow="visible" className="absolute inset-0">
          <path d={shape.body} fill={ink} />
        </svg>
        <span className="working-mascot-glance absolute inset-0" style={{ animationDelay: spread(`${key}|glance`, 5200) }}>
          <span className="working-mascot-blink absolute inset-0" style={{ transformOrigin: `50% ${shape.eyeMiddle * 100}%`, animationDelay: spread(`${key}|blink`, 3800) }}>
            <svg width={drawn} height={drawn} viewBox={view} shapeRendering="crispEdges" overflow="visible" className="absolute inset-0">
              <path d={shape.eyes} fill={eyeInk} />
            </svg>
          </span>
        </span>
      </span>
    </span>
  );
}
