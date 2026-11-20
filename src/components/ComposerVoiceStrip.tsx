// What the chat bar shows while the person talks: a live waveform and one line of the words being said right now.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { DictationPhase, LevelSource } from "@/lib/use-composer-dictation";
import { previewText } from "@/lib/voice-input/preview";

const BAR = 2;
const GAP = 2;
const STEP = BAR + GAP;
/** A new bar enters this often; between bars the row glides by fractions of a step. */
const SAMPLE_MS = 60;

function motionReduced(): boolean {
  if (typeof window === "undefined") return false;
  return document.documentElement.dataset.reducedMotion === "true" || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

/** Bars scroll in from the right at the voice's loudness. With reduced motion they stand still and only their
 * strength follows the voice. Without a level from the recognizer, a low steady pulse says it is listening. */
export function VoiceWaveform({ levels, hasLevels, className }: { levels: LevelSource; hasLevels: boolean; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const reduced = motionReduced();
    let width = 0;
    let height = 0;
    let bars: number[] = [];
    let ink = "";
    const size = () => {
      ink = getComputedStyle(canvas).color;
      const ratio = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const count = Math.ceil(width / STEP) + 2;
      bars = bars.length >= count ? bars.slice(-count) : [...Array<number>(count - bars.length).fill(0), ...bars];
    };
    size();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(size);
    resize?.observe(canvas);

    let target = 0;
    let level = 0;
    const off = levels((next) => {
      target = Math.max(target, next);
    });
    const started = performance.now();
    let lastSample = started;
    let frame = 0;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (!hasLevels) target = 0.12 + 0.06 * Math.sin((now - started) / 260);
      // quick to rise, slower to fall, like a meter
      level += (target - level) * (target > level ? 0.55 : 0.18);
      target *= 0.82;
      if (now - lastSample >= SAMPLE_MS) {
        lastSample = now;
        bars.push(level);
        bars.shift();
      }
      context.clearRect(0, 0, width, height);
      context.fillStyle = ink;
      const glide = reduced ? 0 : Math.min(1, (now - lastSample) / SAMPLE_MS) * STEP;
      if (reduced) context.globalAlpha = 0.35 + 0.65 * Math.min(1, level * 1.4);
      for (let i = 0; i < bars.length; i += 1) {
        const value = reduced ? 0.3 + 0.12 * Math.sin(i * 1.7) : bars[i]!;
        const barHeight = Math.max(BAR, Math.min(height, value * height * 1.25));
        const x = width - (bars.length - i) * STEP + STEP - glide;
        if (x < -BAR || x > width) continue;
        const y = (height - barHeight) / 2;
        context.beginPath();
        if (context.roundRect) context.roundRect(x, y, BAR, barHeight, BAR / 2);
        else context.rect(x, y, BAR, barHeight);
        context.fill();
      }
      context.globalAlpha = 1;
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      off();
      resize?.disconnect();
    };
  }, [levels, hasLevels]);
  return <canvas ref={canvasRef} aria-hidden="true" data-voice-waveform="" className={cn("block h-5 text-ink/70", className)} />;
}

/** One line, its end always in view: older words slide off the left edge under a short fade. */
function PreviewLine({ phase, preview }: { phase: DictationPhase; preview: string }) {
  const lineRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  const shown = previewText(preview);
  // the text's own width, not scrollWidth: a line pinned to its end overflows to the left, which scrollWidth misses
  useLayoutEffect(() => {
    const line = lineRef.current, text = textRef.current;
    if (line && text) setOverflow(text.offsetWidth > line.clientWidth + 1);
  }, [shown]);
  const waiting = phase === "finishing" ? t("composer.voice.transcribing") : t("composer.placeholder.listening");
  return (
    <div
      ref={lineRef}
      data-voice-preview=""
      data-voice-heard={shown ? "" : undefined}
      className={cn(
        "flex min-w-0 flex-1 justify-end overflow-hidden whitespace-nowrap",
        (overflow || shown.startsWith("…")) && "[mask-image:linear-gradient(to_right,transparent,black_28px)]",
      )}
    >
      {/* justify-end only while it overflows, so a short line still starts at the left */}
      <span ref={textRef} className={cn("shrink-0", !overflow && "me-auto", shown ? "text-ink" : "text-ink/40")}>{shown || waiting}</span>
    </div>
  );
}

export function ComposerVoiceStrip({ phase, preview, levels, hasLevels, compact = false, className }: {
  phase: DictationPhase;
  preview: string;
  levels: LevelSource;
  hasLevels: boolean;
  /** The phone's narrower pill. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      data-composer-voice={phase}
      className={cn("composer-voice flex min-h-5 min-w-0 items-center gap-3 text-[14px] leading-5 tracking-[0.01em]", className)}
    >
      <VoiceWaveform levels={levels} hasLevels={hasLevels} className={compact ? "w-12 shrink-0" : "w-[88px] shrink-0"} />
      <PreviewLine phase={phase} preview={preview} />
      <span role="status" className="sr-only">{phase === "finishing" ? t("composer.voice.transcribing") : t("composer.placeholder.listening")}</span>
    </div>
  );
}
