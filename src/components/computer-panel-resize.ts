import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const PANEL_WIDTH_KEY = "dusk-computer-panel-width";
const PANEL_MIN_WIDTH = 360;
export const PANEL_MAX_WIDTH = 960;
const PANEL_DEFAULT_WIDTH = 400;
const PANEL_RESIZE_STEP = 40;

function readPanelWidth(): number {
  try {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= PANEL_MIN_WIDTH && stored <= PANEL_MAX_WIDTH) return stored;
  } catch {
  }
  return PANEL_DEFAULT_WIDTH;
}

/** The computer panel's drag edge: a pointer drag or the arrow keys resize the
 * panel, and the width is remembered across opens. */
export function useComputerPanelResize() {
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  const persistPanelWidth = (width: number) => {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(width));
    } catch {
    }
  };
  const onResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    resizeFrom.current = { x: event.clientX, width: panelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, resizeFrom.current.width + (resizeFrom.current.x - event.clientX)));
    setPanelWidth(next);
  };
  const onResizeEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    resizeFrom.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    persistPanelWidth(panelWidth);
  };
  const onResizeBy = (delta: number) => {
    setPanelWidth((current) => {
      const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, current + delta));
      persistPanelWidth(next);
      return next;
    });
  };
  const onSeparatorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const widen = event.key === "ArrowLeft" ? PANEL_RESIZE_STEP : event.key === "ArrowRight" ? -PANEL_RESIZE_STEP : null;
    if (widen === null) return;
    event.preventDefault();
    onResizeBy(widen);
  };
  const separator = {
    role: "separator",
    "aria-orientation": "vertical",
    "aria-valuemin": PANEL_MIN_WIDTH,
    "aria-valuemax": PANEL_MAX_WIDTH,
    "aria-valuenow": panelWidth,
    tabIndex: 0,
    onKeyDown: onSeparatorKeyDown,
    onPointerDown: onResizeStart,
    onPointerMove: onResizeMove,
    onPointerUp: onResizeEnd,
    onPointerCancel: onResizeEnd,
  } as const;
  return { panelWidth, separator };
}
