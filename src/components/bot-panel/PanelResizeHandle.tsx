import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  PANEL_MIN_WIDTH,
  fitPanelWidth,
  maxPanelWidth,
  savePanelWidth,
  setPanelWidth,
  usePanelWidth,
} from "@/lib/panel-wide";

const STEP = 24;

/** While the edge is dragged the whole page shows the resize cursor and selects no text, wherever the pointer is. */
function holdPageCursor(held: boolean) {
  document.body.style.cursor = held ? "col-resize" : "";
  document.body.style.userSelect = held ? "none" : "";
}

/** The bot panel's left edge: dragging it, or the arrow keys, resizes the panel beside the chat, and the width is kept. */
export function PanelResizeHandle() {
  const width = usePanelWidth();
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    fitPanelWidth();
    window.addEventListener("resize", fitPanelWidth);
    return () => window.removeEventListener("resize", fitPanelWidth);
  }, []);
  useEffect(() => () => holdPageCursor(false), []);

  const end = (event: PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    holdPageCursor(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    savePanelWidth();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.key === "ArrowLeft" ? STEP : event.key === "ArrowRight" ? -STEP : null;
    if (step === null) return;
    event.preventDefault();
    setPanelWidth(width + step);
    savePanelWidth();
  };

  return (
    <div
      role="separator"
      aria-label={t("botPanel.resize")}
      aria-orientation="vertical"
      aria-valuemin={PANEL_MIN_WIDTH}
      aria-valuemax={maxPanelWidth()}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      data-panel-resize={dragging ? "dragging" : undefined}
      className={cn(
        "absolute inset-y-0 left-0 z-20 hidden w-3 cursor-col-resize touch-none outline-none md:block",
        "after:pointer-events-none after:absolute after:inset-y-0 after:left-0 after:w-[0.5px] after:bg-edge after:transition-colors hover:after:bg-ink/25 focus-visible:after:bg-focus",
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width };
        setDragging(true);
        holdPageCursor(true);
      }}
      onPointerMove={(event) => {
        if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        setPanelWidth(drag.current.width + (drag.current.x - event.clientX));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    />
  );
}
