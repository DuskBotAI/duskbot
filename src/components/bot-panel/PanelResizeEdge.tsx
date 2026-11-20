import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { PANEL_MIN, PANEL_NARROW, panelRestMax, panelWidthNow, resizePanel, usePanelWidth } from "@/lib/panel-wide";

const STEP = 16;

function holdPageCursor(held: boolean) {
  document.body.style.cursor = held ? "col-resize" : "";
  document.body.style.userSelect = held ? "none" : "";
}

/** The panel's left edge: its 0.5px hairline, and a strip over it that a drag or the arrow keys resize the panel by, from
 * the width it shows (a panel the browser widened too). A double-click takes it back to its usual width. The width it
 * is left at is kept for the next open. */
export function PanelResizeEdge() {
  const width = usePanelWidth();
  const drag = useRef<{ x: number; from: number; to: number | null; frame: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => () => {
    if (drag.current) cancelAnimationFrame(drag.current.frame);
    holdPageCursor(false);
  }, []);
  const end = () => {
    const ended = drag.current;
    if (!ended) return;
    drag.current = null;
    cancelAnimationFrame(ended.frame);
    setDragging(false);
    holdPageCursor(false);
    resizePanel(ended.to ?? panelWidthNow(), true);
  };
  const max = panelRestMax();
  return (
    <>
      <span aria-hidden="true" data-panel-edge className="pointer-events-none absolute inset-y-0 left-0 z-10 w-[0.5px] bg-edge max-md:hidden" />
      <div
        role="separator"
        aria-label={t("computer.resizeAria")}
        aria-orientation="vertical"
        aria-valuemin={PANEL_MIN}
        aria-valuemax={max}
        aria-valuenow={Math.max(PANEL_MIN, Math.min(width, max))}
        tabIndex={0}
        data-panel-resize={dragging ? "dragging" : ""}
        className={cn("absolute inset-y-0 left-0 z-20 hidden w-2 cursor-col-resize touch-none outline-none md:block",
          "after:absolute after:inset-y-0 after:left-0 after:w-0.5 after:transition-[background-color] after:duration-150 after:ease-[ease]",
          "hover:after:bg-ink/15 data-[panel-resize=dragging]:after:bg-ink/25 focus-visible:after:bg-focus")}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, from: panelWidthNow(), to: null, frame: 0 };
          setDragging(true);
          holdPageCursor(true);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          current.to = current.from + current.x - event.clientX;
          if (current.frame) return;
          current.frame = requestAnimationFrame(() => {
            current.frame = 0;
            if (drag.current === current && current.to !== null) resizePanel(current.to);
          });
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => resizePanel(PANEL_NARROW, true)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          resizePanel(panelWidthNow() + (event.key === "ArrowLeft" ? STEP : -STEP), true);
        }}
      />
    </>
  );
}
