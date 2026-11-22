import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { cssCurve, desktopMotion } from "@/lib/desktop-motion";
import { motionReduced, playGhostExit } from "@/lib/ghost-exit";
import { pacedMs } from "@/lib/motion-speed";
import { isGlassDark, safeInsetPx, useGlassPill } from "@/mobile/native-glass";
import { PHONE_FEEL } from "@/mobile/phone-feel";
import { PlatformContext } from "@/mobile/platform";
import { Icon } from "../Icon";
import { smallButtonCls } from "./GrokDialog";

/** Grok's bot-action toast timing: a plain line passes in 5s, one carrying Undo stays 12s. */
export const TOAST_MS = 5_000;
export const UNDO_TOAST_MS = 12_000;
/** An Undo for something deleted: shorter, and held while the pointer or focus is on it. */
export const DELETE_UNDO_MS = 8_000;

/** The one passing line, as Grok's bot-action toast: a 13px glyph (a check, or a red exclamation for an error), the words,
 * an optional small Undo, and an 18px close. Bottom centre, above the message box, there at once and gone at once. */
export function Toast({ text, tone = "done", action, onDone, timeoutMs, className, ...rest }: {
  text: ReactNode;
  tone?: "done" | "error";
  action?: { label: string; onClick: () => void; disabled?: boolean };
  onDone: () => void;
  timeoutMs?: number;
  className?: string;
  "data-notice-toast"?: string;
  "data-access-toast"?: string;
}) {
  const glass = useContext(PlatformContext)?.glass;
  const uid = useId();
  const error = tone === "error";
  const ms = timeoutMs ?? (action ? UNDO_TOAST_MS : TOAST_MS);
  const done = useRef(onDone);
  done.current = onDone;
  const actionRef = useRef(action);
  actionRef.current = action;
  const [held, setHeld] = useState(false);
  const left = useRef(ms);
  // the clock restarts only when the words change, not on every render of a caller's inline onDone
  useEffect(() => { left.current = ms; }, [ms, text]);
  useEffect(() => {
    if (held) return;
    const started = Date.now();
    const timer = window.setTimeout(() => done.current(), left.current);
    return () => {
      window.clearTimeout(timer);
      left.current = Math.max(0, left.current - (Date.now() - started));
    };
  }, [ms, text, held]);
  const node = useRef<HTMLDivElement>(null);
  const [measuredText, setMeasuredText] = useState("");
  const [offset, setOffset] = useState(96);
  useLayoutEffect(() => {
    if (!glass?.pill) return;
    if (typeof text !== "string") {
      setMeasuredText(node.current?.querySelector("[data-toast-text]")?.textContent?.trim() ?? "");
    }
    const composer = document.querySelector<HTMLElement>('.dusk-mobile [data-tour="composer"]');
    const sheetOpen = Boolean(document.querySelector(".mobile-sheet-layer"));
    const rect = !sheetOpen && composer ? composer.getBoundingClientRect() : null;
    if (rect && rect.height > 0 && rect.top < window.innerHeight) {
      setOffset(Math.max(28, Math.round(window.innerHeight - rect.top + 12)));
    } else {
      setOffset(Math.round(safeInsetPx("bottom") + 28));
    }
  }, [glass, text]);
  const pillText = typeof text === "string" ? text : measuredText;
  const nativePill = useGlassPill(
    glass,
    "bottom",
    pillText
      ? {
          id: `toast:${uid}`,
          text: pillText,
          tone: error ? "error" : "success",
          symbol: error ? "exclamationmark.circle.fill" : "checkmark",
          offset,
          dark: isGlassDark(),
          actionLabel: action?.label,
          actionDisabled: action?.disabled,
          dismissible: true,
        }
      : null,
    {
      onAction: () => actionRef.current?.onClick(),
      onDismiss: () => done.current(),
    },
  );
  useToastLeave(node, nativePill);
  const release = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false);
  };
  const toast = (
    <div ref={node} {...rest} role={error ? "alert" : "status"} aria-live={error ? "assertive" : "polite"} data-kind={tone} className={cn("ui-toast", nativePill && "pointer-events-none opacity-0", className)}
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={release}>
      <span aria-hidden="true" className={cn("inline-flex shrink-0", error ? "text-danger" : "text-ink-secondary")}>
        <Icon name={error ? "exclamation-circle" : "check"} size={13} />
      </span>
      <span data-toast-text="" className="min-w-0 flex-1 break-words">{text}</span>
      {action && <button type="button" disabled={action.disabled} onClick={action.onClick} className={smallButtonCls}>{action.label}</button>}
      <button type="button" aria-label={t("chat.error.dismiss")} onClick={onDone} className="ui-toast-close">
        <Icon name="close" size={12} />
      </button>
    </div>
  );
  return typeof document === "undefined" || !document.body ? toast : createPortal(toast, document.body);
}

/** The toast leaves the way it came, from wherever it is, as it unmounts: on the desktop at a pick with a toast motion,
 * on the phone as its feel has toasts leave. */
function useToastLeave(node: RefObject<HTMLDivElement | null>, skip = false) {
  const held = useRef<HTMLDivElement | null>(null);
  const skipRef = useRef(skip);
  skipRef.current = skip;
  useLayoutEffect(() => { held.current = node.current; });
  useLayoutEffect(() => () => {
    if (skipRef.current || motionReduced()) return;
    const exit = toastExit();
    if (!exit) return;
    playGhostExit(held.current, document.body, (ghost) => [ghost.animate(
      [{ opacity: 1, translate: "0 0", scale: "1" }, { opacity: 0, translate: `0 ${exit.y}`, scale: String(exit.scale) }],
      { duration: exit.ms, easing: cssCurve(null), fill: "forwards" },
    )]);
  }, []);
}

function toastExit(): { ms: number; y: string; scale: number } | null {
  if (document.documentElement.dataset.mobileApp) {
    const { from, outMs } = PHONE_FEEL.toast;
    return { ms: outMs, y: from === "self" ? "100%" : `${from}px`, scale: 1 };
  }
  const spec = desktopMotion().toast;
  return spec ? { ms: pacedMs(spec.leaveMs), y: spec.leaveY, scale: spec.leaveScale } : null;
}
