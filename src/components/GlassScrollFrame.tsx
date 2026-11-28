import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { cn } from "@/lib/cn";

type GlassEdge = "top" | "bottom";

const EDGES: readonly GlassEdge[] = ["top", "bottom"];

function frameBars(frame: HTMLElement): Partial<Record<GlassEdge, HTMLElement>> {
  const bars: Partial<Record<GlassEdge, HTMLElement>> = {};
  for (const child of Array.from(frame.children)) {
    const edge = (child as HTMLElement).dataset?.glassBar;
    if (edge === "top" || edge === "bottom") bars[edge] = child as HTMLElement;
  }
  return bars;
}

export function publishGlassInsets(frame: HTMLElement): void {
  const bars = frameBars(frame);
  for (const edge of EDGES) {
    const bar = bars[edge];
    frame.style.setProperty(`--glass-${edge}`, `${bar ? Math.ceil(bar.getBoundingClientRect().height) : 0}px`);
  }
}

export type ScrollFade = "start" | "end" | "both";

/** Which edges of a scrolling list have more of it past them. */
export function scrollFadeOf({ scrollTop, scrollHeight, clientHeight }: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">): ScrollFade | null {
  const start = scrollTop > 1;
  const end = scrollTop < scrollHeight - clientHeight - 1;
  return start && end ? "both" : start ? "start" : end ? "end" : null;
}

export function watchScrollFade(list: HTMLElement, frame: HTMLElement): () => void {
  let shown: ScrollFade | null | undefined;
  const update = () => {
    const fade = scrollFadeOf(list);
    if (fade === shown) return;
    shown = fade;
    if (fade) frame.setAttribute("data-scroll-fade", fade);
    else frame.removeAttribute("data-scroll-fade");
  };
  update();
  list.addEventListener("scroll", update, { passive: true });
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
  resize?.observe(list);
  for (const child of Array.from(list.children)) resize?.observe(child);
  return () => {
    list.removeEventListener("scroll", update);
    resize?.disconnect();
    frame.removeAttribute("data-scroll-fade");
  };
}

const FadeFrame = createContext(false);

/** The native bar stays out of sight: the overlay below stands in for it. */
const NO_NATIVE_BAR = ["[scrollbar-width:none]", "[&::-webkit-scrollbar]:hidden"];
const THUMB_INSET = 6;
const THUMB_MIN = 24;

export type ThumbBox = { top: number; height: number } | null;

/** Where the overlay's thumb sits on a track `track` px tall for a list scrolled as `list` is; null when nothing scrolls. */
export function thumbBox({ scrollTop, scrollHeight, clientHeight }: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">, track: number): ThumbBox {
  if (scrollHeight <= clientHeight + 1 || track <= 0) return null;
  const room = track - THUMB_INSET * 2;
  const height = Math.max(THUMB_MIN, Math.round((room * clientHeight) / scrollHeight));
  const travel = Math.max(0, room - height);
  const ratio = Math.min(1, Math.max(0, scrollTop / (scrollHeight - clientHeight)));
  return { top: THUMB_INSET + ratio * travel, height };
}

/** Grok's overlay scrollbar: a 5px thumb of 8% ink, 2px off the edge, that fades in while the pointer is over the list
 * (12% under the pointer itself) and out 150ms after it leaves. Dragging it scrolls the list. A touch screen has no
 * pointer to show it for, and gets none. */
export const OverlayScrollbar = memo(function OverlayScrollbar(props: { scroller: HTMLElement | null; style?: CSSProperties }) {
  return canHover() ? <PointerScrollbar {...props} /> : null;
});

const canHover = () => typeof matchMedia !== "function" || matchMedia("(any-hover: hover)").matches;

