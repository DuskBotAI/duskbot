import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { t } from "@/lib/i18n";
import type { HapticKind } from "./platform";
import {
  FIT_VIEW, HOLD_MS, PINCH_RATIO, SCROLL_SLOP, SPECIAL_KEYS, TAP_SLOP, TWO_TAP_MS, TrackpadGestures, clampView, followCursor,
  moveCursor, pointerEvents, resizeView, wheelEvents, wheelSteps, zoomView, type ScreenView, type TrackpadAction,
} from "./screen-trackpad";

/** What the trackpad drives: the remote desktop's pointer and keyboard, in desktop pixels and X keysyms. */
export interface RemoteInput {
  size(): { width: number; height: number } | null;
  pointer(x: number, y: number, mask: number): void;
  key(keysym: number, code: string): void;
  text(text: string): void;
}

/** The viewer that holds the trackpad: touches anywhere on it, margins included, are trackpad touches. */
export const TRACKPAD_SURFACE = "[data-computer-fullscreen]";
/** What keeps its own touches on that surface: the viewer's buttons, menus, dialogs and the control pill. */
const OWN_TOUCHES = "button, a, input, textarea, select, [data-computer-control], [data-takeover-help-sheet], [data-takeover-menu], [data-browser-surface] [role=dialog], [role=listbox], [role=menu]";

type DirectTouch = { x: number; y: number; startX: number; startY: number };

/** The phone's touch layer over a remote screen: in `trackpad` mode touches anywhere on the viewer drive a drawn cursor;
 * in `direct` mode taps click where touched, one finger drags, two fingers scroll (or pan when zoomed) or right-click,
 * and pinch zooms. The hidden field takes the phone keyboard's typing. */
