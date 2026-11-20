// A Mermaid diagram full screen (ChatMarkdown.tsx): zoom, fit, drag or pinch to pan, Download PNG. Escape closes only
// this viewer. The full-screen viewer is an idea from Threebot (MIT).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Download, RotateCcw, Scan } from "../icons";

import { activeLocale, t } from "@/lib/i18n";
import { Icon } from "./Icon";
import { MotionDiv } from "./ui/SheetMotion";

export interface DiagramView { scale: number; x: number; y: number }

const MIN_SCALE = 0.1, MAX_SCALE = 8, STEP = 1.25, FIT_MAX = 3, FIT_PAD = 48, PNG_PIXELS = 16e6, PNG_SIDE = 8192;

export const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** Zoom to `scale` keeping the point (`px`, `py`), measured from the stage's centre, where it is on screen. */
export function zoomAt(view: DiagramView, scale: number, px: number, py: number): DiagramView {
  const next = clampScale(scale);
  const k = next / view.scale;
  return { scale: next, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}

/** The scale that shows the whole diagram in the stage with a margin, never blown up past 3x. */
export function fitScale(width: number, height: number, stageWidth: number, stageHeight: number): number {
  if (!width || !height) return 1;
  return clampScale(Math.min(FIT_MAX, (stageWidth - FIT_PAD * 2) / width, (stageHeight - FIT_PAD * 2) / height));
}

const BUTTON = "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.035] hover:text-ink outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45 touch:size-10";
const GROUP = "flex items-center gap-0.5 rounded-full border-[0.5px] border-transparent bg-app p-0.5";

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
const STOP = { onClick: stop, onDoubleClick: stop, onMouseDown: stop, onPointerDown: stop, onPointerUp: stop, onTouchStart: stop, onContextMenu: stop, onKeyDown: stop };

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  try {
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    // Chromium may consume the Blob after the click task.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** The diagram at up to twice its size on the viewer's own background, so the theme's text stays readable. */
async function diagramPng(svg: SVGSVGElement, width: number, height: number, background: string): Promise<Blob> {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", String(width));
  copy.setAttribute("height", String(height));
  copy.style.removeProperty("max-width");
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
  await image.decode();
  const k = Math.min(2, Math.sqrt(PNG_PIXELS / (width * height)), PNG_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * k));
  canvas.height = Math.max(1, Math.round(height * k));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no canvas");
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("no png");
  return blob;
}

/** Security: `svg` is the markup mermaid.render() returned under securityLevel "strict", as the inline diagram shows. */
export function MermaidViewer({ svg, onClose }: { svg: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const markup = useMemo(() => ({ __html: svg }), [svg]);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [view, setView] = useState<DiagramView>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [moving, setMoving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: DiagramView; points: Array<{ x: number; y: number }> } | null>(null);

  const stageBox = () => stageRef.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  const fromCentre = (clientX: number, clientY: number) => {
    const box = stageBox();
    return { x: clientX - (box.left + box.width / 2), y: clientY - (box.top + box.height / 2) };
  };
  const fit = (measured = size) => {
    if (!measured) return;
    const box = stageBox();
    setView({ scale: fitScale(measured.width, measured.height, box.width, box.height), x: 0, y: 0 });
  };
  const zoomBy = (factor: number) => setView((current) => zoomAt(current, current.scale * factor, 0, 0));

  // the diagram's own size from its viewBox: mermaid draws it at 100% width capped by an inline max-width
  useLayoutEffect(() => {
    const element = contentRef.current?.querySelector("svg");
    if (!element) return;
    const box = element.viewBox?.baseVal;
    const measured = box?.width && box.height ? { width: box.width, height: box.height } : (() => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width || 1, height: rect.height || 1 };
    })();
    element.setAttribute("width", String(measured.width));
    element.setAttribute("height", String(measured.height));
    element.style.maxWidth = "none";
    setSize(measured);
    fit(measured);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svg]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    // taken first, on the window's capture phase, so a sheet or panel under the viewer never sees this Escape
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
        return;
      }
      if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomBy(STEP); return; }
      if (event.key === "-") { event.preventDefault(); zoomBy(1 / STEP); return; }
      if (event.key === "0") { event.preventDefault(); setView({ scale: 1, x: 0, y: 0 }); return; }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const focusable = [...(dialog?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
      if (!dialog || focusable.length === 0) return;
      const first = focusable[0]!, last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !dialog.contains(active))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  // a pinch on a trackpad (or Ctrl/⌘ with the wheel) zooms at the pointer; a plain wheel or two-finger scroll pans
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : 1;
      if (event.ctrlKey || event.metaKey) {
        const at = fromCentre(event.clientX, event.clientY);
        setView((current) => zoomAt(current, current.scale * Math.exp(-event.deltaY * unit * 0.01), at.x, at.y));
        return;
      }
      setView((current) => ({ ...current, x: current.x - event.deltaX * unit, y: current.y - event.deltaY * unit }));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const begin = () => { gesture.current = { view: viewRef.current, points: [...pointers.current.values()] }; };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    begin();
    setMoving(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const start = gesture.current;
    const points = [...pointers.current.values()];
    if (!start) return;
    if (points.length === 1 && start.points.length === 1) {
      setView({ ...start.view, x: start.view.x + points[0]!.x - start.points[0]!.x, y: start.view.y + points[0]!.y - start.points[0]!.y });
      return;
    }
    if (points.length < 2 || start.points.length < 2) return;
    const [a, b] = points as [{ x: number; y: number }, { x: number; y: number }];
    const [a0, b0] = start.points as [{ x: number; y: number }, { x: number; y: number }];
    const spread = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, Math.hypot(b0.x - a0.x, b0.y - a0.y));
    const mid = fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2), mid0 = fromCentre((a0.x + b0.x) / 2, (a0.y + b0.y) / 2);
    const scale = clampScale(start.view.scale * spread), k = scale / start.view.scale;
    // the diagram point under the fingers' first midpoint follows the midpoint as it moves
    setView({ scale, x: mid.x - (mid0.x - start.view.x) * k, y: mid.y - (mid0.y - start.view.y) * k });
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    if (pointers.current.size) begin();
    else { gesture.current = null; setMoving(false); }
  };

  const download = async () => {
    const element = contentRef.current?.querySelector("svg");
    if (!element || !size) return;
    try {
      const background = getComputedStyle(dialogRef.current ?? document.body).backgroundColor;
      saveBlob(await diagramPng(element, size.width, size.height, background), "diagram.png");
      setSaveFailed(false);
    } catch {
      setSaveFailed(true);
    }
  };

  const percent = new Intl.NumberFormat(activeLocale(), { style: "percent", maximumFractionDigits: 0 }).format(view.scale);
  const transition = { duration: 0 };

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("mermaid.viewer")}
      tabIndex={-1}
      data-mermaid-viewer
      className="fixed inset-0 z-[70] bg-app outline-none"
      // a portal still bubbles React events to the message it opened from
      {...STOP}
    >
      <div
        ref={stageRef}
        data-moving={moving ? "" : undefined}
        className="absolute inset-0 flex cursor-grab touch-none select-none items-center justify-center overflow-hidden data-[moving]:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <MotionDiv
          className="shrink-0"
          style={{ width: size?.width, height: size?.height, opacity: size ? 1 : 0 }}
          initial={false}
          animate={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          transition={transition}
        >
          <div ref={contentRef} dir="ltr" className="[&_svg]:block" dangerouslySetInnerHTML={markup} />
        </MotionDiv>
      </div>
      <div data-viewer-controls="" className="absolute end-[calc(var(--safe-area-inset-right,env(safe-area-inset-right,0px))+12px)] top-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+12px)] z-[1] flex items-center gap-2">
        <div className={GROUP}>
          <button type="button" className={BUTTON} onClick={() => zoomBy(1 / STEP)} disabled={view.scale <= MIN_SCALE} aria-label={t("mermaid.zoomOut")} title={t("mermaid.zoomOut")}>
            <Icon name="zoom-out" size={16} />
          </button>
          <span className="min-w-10 text-center text-[12px] leading-4 tabular-nums text-ink-secondary" aria-live="polite">{percent}</span>
          <button type="button" className={BUTTON} onClick={() => zoomBy(STEP)} disabled={view.scale >= MAX_SCALE} aria-label={t("mermaid.zoomIn")} title={t("mermaid.zoomIn")}>
            <Icon name="zoom-in" size={16} />
          </button>
          <button type="button" className={BUTTON} onClick={() => setView({ scale: 1, x: 0, y: 0 })} aria-label={t("mermaid.reset")} title={t("mermaid.reset")}>
            <RotateCcw size={15} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button type="button" className={BUTTON} onClick={() => fit()} aria-label={t("mermaid.fit")} title={t("mermaid.fit")}>
            <Scan size={15} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <div className={GROUP}>
          <button type="button" className={BUTTON} onClick={() => void download()} disabled={!size} aria-label={t("mermaid.downloadPng")} title={t("mermaid.downloadPng")}>
            <Download size={15} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button type="button" className={BUTTON} onClick={onClose} aria-label={t("mermaid.close")} title={t("mermaid.close")}>
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>
      {saveFailed && (
        <p role="alert" className="absolute inset-x-0 bottom-5 text-center text-[12px] leading-4 text-danger">{t("mermaid.downloadFailed")}</p>
      )}
    </div>,
    document.body,
  );
}
