import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue, useTransform, type AnimationPlaybackControls, type MotionValue } from "motion/react";
import { ImageOff, LoaderCircle, RotateCcw, Share, X } from "../../icons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { PhoneBridge, PhoneImage } from "@/lib/phone-bridge";
import { haptic } from "../haptics";
import { dur, ease, prefersReducedMotion, velocityTracker } from "../motion";
import { frameOf } from "../native-glass";
import { PlatformContext } from "../platform";
import { closesOnBack } from "../Sheet";
import { ViewerNote } from "./ViewerNote";
import { clampPan, dismisses, doubleTapZoom, dragAxis, elasticPan, fitted, MAX_ZOOM, panLimit, pageStep, pinchTo, type Point, type Size } from "./image-gesture";

const SLOP = 8;
const DOUBLE_TAP_MS = 280;
const SPRING = { type: "spring", stiffness: 420, damping: 40 } as const;

type Gesture =
  | { kind: "pending"; start: Point; at: number }
  | { kind: "page"; start: Point }
  | { kind: "dismiss"; start: Point }
  | { kind: "pan"; start: Point; from: Point }
  | { kind: "pinch"; scale: number; pan: Point; focus: Point; distance: number };

function Slide({ image, index, width, scale, panX, panY, current, neighbours, onNatural }: {
  image: PhoneImage; index: number; width: number; current: boolean;
  scale: MotionValue<number>; panX: MotionValue<number>; panY: MotionValue<number>;
  neighbours: MotionValue<number>;
  onNatural: (size: Size) => void;
}) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  const transform = useTransform(() => `translate3d(${panX.get()}px, ${panY.get()}px, 0) scale(${scale.get()})`);
  return (
    <motion.div className="absolute inset-y-0 flex items-center justify-center" style={{ left: index * width, width, opacity: current ? 1 : neighbours }} aria-hidden={!current}>
      {state === "loading" && <span role="status" aria-label={t("attach.loadingImage")} className="absolute inset-0 flex items-center justify-center text-[rgb(245_245_245/0.6)]">
        <LoaderCircle size={24} className="animate-spin" aria-hidden="true" />
      </span>}
      {state === "failed" ? (
        <div role="alert" className="flex flex-col items-center gap-3 px-8 text-center text-[rgb(245_245_245/0.72)]">
          <ImageOff size={30} aria-hidden="true" />
          <span className="text-[15px]">{t("mobile.image.failed")}</span>
          <button type="button" data-viewer-retry="" onClick={() => { setState("loading"); setAttempt((n) => n + 1); }}
            className="flex min-h-11 items-center gap-2 rounded-full bg-[rgb(245_245_245/0.14)] px-5 text-[15px] font-medium text-[rgb(245_245_245)]">
            <RotateCcw size={16} aria-hidden="true" />{t("chat.retry")}
          </button>
        </div>
      ) : (
        <motion.img key={`${image.src}:${attempt}`} src={image.src} alt={image.name} draggable={false}
          onLoad={(event) => { const el = event.currentTarget; if (el.naturalWidth) onNatural({ w: el.naturalWidth, h: el.naturalHeight }); setState("ready"); }}
          onError={() => setState("failed")}
          style={current ? { transform } : undefined}
          className={cn("block max-h-full max-w-full select-none object-contain [-webkit-touch-callout:none] transition-opacity duration-150", state === "ready" ? "opacity-100" : "opacity-0")} />
      )}
    </motion.div>
  );
}

/** Pictures full screen, as Photos shows them: pinch or double tap to zoom, drag a zoomed picture around, swipe sideways
 * between a message's pictures, and pull one up or down to put it back, the page fading in behind as it follows the
 * finger. A tap hides and shows the controls. */