export function ScreenTrackpad({ screen, input, keyboard, haptic, label, mode = "trackpad", recenterNonce = 0 }: {
  screen: RefObject<HTMLElement | null>;
  input: RemoteInput;
  keyboard: RefObject<HTMLInputElement | null>;
  haptic?: (kind: HapticKind) => void;
  label: string;
  mode?: "trackpad" | "direct";
  recenterNonce?: number;
}) {
  const pad = useRef<HTMLDivElement>(null);
  const cursorEl = useRef<HTMLDivElement>(null);
  const remote = useRef(input);
  remote.current = input;
  const buzz = useRef(haptic);
  buzz.current = haptic;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const live = useRef({
    gestures: new TrackpadGestures(),
    view: FIT_VIEW as ScreenView,
    cursor: null as { x: number; y: number } | null,
    sent: null as { x: number; y: number } | null,
    mask: 0,
    wheel: { x: 0, y: 0 },
    frame: { width: 0, height: 0 },
    raf: 0,
    hold: 0 as ReturnType<typeof setTimeout> | 0,
    direct: {
      touches: new Map<number, DirectTouch>(),
      phase: "idle" as "idle" | "one" | "drag" | "long" | "two" | "scroll" | "pinch" | "done",
      twoAt: 0,
      twoMoved: false,
      center: { x: 0, y: 0 },
      startCenter: { x: 0, y: 0 },
      spread: 0,
      startSpread: 0,
      lastDesktop: null as { x: number; y: number } | null,
      hold: 0 as ReturnType<typeof setTimeout> | 0,
    },
    repaint: null as (() => void) | null,
  });

  useEffect(() => {
    const state = live.current;
    if (mode === "direct") {
      if (state.mask && state.cursor) remote.current.pointer(state.cursor.x, state.cursor.y, 0);
      state.mask = 0;
      state.gestures.cancel();
      clearTimeout(state.hold);
      if (cursorEl.current) cursorEl.current.style.opacity = "0";
    } else {
      if (state.mask && state.direct.lastDesktop) {
        remote.current.pointer(state.direct.lastDesktop.x, state.direct.lastDesktop.y, 0);
      }
      state.mask = 0;
      state.direct.lastDesktop = null;
      state.direct.touches.clear();
      state.direct.phase = "idle";
      clearTimeout(state.direct.hold);
      state.repaint?.();
    }
  }, [mode]);

  useEffect(() => {
    if (!recenterNonce) return;
    const state = live.current;
    const size = remote.current.size();
    state.view = FIT_VIEW;
    if (size) state.cursor = { x: size.width / 2, y: size.height / 2 };
    state.repaint?.();
  }, [recenterNonce]);

  useLayoutEffect(() => {
    const state = live.current;
    const element = pad.current;
    const picture = screen.current;
    if (!element || !picture) return;
    const surface = element.closest<HTMLElement>(TRACKPAD_SURFACE) ?? element;
    // the margins take touches as the picture does: no browser panning, zooming, selecting or callout there
    const claimed = ["touch-action", "user-select", "-webkit-user-select", "-webkit-touch-callout"];
    const before = claimed.map((name) => surface.style.getPropertyValue(name));
    if (surface !== element) for (const name of claimed) surface.style.setProperty(name, "none");

    const desktop = () => remote.current.size();
    const cursorAt = () => {
      const size = desktop();
      if (!size) return null;
      state.cursor ??= { x: size.width / 2, y: size.height / 2 };
      return state.cursor;
    };
    // unzoomed frame px per desktop px, from the picture's own box (handles both sized canvases and object-contain letterboxing)
    const fit = () => {
      const size = desktop();
      const canvas = picture.querySelector("canvas");
      if (!size || !canvas) return null;
      const outer = element.getBoundingClientRect();
      const inner = canvas.getBoundingClientRect();
      const { view } = state;
      const boxW = inner.width / view.scale;
      const boxH = inner.height / view.scale;
      if (!boxW || !boxH || !size.width || !size.height) return null;
      let shownW = boxW;
      let shownH = boxH;
      let offsetX = 0;
      let offsetY = 0;
      if (canvas.width > 0 && canvas.height > 0 && getComputedStyle(canvas).objectFit === "contain") {
        const k = Math.min(boxW / canvas.width, boxH / canvas.height);
        shownW = canvas.width * k;
        shownH = canvas.height * k;
        offsetX = (boxW - shownW) / 2;
        offsetY = (boxH - shownH) / 2;
      }
      return {
        left: (inner.left - outer.left - view.x) / view.scale + offsetX,
        top: (inner.top - outer.top - view.y) / view.scale + offsetY,
        scale: shownW / size.width,
        scaleY: shownH / size.height,
      };
    };

    const clientToDesktop = (clientX: number, clientY: number, clamp = true) => {
      const size = desktop();
      const box = fit();
      if (!size || !box || !box.scale || !box.scaleY) return null;
      const outer = element.getBoundingClientRect();
      const { view } = state;
      const unzoomedX = (clientX - outer.left - view.x) / view.scale;
      const unzoomedY = (clientY - outer.top - view.y) / view.scale;
      const rawX = (unzoomedX - box.left) / box.scale;
      const rawY = (unzoomedY - box.top) / box.scaleY;
      if (!clamp && (rawX < 0 || rawY < 0 || rawX > size.width || rawY > size.height)) return null;
      return {
        x: Math.min(size.width - 1, Math.max(0, rawX)),
        y: Math.min(size.height - 1, Math.max(0, rawY)),
      };
    };

    const paint = () => {
      state.raf = 0;
      const isTrackpad = modeRef.current === "trackpad";
      const cursor = isTrackpad ? cursorAt() : null;
      const box = fit();
      if (isTrackpad && cursor && (state.sent?.x !== Math.round(cursor.x) || state.sent?.y !== Math.round(cursor.y))) {
        state.sent = { x: Math.round(cursor.x), y: Math.round(cursor.y) };
        remote.current.pointer(cursor.x, cursor.y, state.mask);
      }
      if (isTrackpad && cursor && box) state.view = followCursor(state.view, box.left + cursor.x * box.scale, box.top + cursor.y * box.scaleY, state.frame.width, state.frame.height);
      const { view } = state;
      picture.style.transformOrigin = "0 0";
      picture.style.transform = view.scale === 1 ? "" : `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`;
      if (cursorEl.current) {
        if (isTrackpad && cursor && box) {
          const x = view.x + (box.left + cursor.x * box.scale) * view.scale;
          const y = view.y + (box.top + cursor.y * box.scaleY) * view.scale;
          cursorEl.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
          cursorEl.current.style.opacity = "1";
        } else {
          cursorEl.current.style.opacity = "0";
        }
      }
    };
    const schedule = () => { state.raf ||= requestAnimationFrame(paint); };
    state.repaint = schedule;

    // a button never waits on the next frame: the move before it goes first so it lands where the cursor is drawn
    const flushMove = () => {
      const cursor = cursorAt();
      if (!cursor) return null;
      if (state.sent?.x !== Math.round(cursor.x) || state.sent?.y !== Math.round(cursor.y)) {
        state.sent = { x: Math.round(cursor.x), y: Math.round(cursor.y) };
        remote.current.pointer(cursor.x, cursor.y, state.mask);
      }
      return cursor;
    };
    const emitWheel = (pt: { x: number; y: number }, dx: number, dy: number, mask: number) => {
      const vertical = wheelSteps(state.wheel.y, dy);
      const horizontal = wheelSteps(state.wheel.x, dx);
      state.wheel = { x: horizontal.rest, y: vertical.rest };
      for (const [x, y, nextMask] of [...wheelEvents(vertical.steps, false, pt.x, pt.y, mask), ...wheelEvents(horizontal.steps, true, pt.x, pt.y, mask)]) {
        remote.current.pointer(x, y, nextMask);
      }
    };
    const emitClick = (pt: { x: number; y: number }, buttonMask: number, feedback: HapticKind) => {
      remote.current.pointer(pt.x, pt.y, 0);
      remote.current.pointer(pt.x, pt.y, buttonMask);
      remote.current.pointer(pt.x, pt.y, 0);
      buzz.current?.(feedback);
    };
    const scrollOrPan = (dx: number, dy: number, center: { x: number; y: number }) => {
      if (state.view.scale > 1.01) {
        state.view = clampView({ ...state.view, x: state.view.x + dx, y: state.view.y + dy }, state.frame.width, state.frame.height);
        schedule();
        return;
      }
      const pt = clientToDesktop(center.x, center.y);
      if (pt) emitWheel(pt, dx, dy, 0);
    };
    const releaseDirectDrag = (fallback?: { x: number; y: number } | null) => {
      const d = state.direct;
      const pt = fallback ?? d.lastDesktop;
      if (state.mask && pt) remote.current.pointer(pt.x, pt.y, 0);
      state.mask = 0;
      d.lastDesktop = null;
    };

    const run = (actions: TrackpadAction[]) => {
      for (const action of actions) {
        if (action.kind === "move") {
          const size = desktop();
          const box = fit();
          const cursor = cursorAt();
          if (!size || !box || !cursor || !box.scale) continue;
          state.cursor = moveCursor(cursor, action, size, 1 / box.scale, state.view.scale);
          schedule();
        } else if (action.kind === "press" || action.kind === "click") {
          const cursor = flushMove();
          if (!cursor) continue;
          for (const [x, y, mask] of pointerEvents(action, cursor.x, cursor.y, state.mask)) {
            remote.current.pointer(x, y, mask);
            if (action.kind === "press") state.mask = mask;
          }
          if (action.kind === "click" || action.down) buzz.current?.(action.kind === "press" ? "medium" : "light");
        } else if (action.kind === "scroll") {
          const cursor = flushMove();
          if (!cursor) continue;
          emitWheel(cursor, action.dx, action.dy, state.mask);
        } else {
          const rect = element.getBoundingClientRect();
          state.view = zoomView(state.view, { ...action, cx: action.cx - rect.left, cy: action.cy - rect.top }, state.frame.width, state.frame.height);
          schedule();
        }
      }
      clearTimeout(state.hold);
      const due = state.gestures.holdDueAt();
      if (due !== null) state.hold = setTimeout(() => run(state.gestures.hold(performance.now())), Math.max(0, due - performance.now()));
    };

    const directHandlers = {
      down(event: PointerEvent) {
        const d = state.direct;
        d.touches.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
        clearTimeout(d.hold);
        if (d.touches.size === 1) {
          d.phase = "one";
          const startX = event.clientX;
          const startY = event.clientY;
          d.hold = setTimeout(() => {
            if (d.phase !== "one") return;
            d.phase = "long";
            const pt = clientToDesktop(startX, startY, false);
            if (pt) emitClick(pt, 4, "medium");
          }, HOLD_MS);
        } else if (d.touches.size === 2) {
          if (d.phase === "drag") releaseDirectDrag();
          d.phase = "two";
          d.twoAt = event.timeStamp;
          d.twoMoved = false;
          const [a, b] = [...d.touches.values()];
          d.center = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
          d.startCenter = { ...d.center };
          d.spread = d.startSpread = Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y));
        } else {
          if (d.phase === "drag") releaseDirectDrag();
          d.phase = "done";
        }
      },
      move(event: PointerEvent) {
        const d = state.direct;
        const touch = d.touches.get(event.pointerId);
        if (!touch) return;
        touch.x = event.clientX;
        touch.y = event.clientY;
        if (d.phase === "one") {
          if (Math.hypot(touch.x - touch.startX, touch.y - touch.startY) <= TAP_SLOP) return;
          clearTimeout(d.hold);
          const start = clientToDesktop(touch.startX, touch.startY, false);
          if (!start) { d.phase = "done"; return; }
          d.phase = "drag";
          const now = clientToDesktop(touch.x, touch.y, true);
          remote.current.pointer(start.x, start.y, 0);
          remote.current.pointer(start.x, start.y, 1);
          state.mask = 1;
          d.lastDesktop = start;
          if (now) {
            remote.current.pointer(now.x, now.y, 1);
            d.lastDesktop = now;
          }
        } else if (d.phase === "drag") {
          const now = clientToDesktop(touch.x, touch.y);
          if (now) {
            remote.current.pointer(now.x, now.y, 1);
            d.lastDesktop = now;
          }
        } else if (d.phase === "two" || d.phase === "scroll" || d.phase === "pinch") {
          if (d.touches.size !== 2) return;
          const [a, b] = [...d.touches.values()];
          const center = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
          const spread = Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y));
          const prev = d.center;
          const prevSpread = d.spread;
          d.center = center;
          d.spread = spread;
          const rect = element.getBoundingClientRect();
          if (d.phase === "two") {
            if (Math.abs(spread / d.startSpread - 1) > PINCH_RATIO) {
              d.phase = "pinch";
              d.twoMoved = true;
              state.view = zoomView(state.view, { factor: spread / d.startSpread, cx: center.x - rect.left, cy: center.y - rect.top, dx: center.x - d.startCenter.x, dy: center.y - d.startCenter.y }, state.frame.width, state.frame.height);
              schedule();
              return;
            }
            if (Math.hypot(center.x - d.startCenter.x, center.y - d.startCenter.y) <= SCROLL_SLOP) return;
            d.phase = "scroll";
            d.twoMoved = true;
            scrollOrPan(center.x - d.startCenter.x, center.y - d.startCenter.y, center);
          } else if (d.phase === "pinch") {
            state.view = zoomView(state.view, { factor: spread / prevSpread, cx: center.x - rect.left, cy: center.y - rect.top, dx: center.x - prev.x, dy: center.y - prev.y }, state.frame.width, state.frame.height);
            schedule();
          } else {
            scrollOrPan(center.x - prev.x, center.y - prev.y, center);
          }
        }
      },
      up(event: PointerEvent) {
        const d = state.direct;
        const touch = d.touches.get(event.pointerId);
        if (!touch) return;
        d.touches.delete(event.pointerId);
        clearTimeout(d.hold);
        if (d.phase === "one") {
          const pt = clientToDesktop(touch.x, touch.y, false);
          if (pt) emitClick(pt, 1, "light");
        } else if (d.phase === "drag") {
          releaseDirectDrag(clientToDesktop(touch.x, touch.y, true));
        } else if (d.phase === "two") {
          if (d.touches.size === 0 && !d.twoMoved && event.timeStamp - d.twoAt <= TWO_TAP_MS) {
            const pt = clientToDesktop(d.center.x, d.center.y, false);
            if (pt) emitClick(pt, 4, "light");
          } else if (d.touches.size === 1) {
            d.twoMoved ||= event.timeStamp - d.twoAt > TWO_TAP_MS;
          }
        } else if (d.phase === "scroll" || d.phase === "pinch") {
          d.phase = "done";
        }
        if (d.touches.size === 0) d.phase = "idle";
      },
      cancel() {
        const d = state.direct;
        clearTimeout(d.hold);
        if (d.phase === "drag") releaseDirectDrag();
        d.touches.clear();
        d.phase = "idle";
      },
    };

    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      state.view = resizeView(state.view, state.frame, next);
      state.frame = next;
      schedule();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const canvas = picture.querySelector("canvas");
    if (canvas) observer.observe(canvas);

    const handlers = {
      down(event: PointerEvent) {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        if (surface !== element && event.target instanceof Element && event.target.closest(OWN_TOUCHES)) return;
        surface.setPointerCapture?.(event.pointerId);
        if (modeRef.current === "direct") directHandlers.down(event);
        else run(state.gestures.down(event.pointerId, event.clientX, event.clientY, event.timeStamp));
      },
      move(event: PointerEvent) {
        if (modeRef.current === "direct") {
          directHandlers.move(event);
          return;
        }
        // the in-between samples the system coalesced into this frame: drawing still happens once per frame
        const samples = event.getCoalescedEvents?.().length ? event.getCoalescedEvents() : [event];
        for (const sample of samples) run(state.gestures.move(event.pointerId, sample.clientX, sample.clientY, sample.timeStamp || event.timeStamp));
      },
      up(event: PointerEvent) {
        if (modeRef.current === "direct") directHandlers.up(event);
        else run(state.gestures.up(event.pointerId, event.timeStamp));
      },
      cancel() {
        if (modeRef.current === "direct") directHandlers.cancel();
        else run(state.gestures.cancel());
      },
    };
    surface.addEventListener("pointerdown", handlers.down);
    surface.addEventListener("pointermove", handlers.move);
    surface.addEventListener("pointerup", handlers.up);
    surface.addEventListener("pointercancel", handlers.cancel);
    return () => {
      surface.removeEventListener("pointerdown", handlers.down);
      surface.removeEventListener("pointermove", handlers.move);
      surface.removeEventListener("pointerup", handlers.up);
      surface.removeEventListener("pointercancel", handlers.cancel);
      observer.disconnect();
      if (surface !== element) claimed.forEach((name, index) => surface.style.setProperty(name, before[index]!));
      cancelAnimationFrame(state.raf);
      state.raf = 0;
      clearTimeout(state.hold);
      clearTimeout(state.direct.hold);
      state.gestures.cancel();
      state.direct.touches.clear();
      state.direct.phase = "idle";
      state.repaint = null;
      const releasePt = state.cursor ?? state.direct.lastDesktop;
      if (state.mask && releasePt) remote.current.pointer(releasePt.x, releasePt.y, 0);
      state.direct.lastDesktop = null;
      state.mask = 0;
      state.view = FIT_VIEW;
      picture.style.transform = "";
    };
  }, [screen]);

  useEffect(() => {
    const field = keyboard.current;
    if (!field) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const special = SPECIAL_KEYS[event.key];
      if (!special) return;
      event.preventDefault();
      remote.current.key(special.keysym, special.code);
    };
    const beforeinput = (event: InputEvent) => {
      if (event.inputType === "insertText" || event.inputType === "insertReplacementText") {
        event.preventDefault();
        if (event.data) remote.current.text(event.data);
      } else if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
        event.preventDefault();
        remote.current.key(SPECIAL_KEYS.Enter!.keysym, "Enter");
      } else if (event.inputType === "deleteContentBackward") {
        event.preventDefault();
        remote.current.key(SPECIAL_KEYS.Backspace!.keysym, "Backspace");
      }
    };
    // composed text (kana, pinyin) cannot be cancelled while it is composed; it is sent whole once it settles
    const compositionend = (event: CompositionEvent) => {
      if (event.data) remote.current.text(event.data);
      field.value = "";
    };
    const fallbackInput = (event: Event) => {
      if (event instanceof InputEvent && event.isComposing) return;
      if (!field.value) return;
      const text = field.value;
      field.value = "";
      remote.current.text(text);
    };
    field.addEventListener("keydown", keydown);
    field.addEventListener("beforeinput", beforeinput);
    field.addEventListener("compositionend", compositionend);
    field.addEventListener("input", fallbackInput);
    return () => {
      field.removeEventListener("keydown", keydown);
      field.removeEventListener("beforeinput", beforeinput);
      field.removeEventListener("compositionend", compositionend);
      field.removeEventListener("input", fallbackInput);
    };
  }, [keyboard]);

  return (
    <>
      <div ref={pad} data-screen-trackpad="" role="application" aria-label={label}
        className="absolute inset-0 z-[2] touch-none select-none [-webkit-touch-callout:none] [-webkit-user-select:none]" />
      <div ref={cursorEl} data-screen-cursor="" aria-hidden="true" className="pointer-events-none absolute left-0 top-0 z-[3] opacity-0 will-change-transform">
        <svg width={16} height={24} viewBox="0 0 14 21" className="absolute -left-px -top-px drop-shadow-[0_1px_1.5px_rgb(0_0_0/0.35)]">
          <path d="M1 1v15.5l3.7-3.5 2.6 6 2.3-1-2.6-5.8H12z" fill="#141414" stroke="#fafafa" strokeWidth="1.6" strokeLinejoin="round" style={{ paintOrder: "stroke" }} />
        </svg>
      </div>
      <input ref={keyboard} type="text" data-screen-keyboard="" aria-label={t("desktopViewer.text")} defaultValue=""
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="enter"
        className="pointer-events-none absolute bottom-0 left-0 size-px opacity-0" style={{ fontSize: 16 }} />
    </>
  );
}
