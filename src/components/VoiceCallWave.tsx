import { useEffect, useRef } from "react";
import { barTargets, breath, ease, followLevel, mixRgb, parseRgb } from "@/lib/voice-call/meter";

const BAR_W = 3;
const GAP = 2.5;
const DOT = 3;
/** A level is kept every this many ms, so a sound takes about half a second to ripple to the ends. */
const HISTORY_STEP_MS = 36;

export type WaveSource = () => { level: number; who: "bot" | "person" | "none" };

/** What the call's other moving parts read each frame: the smoothed level and who it belongs to (0 person, 1 bot). */
export interface WaveFrame {
  level: number;
  bot: number;
  person: number;
}

/** Bars that ripple out from whoever is talking, in their colour, and breathe as dots in silence. Drawn on a canvas
 * each frame from an envelope follower (40 ms attack, 180 ms release), so nothing in React re-renders at 60 fps. */
export function VoiceCallWave({ source, bars = 26, height = 30, botColor, onFrame, className }: {
  source: WaveSource;
  bars?: number;
  height?: number;
  /** CSS colour of the bot's voice; the person's voice is ink. */
  botColor: string;
  onFrame?: (frame: WaveFrame) => void;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const read = useRef(source);
  read.current = source;
  const report = useRef(onFrame);
  report.current = onFrame;
  const width = bars * BAR_W + (bars - 1) * GAP;

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const ratio = Math.max(1, globalThis.devicePixelRatio || 1);
    el.width = Math.round(width * ratio);
    el.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const style = getComputedStyle(el);
    const botRgb = parseRgb(style.color);
    const personRgb = parseRgb(getComputedStyle(el.parentElement ?? el).color);
    const idleRgb: typeof personRgb = [personRgb[0], personRgb[1], personRgb[2], personRgb[3] * 0.32];
    const history = new Float32Array(Math.ceil(bars / 2) + 1);
    const heights = new Float32Array(bars).fill(DOT);
    let level = 0;
    let botMix = 0;
    let voiced = 0;
    let sinceStep = 0;
    let last = performance.now();
    let frame = 0;
    const draw = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      const { level: raw, who } = read.current();
      level = followLevel(level, Math.min(1, raw), dt);
      if (who !== "none") botMix = ease(botMix, who === "bot" ? 1 : 0, dt, 110);
      voiced = ease(voiced, level > 0.03 ? 1 : 0, dt, 140);
      sinceStep += dt;
      while (sinceStep >= HISTORY_STEP_MS) {
        sinceStep -= HISTORY_STEP_MS;
        history.copyWithin(1, 0, history.length - 1);
      }
      history[0] = level;
      const targets = barTargets(history, bars, height, DOT);
      ctx.clearRect(0, 0, width, height);
      const voiceColor = mixRgb(personRgb, botRgb, botMix);
      ctx.fillStyle = voiced < 0.5 ? mixRgb(idleRgb, parseRgb(voiceColor), voiced * 2) : voiceColor;
      for (let i = 0; i < bars; i += 1) {
        const rest = DOT + (reduced ? 0 : breath(i, now) * (1 - voiced));
        const target = Math.max(rest, targets[i]!);
        heights[i] = reduced ? target : ease(heights[i]!, target, dt, 55);
        const h = heights[i]!;
        ctx.beginPath();
        ctx.roundRect(i * (BAR_W + GAP), (height - h) / 2, BAR_W, h, BAR_W / 2);
        ctx.fill();
      }
      report.current?.({ level, bot: botMix * voiced, person: (1 - botMix) * voiced });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [bars, height, width, botColor]);

  return <canvas ref={canvas} aria-hidden="true" className={className} style={{ width, height, color: botColor }} />;
}