export function ImageViewer({ images, initialIndex, bridge, onClose }: { images: PhoneImage[]; initialIndex: number; bridge: PhoneBridge; onClose: () => void }) {
  const [index, setIndex] = useState(() => Math.max(0, Math.min(images.length - 1, initialIndex)));
  const [chrome, setChrome] = useState(true);
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null);
  const [sharing, setSharing] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Size>(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const naturals = useRef(new Map<number, Size>());
  const reduced = prefersReducedMotion();

  const track = useMotionValue(-index * stage.w);
  const scale = useMotionValue(1);
  const panX = useMotionValue(0);
  const panY = useMotionValue(0);
  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);
  const shown = useMotionValue(0);
  const backdrop = useTransform(() => shown.get() * Math.max(0, 1 - Math.abs(dragY.get()) / (stage.h * 0.55)));
  const lift = useTransform(() => {
    const pulled = Math.min(1, Math.abs(dragY.get()) / stage.h);
    const enter = reduced ? 1 : 0.94 + 0.06 * shown.get();
    return `translate3d(${dragX.get()}px, ${dragY.get()}px, 0) scale(${enter * (1 - pulled * 0.3)})`;
  });
  const trackTransform = useTransform(() => `translate3d(${track.get()}px, 0, 0)`);
  const neighbours = useTransform(dragY, (y) => Math.max(0, 1 - Math.abs(y) / 24));
  const runs = useRef<AnimationPlaybackControls[]>([]);
  const stopAll = () => { for (const run of runs.current) run.stop(); runs.current = []; };
  const to = (value: MotionValue<number>, target: number, options: Parameters<typeof animate>[2] = SPRING) => {
    const run = animate(value, target, reduced ? { duration: dur.fast, ease: ease.out } : options as never);
    runs.current.push(run);
    return run;
  };

  const closing = useRef(false);
  const close = useCallback((velocity = 0) => {
    if (closing.current) return;
    closing.current = true;
    setChrome(false);
    const away = dragY.get() !== 0 ? Math.sign(dragY.get()) * stage.h : 0;
    if (away && !reduced) animate(dragY, away, { type: "spring", stiffness: 300, damping: 36, velocity });
    animate(shown, 0, { duration: reduced ? dur.fast : dur.base, ease: ease.out, onComplete: onClose });
  }, [dragY, shown, stage.h, reduced, onClose]);
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    animate(shown, 1, { duration: reduced ? dur.fast : dur.base, ease: ease.out });
    dialogRef.current?.focus({ preventScroll: true });
    const back = closesOnBack(() => closeRef.current());
    const onResize = () => setStage({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => { back(); window.removeEventListener("resize", onResize); };
  }, []);
  useLayoutEffect(() => { track.set(-index * stage.w); }, [stage.w]);

  const picture = () => fitted(naturals.current.get(index) ?? stage, stage);
  const resetZoom = () => { to(scale, 1); to(panX, 0); to(panY, 0); };
  const go = useCallback((step: -1 | 0 | 1, velocity = 0) => {
    const next = Math.max(0, Math.min(images.length - 1, index + step));
    if (next !== index) { haptic("pick"); scale.set(1); panX.set(0); panY.set(0); }
    to(track, -next * stage.w, { type: "spring", stiffness: 380, damping: 40, velocity });
    if (next !== index) setIndex(next);
  }, [index, images.length, stage.w]);

  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const tracker = useRef(velocityTracker());
  const lastTap = useRef<{ at: number; point: Point } | null>(null);
  const tapTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(tapTimer.current), []);

  const fromCentre = (point: Point): Point => {
    const box = stageRef.current!.getBoundingClientRect();
    return { x: point.x - box.left - box.width / 2, y: point.y - box.top - box.height / 2 };
  };
  const pinchStart = (): Gesture => {
    const [a, b] = [...pointers.current.values()];
    return { kind: "pinch", scale: scale.get(), pan: { x: panX.get(), y: panY.get() }, focus: fromCentre({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), distance: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  };

  const onDown = (event: React.PointerEvent) => {
    if (closing.current || (event.target as Element).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    stopAll();
    if (pointers.current.size === 2) gesture.current = pinchStart();
    else if (pointers.current.size === 1) {
      gesture.current = { kind: "pending", start: { x: event.clientX, y: event.clientY }, at: performance.now() };
      tracker.current.reset(event.clientX, event.clientY);
    }
  };

  const onMove = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    tracker.current.push(event.clientX, event.clientY);
    const now = gesture.current;
    if (!now) return;
    if (now.kind === "pinch") {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const next = pinchTo(now, fromCentre({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), Math.hypot(a.x - b.x, a.y - b.y) / now.distance);
      scale.set(next.scale);
      panX.set(next.pan.x);
      panY.set(next.pan.y);
      return;
    }
    const dx = event.clientX - now.start.x, dy = event.clientY - now.start.y;
    if (now.kind === "pending") {
      if (Math.hypot(dx, dy) < SLOP) return;
      const next: Gesture = scale.get() > 1.01 ? { kind: "pan", start: now.start, from: { x: panX.get(), y: panY.get() } }
        : { kind: dragAxis(dx, dy, images.length), start: now.start };
      gesture.current = next;
      if (next.kind === "dismiss") setChrome(false);
      return onMove(event);
    }
    if (now.kind === "pan") {
      const next = elasticPan({ x: now.from.x + dx, y: now.from.y + dy }, panLimit(picture(), stage, scale.get()));
      panX.set(next.x);
      panY.set(next.y);
    } else if (now.kind === "page") {
      const edge = (index === 0 && dx > 0) || (index === images.length - 1 && dx < 0);
      track.set(-index * stage.w + (edge ? rubber(dx) : dx));
    } else {
      dragX.set(dx * 0.6);
      dragY.set(dy);
    }
  };

  const onUp = (event: React.PointerEvent) => {
    if (!pointers.current.delete(event.pointerId)) return;
    const now = gesture.current;
    const velocity = tracker.current.velocity();
    if (now?.kind === "pinch") {
      if (pointers.current.size === 1) {
        const [rest] = [...pointers.current.values()];
        gesture.current = { kind: "pan", start: rest, from: { x: panX.get(), y: panY.get() } };
        tracker.current.reset(rest.x, rest.y);
      } else gesture.current = null;
      settleZoom();
      return;
    }
    if (pointers.current.size > 0) return;
    gesture.current = null;
    if (!now) return;
    if (now.kind === "pending") return tap({ x: event.clientX, y: event.clientY }, now.at);
    if (now.kind === "pan") {
      const limit = panLimit(picture(), stage, scale.get());
      const rest = clampPan({ x: panX.get() + velocity.x * 0.18, y: panY.get() + velocity.y * 0.18 }, limit);
      to(panX, rest.x, { ...SPRING, velocity: velocity.x });
      to(panY, rest.y, { ...SPRING, velocity: velocity.y });
    } else if (now.kind === "page") {
      go(pageStep(event.clientX - now.start.x, velocity.x, stage.w), velocity.x);
    } else if (dismisses(dragY.get(), velocity.y)) {
      close(velocity.y);
    } else {
      setChrome(true);
      to(dragX, 0);
      to(dragY, 0, { ...SPRING, velocity: velocity.y });
    }
  };

  const settleZoom = () => {
    const target = Math.max(1, Math.min(MAX_ZOOM, scale.get()));
    if (target === 1) return resetZoom();
    const ratio = target / scale.get();
    const pan = clampPan({ x: panX.get() * ratio, y: panY.get() * ratio }, panLimit(picture(), stage, target));
    to(scale, target);
    to(panX, pan.x);
    to(panY, pan.y);
  };

  const tap = (point: Point, at: number) => {
    if (performance.now() - at > 350) return;
    const previous = lastTap.current;
    if (previous && at - previous.at < DOUBLE_TAP_MS && Math.hypot(point.x - previous.point.x, point.y - previous.point.y) < 40) {
      window.clearTimeout(tapTimer.current);
      lastTap.current = null;
      const next = doubleTapZoom(scale.get(), fromCentre(point), picture(), stage);
      haptic("tap");
      to(scale, next.scale);
      to(panX, next.pan.x);
      to(panY, next.pan.y);
      return;
    }
    lastTap.current = { at, point };
    window.clearTimeout(tapTimer.current);
    tapTimer.current = window.setTimeout(() => setChrome((on) => !on), DOUBLE_TAP_MS);
  };

  const glass = useContext(PlatformContext)?.glass;
  const nativeViewer = Boolean(glass?.viewer);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const shareBtnRef = useRef<HTMLButtonElement>(null);
  const shareRef = useRef<() => Promise<void>>(async () => {});
  const current = images[index]!;
  const share = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      if (bridge.shareFile) {
        const response = await fetch(current.src);
        if (!response.ok) throw new Error(String(response.status));
        const blob = await response.blob();
        await bridge.shareFile(new File([blob], current.name || "picture", { type: blob.type || "image/png" }));
      } else if (current.openUrl && bridge.share) {
        await bridge.share({ url: current.openUrl });
      }
    } catch {
      haptic("error");
      setNote({ text: t("mobile.image.shareFailed"), failed: true });
      window.setTimeout(() => setNote(null), 2200);
    } finally {
      setSharing(false);
    }
  };
  shareRef.current = share;
  const canShare = Boolean(bridge.shareFile || (current.openUrl && bridge.share));
  const countText = images.length > 1 ? t("mobile.image.count", { index: index + 1, count: images.length }) : null;

  useEffect(() => {
    if (!glass?.viewer) return;
    const sync = () => {
      const closeEl = closeBtnRef.current;
      if (!closeEl) return;
      const closeRect = frameOf(closeEl);
      if (closeRect.w <= 0 || closeRect.h <= 0) return;
      const shareEl = canShare ? shareBtnRef.current : null;
      const shareRect = shareEl ? frameOf(shareEl) : null;
      glass.viewer!({
        visible: chrome,
        close: closeRect,
        closeLabel: t("attach.close"),
        share: shareRect && shareRect.w > 0 && shareRect.h > 0 ? shareRect : null,
        shareLabel: t("mobile.image.share", { name: current.name }),
        sharing,
        countText,
        countY: closeRect.y + closeRect.h / 2,
      });
    };
    sync();
    const frame = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(frame);
  }, [glass, chrome, canShare, sharing, countText, current.name, stage.w, stage.h]);

  useEffect(() => {
    if (!glass?.viewer) return;
    const stop = glass.onEvent((event) => {
      if (event.type !== "viewerTap") return;
      if (event.target === "close") closeRef.current();
      else if (event.target === "share") void shareRef.current();
    });
    return () => {
      stop();
      glass.viewer!(null);
    };
  }, [glass]);

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={t("attach.previewAria", { name: current.name })} tabIndex={-1} data-image-viewer=""
      className="fixed inset-0 z-[60] outline-none"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); close(); }
        else if (event.key === "ArrowLeft") go(-1);
        else if (event.key === "ArrowRight") go(1);
      }}>
      <motion.div aria-hidden className="absolute inset-0 bg-[rgb(10_10_12)]" style={{ opacity: backdrop }} />
      <div ref={stageRef} className="absolute inset-0 touch-none overflow-hidden" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <motion.div className="absolute inset-0" style={{ transform: lift, opacity: reduced ? shown : undefined }}>
          <motion.div className="absolute inset-y-0 start-0" style={{ transform: trackTransform, width: stage.w * images.length }}>
            {images.map((image, i) => Math.abs(i - index) <= 1 && (
              <Slide key={`${i}:${image.src}`} image={image} index={i} width={stage.w} current={i === index} scale={scale} panX={panX} panY={panY} neighbours={neighbours}
                onNatural={(size) => { naturals.current.set(i, size); }} />
            ))}
          </motion.div>
        </motion.div>
      </div>
      <div data-viewer-controls="" className={cn("viewer-chrome pointer-events-none absolute inset-x-0 top-0 flex items-center gap-3 ps-[calc(var(--m-safe-left)+16px)] pe-[calc(var(--m-safe-right)+16px)] pt-[calc(var(--m-safe-top)+8px)]", nativeViewer || !chrome ? "opacity-0" : "opacity-100")}>
        <button ref={closeBtnRef} type="button" onClick={() => close()} aria-label={t("attach.close")} className={cn("viewer-key", nativeViewer ? "pointer-events-none" : "pointer-events-auto")}><X size={20} /></button>
        <span className="min-w-0 flex-1 truncate text-center text-[15px] font-semibold text-[rgb(245_245_245)] tabular-nums">
          {countText ?? ""}
        </span>
        {canShare ? <button ref={shareBtnRef} type="button" onClick={() => void share()} disabled={sharing} aria-label={t("mobile.image.share", { name: current.name })} className={cn("viewer-key", nativeViewer ? "pointer-events-none" : "pointer-events-auto")}>
          {sharing ? <LoaderCircle size={18} className="animate-spin" /> : <Share size={18} />}
        </button> : <span className="size-11" />}
      </div>
      <div className={cn("viewer-chrome pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 ps-[calc(var(--m-safe-left)+24px)] pe-[calc(var(--m-safe-right)+24px)] pb-[calc(var(--m-safe-bottom)+16px)]", chrome ? "opacity-100" : "opacity-0")}>
        {images.length > 1 && <div className="flex gap-1.5" aria-hidden="true">
          {images.map((_, i) => <span key={i} className={cn("size-1.5 rounded-full transition-colors duration-150", i === index ? "bg-[rgb(245_245_245)]" : "bg-[rgb(245_245_245/0.35)]")} />)}
        </div>}
        {!STORED_NAME.test(current.name) && <span className="max-w-full truncate text-[13px] text-[rgb(245_245_245/0.66)]">{current.name}</span>}
      </div>
      <ViewerNote show={Boolean(note)} text={note?.text ?? ""} failed={note?.failed} dark />
    </div>
  );
}

const rubber = (dx: number) => Math.sign(dx) * Math.min(Math.abs(dx) * 0.35, 80);

const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\w+$/i;