const PointerScrollbar = memo(function PointerScrollbar({ scroller, style }: { scroller: HTMLElement | null; style?: CSSProperties }) {
  const track = useRef<HTMLDivElement>(null);
  // the thumb's place follows the scroll straight in its style; only its size and presence re-render
  const box = useRef<ThumbBox>(null);
  const thumbEl = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ y: number; top: number } | null>(null);
  useEffect(() => {
    if (!scroller) return;
    scroller.classList.add(...NO_NATIVE_BAR);
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = thumbBox(scroller, track.current?.clientHeight ?? 0);
        box.current = next;
        if (next && thumbEl.current) thumbEl.current.style.top = `${next.top}px`;
        setSize(next ? next.height : null);
      });
    };
    measure();
    const enter = () => setHover(true);
    const leave = () => setHover(false);
    scroller.addEventListener("scroll", measure, { passive: true });
    scroller.addEventListener("pointerenter", enter);
    scroller.addEventListener("pointerleave", leave);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resize?.observe(scroller);
    if (scroller.firstElementChild) resize?.observe(scroller.firstElementChild);
    if (track.current) resize?.observe(track.current);
    return () => {
      cancelAnimationFrame(frame);
      scroller.classList.remove(...NO_NATIVE_BAR);
      scroller.removeEventListener("scroll", measure);
      scroller.removeEventListener("pointerenter", enter);
      scroller.removeEventListener("pointerleave", leave);
      resize?.disconnect();
    };
  }, [scroller]);
  const placeThumb = (el: HTMLDivElement | null) => {
    thumbEl.current = el;
    if (el && box.current) el.style.top = `${box.current.top}px`;
  };
  const grab = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!scroller || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { y: event.clientY, top: scroller.scrollTop };
    setDragging(true);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current, thumb = box.current, height = track.current?.clientHeight ?? 0;
    if (!scroller || !start || !thumb) return;
    const travel = height - THUMB_INSET * 2 - thumb.height;
    if (travel > 0) scroller.scrollTop = start.top + ((event.clientY - start.y) * (scroller.scrollHeight - scroller.clientHeight)) / travel;
  };
  const release = () => { drag.current = null; setDragging(false); };
  const shown = hover || dragging;
  return (
    <div ref={track} aria-hidden="true" data-overlay-scrollbar="" data-scrollable={size !== null ? "" : undefined}
      className="pointer-events-none absolute right-[2px] z-30 w-[5px]" style={{ top: 0, bottom: 0, ...style }}>
      {size !== null && (
        <div
          ref={placeThumb}
          data-overlay-scrollbar-thumb=""
          onPointerDown={grab}
          onPointerMove={move}
          onPointerUp={release}
          onPointerCancel={release}
          style={{ height: size }}
          className={cn(
            "absolute inset-x-0 rounded-full bg-ink/[0.08] transition-[background-color,opacity] duration-150 hover:bg-ink/[0.12]",
            dragging && "bg-ink/[0.12]",
            "pointer-events-auto",
            shown ? "opacity-100" : "opacity-0 hover:opacity-100",
          )}
        />
      )}
    </div>
  );
});

const GLASS_SCROLLBAR_STYLE: CSSProperties = { top: "var(--glass-top, 0px)", bottom: "var(--glass-bottom, 0px)" };

/** `fade` stacks the bars above and below the scroller instead of floating them over it as glass, and fades
 * the list's own rows out at an edge only while more of it lies past that edge (`.scroll-fade-list`). */
export function GlassScrollFrame({ className, children, fade = false, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode; fade?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const frame = ref.current;
    if (!frame || fade) return;
    let frameId = 0;
    const find = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => setScroller(frame.querySelector<HTMLElement>(".glass-scroller")));
    };
    find();
    const watch = new MutationObserver(find);
    watch.observe(frame, { childList: true });
    return () => { cancelAnimationFrame(frameId); watch.disconnect(); };
  }, [fade]);
  useLayoutEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const apply = () => publishGlassInsets(frame);
    const resize = new ResizeObserver(apply);
    const watch = () => {
      resize.disconnect();
      for (const bar of Object.values(frameBars(frame))) if (bar) resize.observe(bar);
      apply();
    };
    watch();
    const children = new MutationObserver(watch);
    children.observe(frame, { childList: true });
    return () => {
      resize.disconnect();
      children.disconnect();
    };
  }, []);
  return (
    <FadeFrame.Provider value={fade}>
      <div ref={ref} data-glass-frame="" className={cn("relative min-h-0", fade && "flex flex-col", className)} {...rest}>
        {children}
        {!fade && <OverlayScrollbar scroller={scroller} style={GLASS_SCROLLBAR_STYLE} />}
      </div>
    </FadeFrame.Provider>
  );
}

/** `fade` trades the glass for a plain fade into the canvas: what scrolls under the bar melts away towards the edge. */
export function GlassBar({ edge, fade, className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { edge: GlassEdge; fade?: boolean; children: ReactNode }) {
  const stacked = useContext(FadeFrame);
  return (
    <div
      data-glass-bar={edge}
      data-glass-fade={fade ? "" : undefined}
      className={cn(stacked ? "relative z-10 shrink-0" : cn("glass-bar absolute inset-x-0 z-10", edge === "top" ? "top-0" : "bottom-0"), className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export function GlassScroller({ className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  const fade = useContext(FadeFrame);
  const frame = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!fade || !frame.current || !list.current) return;
    setScroller(list.current);
    return watchScrollFade(list.current, frame.current);
  }, [fade]);
  if (!fade) {
    return (
      <div className={cn("glass-scroller h-full overflow-y-auto", className)} {...rest}>
        <div className="glass-scroller-content">{children}</div>
      </div>
    );
  }
  return (
    <div ref={frame} data-scroll-fade-frame="" className="relative min-h-0 flex-1">
      <div ref={list} className={cn("scroll-fade-list h-full overflow-y-auto", className)} {...rest}>
        <div>{children}</div>
      </div>
      <OverlayScrollbar scroller={scroller} />
    </div>
  );
}
