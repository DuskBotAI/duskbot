import { memo, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { AnimatePresence, useIsPresent, type HTMLMotionProps } from "motion/react";

import { t } from "@/lib/i18n";
import { dialogMotion, phoneDialogMotion } from "@/lib/motion-presets";
import { phoneApp } from "@/lib/store-app";
import { flushSystemControls, wakeSystemControls } from "@/lib/system-control";
import { plainDialogText, systemDialogs } from "@/lib/system-dialog";
import { closesOnBack } from "@/mobile/Sheet";
import { confirmCancelCls, mdDangerCls, mdPrimaryCls } from "./ui/GrokDialog";
import { ScrimMotion, SheetMotion, useMotionReduced } from "./ui/SheetMotion";

export type ConfirmTone = "danger" | "neutral";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /** The way out, "Cancel" unless given. */
  cancelLabel?: string;
  tone?: ConfirmTone;
  onCancel: () => void;
  onConfirm: () => void;
  /** A gentler way to the same end, offered beside the confirm button ("Archive instead"). */
  alternative?: { label: string; onClick: () => void };
  pending?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Where it sits among open dialogs, when another one above the usual layer asked it. */
  layer?: string;
  /** A small pixel picture over the title. */
  art?: ReactNode;
  /** Its way out has finished playing after `open` turned false. */
  onClosed?: () => void;
}

/**
 * Grok's confirmation modal: Escape cancels and Tab stays inside it. A danger confirm opens on Cancel, so a stray Enter
 * cannot destroy anything; a neutral one opens on its confirm button. While pending, focus parks on the dialog.
 * Portalled to <body>: the sidebar's translate below md would become the containing block.
 */
export const ConfirmDialog = memo(function ConfirmDialog(props: ConfirmDialogProps) {
  const nativeBody = systemDialogs() ? plainDialogText(props.body) : null;
  if (nativeBody !== null && systemDialogs()) {
    return <NativeConfirmDialog {...props} message={nativeBody} />;
  }
  return <WebConfirmDialog {...props} />;
}, (prev, next) => !prev.open && !next.open);

function NativeConfirmDialog(props: ConfirmDialogProps & { message: string }) {
  const { open } = props;
  const latest = useRef(props);
  latest.current = props;
  const presented = useRef(false);

  useEffect(() => {
    if (!open) {
      presented.current = false;
      return;
    }
    if (presented.current) return;
    const dialogs = systemDialogs();
    if (!dialogs) return;
    presented.current = true;
    let alive = true;
    const { title, message, confirmLabel, cancelLabel, tone = "danger", alternative } = latest.current;
    void dialogs.alert({
      title,
      message: message.trim() || undefined,
      confirmLabel,
      cancelLabel: cancelLabel ?? t("common.cancel"),
      alternativeLabel: alternative?.label,
      tone,
    }).then((outcome) => {
      if (!alive) return;
      if (outcome === "confirm") latest.current.onConfirm();
      else if (outcome === "alternative") latest.current.alternative?.onClick();
      else latest.current.onCancel();
      latest.current.onClosed?.();
    });
    return () => { alive = false; };
  }, [open]);

  return null;
}

function WebConfirmDialog(props: ConfirmDialogProps) {
  const [mounted, setMounted] = useState(props.open);
  if (props.open && !mounted) setMounted(true);
  if (!mounted && !props.open) return null;
  return <ConfirmDialogInner {...props} />;
}

function ConfirmDialogInner(props: ConfirmDialogProps) {
  const { open, onCancel, returnFocusRef } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  const opensOn = useRef<HTMLButtonElement>(null);
  const opensOnCancel = (props.tone ?? "danger") === "danger";
  const cancelAction = useRef(onCancel);
  cancelAction.current = onCancel;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    opensOn.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelAction.current();
        return;
      }
      if (event.key === "Tab") {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
        if (!controls?.length) { event.preventDefault(); dialogRef.current?.focus(); return; }
        const first = controls[0]!;
        const last = controls[controls.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const target = opener?.isConnected && opener !== document.body ? opener : returnFocusRef?.current;
      target?.focus();
    };
  }, [open, returnFocusRef]);

  // Capture the opener above before moving focus on open or pending changes.
  useEffect(() => {
    if (!open) return;
    if (props.pending) dialogRef.current?.focus();
    else opensOn.current?.focus();
  }, [open, props.pending]);

  const reduced = useMotionReduced();
  const phone = phoneApp();
  const motion = phone ? phoneDialogMotion(reduced) : dialogMotion(reduced);
  const [opened, setOpened] = useState(open);
  useEffect(() => { if (open) setOpened(true); }, [open]);
  useEffect(() => (phone && open ? closesOnBack(() => cancelAction.current()) : undefined), [phone, open]);
  if ((!open && !opened) || typeof document === "undefined" || !document.body) return null;
  const portalRoot = phone ? (document.querySelector(".dusk-mobile") ?? document.body) : document.body;
  return createPortal(
    <AnimatePresence onExitComplete={() => { setOpened(false); if (phone) void flushSystemControls(); else wakeSystemControls(); props.onClosed?.(); }}>
      {open && (
        <ConfirmLayer key="confirm" phone={phone} layer={props.layer} onCancel={onCancel} scrim={motion.scrim}>
          <ConfirmDialogCard ref={dialogRef} confirmRef={opensOnCancel ? undefined : opensOn} cancelRef={opensOnCancel ? opensOn : undefined} animated enter={motion.sheet} {...props} />
        </ConfirmLayer>
      )}
    </AnimatePresence>,
    portalRoot,
  );
}

