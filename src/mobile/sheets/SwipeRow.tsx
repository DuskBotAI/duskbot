import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useMotionValue, useTransform, type AnimationPlaybackControls } from "motion/react";
import { MoreHorizontal } from "../../icons";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { useDrag } from "../gesture";
import { projectRelease, rubberband, settleTo } from "../motion";

let closeOpenRow: (() => void) | null = null;

export function swipeOffset(position: number, width: number): number {
  if (position < -width) return -width + rubberband(position + width, 48);
  return position > 0 ? rubberband(position, 48) : position;
}

export function swipeRestingPosition(position: number, velocity: number, width: number): number {
  return projectRelease(position, velocity) < -width / 2 ? -width : 0;
}

export function SwipeRow({ children, actions, onOpen }: {
  children: ReactNode;
  actions: Array<{ label: string; danger?: boolean; onPress: () => void }>;
  onOpen?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const run = useRef<AnimationPlaybackControls | null>(null);
  const origin = useRef(0);
  const opened = useRef(false);
  const [isOpen, setIsOpen] = useState(false);
  const width = actions.length * 132;
  // a closed row's rounded clip still lets the actions' colour through its anti-aliased corners
  const actionsShown = useTransform(x, (position) => (position < -0.5 ? "visible" : "hidden"));
  const close = useCallback(() => {
    run.current?.stop();
    opened.current = false;
    setIsOpen(false);
    if (closeOpenRow === close) closeOpenRow = null;
    run.current = settleTo(x, 0, 0);
  }, [x]);
  const settle = (target: number, velocity = 0) => {
    run.current?.stop();
    if (target < 0) { if (closeOpenRow !== close) closeOpenRow?.(); closeOpenRow = close; }
    else if (closeOpenRow === close) closeOpenRow = null;
    opened.current = target < 0;
    setIsOpen(target < 0);
    run.current = settleTo(x, target, velocity);
  };
  useEffect(() => () => { run.current?.stop(); if (closeOpenRow === close) closeOpenRow = null; }, [close]);
  useDrag(ref, {
    axis: "x",
    enabled: actions.length > 0,
    claim: (state) => !(state.target instanceof Element && state.target.closest("[data-swipe-control]")) && (state.dx < 0 || opened.current),
    onStart: () => { run.current?.stop(); origin.current = x.get(); if (closeOpenRow !== close) closeOpenRow?.(); },
    onMove: (state) => x.set(swipeOffset(origin.current + state.dx, width)),
    onEnd: (state) => settle(swipeRestingPosition(x.get(), state.vx, width), state.vx),
    onCancel: () => settle(opened.current ? -width : 0),
  });
  return (
    <div ref={ref} className="relative overflow-hidden rounded-2xl" onKeyDown={(event) => { if (event.key === "Escape" && opened.current) { event.stopPropagation(); close(); } }}>
      <motion.div data-swipe-actions className="absolute inset-y-0 right-0 flex" style={{ width, visibility: actionsShown }} inert={!isOpen} aria-hidden={!isOpen}>
        {actions.map((action, index) => <button key={index} data-swipe-control type="button" onClick={action.onPress} className={cn("mobile-press flex min-h-11 w-[132px] items-center justify-center px-3 text-center text-[14px] font-semibold", action.danger ? "bg-danger text-app" : "bg-composer text-ink")}>{action.label}</button>)}
      </motion.div>
      <motion.div style={{ x }} className="relative flex items-center bg-menu" onClickCapture={(event) => { if (opened.current) { event.preventDefault(); event.stopPropagation(); settle(0); } }}>
        {onOpen ? <button type="button" onClick={onOpen} className="mobile-row min-h-11 min-w-0 flex-1 text-left">{children}</button> : <div className="min-w-0 flex-1">{children}</div>}
        {actions.length > 0 && <button type="button" data-swipe-control aria-label={t("mobile.routines.actions")} aria-expanded={isOpen} onClick={() => settle(isOpen ? 0 : -width)} className="mobile-press flex size-11 shrink-0 items-center justify-center rounded-full text-ink-secondary"><MoreHorizontal size={20} /></button>}
      </motion.div>
    </div>
  );
}
