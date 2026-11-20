import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { usePanelWidth } from "@/lib/panel-wide";
import { desktopMotion } from "@/lib/desktop-motion";

/** Grok Bot's docked info pane, at its 320px: the column's width grows from 0 (and back) while the chat beside it reflows,
 * its content pinned to the column's left edge so it slides in from the window's right. */
export const PANEL_WIDTH = 320;

/** The chat keeps at least this much beside a docked pane; narrower, the pane cannot dock. */
export const CHAT_MIN_WIDTH = 520;

/** The window width at which the bot's panel docks beside the sidebar (280) and a chat of CHAT_MIN_WIDTH; narrower, it overlays. */
export const PANEL_DOCKS_AT = 280 + CHAT_MIN_WIDTH + PANEL_WIDTH;

/** Below md the panel is its own full-screen sheet, so the slot steps aside there. */
export function PanelSlot({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const slot = useRef<HTMLDivElement>(null);
  const width = usePanelWidth();
  const shown = useRef<number | null>(null);
  // Open from the start (a reload with the panel open): it is simply there, with nothing to grow from.
  const instant = useRef(open);
  // The content it last showed stays while the column closes over it.
  const last = useRef(children);
  if (open) last.current = children;
  if (open && !mounted) setMounted(true);
  // The width is set on the element before paint, not through state: the column starts moving in the frame it is asked to.
  useLayoutEffect(() => {
    const el = slot.current;
    if (!el) return;
    if (instant.current) { instant.current = false; el.style.width = `${width}px`; shown.current = width; return; }
    // widened or narrowed while open (lib/panel-wide.ts): a view transition carries the change, so the column takes it at once
    if (open && shown.current !== null && shown.current !== width && el.style.width === `${shown.current}px`) {
      el.style.transition = "none";
      el.style.width = `${width}px`;
      void el.offsetWidth;
      el.style.transition = "";
      shown.current = width;
      return;
    }
    if (open && el.style.width !== `${width}px`) {
      el.style.width = "0px";
      void el.offsetWidth;
    }
    // the slide starts in the frame after the one that mounted or swapped the content: a heavy commit then delays the
    // start by a frame instead of eating the first ~100ms of the slide, which showed as a jump
    const frame = requestAnimationFrame(() => { el.style.width = `${open ? width : 0}px`; shown.current = open ? width : null; });
    return () => cancelAnimationFrame(frame);
  }, [open, mounted, width]);
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setMounted(false), desktopMotion().panel.ms + 50);
    return () => clearTimeout(timer);
  }, [open]);
  if (!mounted) return null;
  return (
    <div
      ref={slot}
      data-panel-slot={open ? "open" : "closing"}
      inert={!open}
      className="relative h-full w-0 shrink-0 overflow-hidden transition-[width] duration-[260ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none max-md:contents"
    >
      <div className="absolute inset-y-0 left-0 flex w-[var(--side-panel-w,320px)] max-md:contents md:[&>aside]:animate-none!">
        {open ? children : last.current}
      </div>
    </div>
  );
}