/** The dialog's layer, still drawn while it leaves but no longer taking presses or focus. */
function ConfirmLayer({ phone, layer, onCancel, scrim, children }: { phone: boolean; layer?: string; onCancel: () => void; scrim: HTMLMotionProps<"div">; children: ReactNode }) {
  const leaving = !useIsPresent();
  useEffect(() => {
    if (!phone) return;
    wakeSystemControls();
    return () => { void flushSystemControls(); };
  }, [phone]);
  useEffect(() => {
    if (phone && leaving) wakeSystemControls();
  }, [phone, leaving]);
  return (
    <div
      data-phone-modal-layer={phone ? "" : undefined}
      className={`fixed inset-0 ${phone ? (layer ?? "z-[85]") : (layer ?? "z-50")} flex items-center justify-center p-6`}
      inert={leaving || undefined}
      data-leaving={leaving ? "" : undefined}
      onMouseDown={(event) => !leaving && event.target === event.currentTarget && onCancel()}
      onClick={(event) => phone && !leaving && event.target === event.currentTarget && onCancel()}
    >
      <ScrimMotion aria-hidden="true" data-raw-dialog="" className="ui-dialog-scrim pointer-events-none absolute inset-0" {...scrim} />
      {children}
    </div>
  );
}

export function ConfirmDialogCard({
  ref,
  confirmRef,
  cancelRef,
  title,
  body,
  confirmLabel,
  cancelLabel = t("common.cancel"),
  tone = "danger",
  onCancel,
  onConfirm,
  alternative,
  pending = false,
  animated = false,
  enter,
  art,
}: ConfirmDialogProps & {
  ref?: React.Ref<HTMLDivElement>;
  confirmRef?: React.Ref<HTMLButtonElement>;
  cancelRef?: React.Ref<HTMLButtonElement>;
  /** eases in as bencho's modal does; a card drawn inside another surface stays put */
  animated?: boolean;
  /** the way in and out it plays, in place of the stylesheet's way in */
  enter?: HTMLMotionProps<"div">;
}) {
  const danger = tone === "danger";
  const Root = animated ? SheetMotion : "div";
  const played = animated && enter ? { ...enter, "data-raw-dialog": "" } : {};
  return (
    <Root
      {...played}
      ref={ref}
      role="alertdialog"
      tabIndex={-1}
      aria-modal="true"
      aria-busy={pending}
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-body"
      data-tone={tone}
      className="ui-dialog relative flex w-full max-w-[320px] flex-col outline-none"
    >
      <div className="flex flex-col gap-1 px-4 py-3">
        {art && <div aria-hidden="true" data-confirm-art="" className="mb-2 flex pt-1">{art}</div>}
        <h2 id="confirm-dialog-title" className="m-0 min-w-0 text-[14px] font-semibold leading-[22px] tracking-[-0.15px] text-ink">
          {title}
        </h2>
        <div id="confirm-dialog-body" className="text-[14px] leading-[22px] tracking-[-0.15px] text-ink/56 text-pretty">
          {body}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 py-3 pl-4 pr-3">
        <button ref={cancelRef} type="button" onClick={onCancel} disabled={pending} className={`${confirmCancelCls} flex-1`}>
          {cancelLabel}
        </button>
        {alternative && <button type="button" data-confirm-alternative onClick={alternative.onClick} disabled={pending}
          className={`${confirmCancelCls} flex-1`}>{alternative.label}</button>}
        <button ref={confirmRef} type="button" onClick={onConfirm} disabled={pending} className={`${danger ? mdDangerCls : mdPrimaryCls} flex-1`}>
          {confirmLabel}
        </button>
      </div>
    </Root>
  );
}

export type ConfirmRequest = Pick<ConfirmDialogProps, "title" | "body" | "confirmLabel" | "cancelLabel" | "tone" | "art" | "layer">;

/** The same dialog asked from an event handler, in place of `window.confirm`: true once confirmed, false on Cancel or
 * Escape. Mounts its own root on <body> and removes it when answered. */
export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  const dialogs = systemDialogs();
  if (dialogs) {
    const message = plainDialogText(request.body);
    if (message !== null) {
      return dialogs.alert({
        title: request.title,
        message: message.trim() || undefined,
        confirmLabel: request.confirmLabel,
        cancelLabel: request.cancelLabel ?? t("common.cancel"),
        tone: request.tone ?? "danger",
      }).then((outcome) => outcome === "confirm");
    }
  }
  if (typeof document === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const closed = () => { root.unmount(); host.remove(); };
    const answer = (value: boolean) => {
      resolve(value);
      root.render(<ConfirmDialog open={false} {...request} onCancel={() => {}} onConfirm={() => {}} onClosed={closed} />);
    };
    root.render(<ConfirmDialog open {...request} onCancel={() => answer(false)} onConfirm={() => answer(true)} />);
  });
}
