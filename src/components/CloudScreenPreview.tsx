import { useState } from "react";
import { Loader2, Maximize2, Monitor } from "../icons";

import { t } from "@/lib/i18n";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/** The picture's frame: a button that opens the live desktop, or a plain box while it can't be opened. */
function PictureFrame({ open, children }: { open: ButtonHTMLAttributes<HTMLButtonElement> | null; children: ReactNode }) {
  const box = "absolute inset-0 flex h-full w-full items-center justify-center";
  return open ? <button type="button" {...open} className={`group ${box} disabled:cursor-wait`}>{children}</button> : <div className={box}>{children}</div>;
}

export function CloudScreenPreview({ src, name, error, fix, starting, opening, disabled, canOpen = true, refreshing = false, retry = 0, onOpen, onRetry }: {
  src: string | null;
  name: string;
  error: string | null;
  /** The way forward when retrying can't help, offered beside Retry preview. */
  fix?: { label: string; onClick: () => void };
  starting: boolean;
  opening: boolean;
  disabled: boolean;
  /** False while the live desktop can't open: the picture is shown without its Open action. */
  canOpen?: boolean;
  refreshing?: boolean;
  retry?: number;
  onOpen: () => void;
  onRetry: (discardFrame: boolean) => void;
}) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ src: string; retry: number } | null>(null);
  const failedNow = Boolean(src && failed?.src === src && failed.retry === retry);
  const visible = Boolean(src && loaded === src && !failedNow);
  const problem = error ?? (failedNow ? t("computer.preview.imageFailed") : null);

  return (
    <div className="relative h-full w-full" aria-busy={!problem && (!visible || opening || refreshing)}>
      {src && (
        <PictureFrame open={canOpen ? {
          onClick: onOpen,
          disabled: disabled || starting || opening || !visible,
          "aria-label": t("computer.openLiveDesktopAria", { name }),
          title: t("computer.openLiveDesktop"),
        } : null}>
          <img
            key={retry}
            src={src}
            alt={t("computer.screenOf", { name })}
            onLoad={() => { setLoaded(src); setFailed(null); }}
            onError={() => setFailed({ src, retry })}
            className={`h-full w-full object-contain transition group-hover:brightness-75 ${visible ? "" : "invisible"}`}
          />
          {visible && canOpen && (
            <span className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white">
              {opening ? <Loader2 size={12} className="animate-spin" /> : <Maximize2 size={12} />}
              {opening ? t("computer.preview.connecting") : t("computer.open")}
            </span>
          )}
        </PictureFrame>
      )}
      {!visible && !problem && (
        <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-[12px] text-ink-secondary">
          <Loader2 size={18} className="animate-spin" />
          {starting ? t("computer.phase.starting") : t("computer.preview.connectingScreen")}
        </div>
      )}
      {visible && refreshing && !problem && (
        <div role="status" className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-[11px] text-white">
          <Loader2 size={12} className="animate-spin" />
          {t("computer.preview.connectingScreen")}
        </div>
      )}
      {problem && (
        <div role="alert" className={`absolute inset-x-0 flex flex-col items-center justify-center gap-2 bg-card/95 p-4 text-center text-[12px] text-ink-secondary ${visible ? "bottom-0" : "inset-y-0"}`}>
          {!visible && <Monitor size={22} />}
          <span>{visible ? t("computer.preview.paused") : t("computer.preview.cantConnect")} {problem}</span>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {fix && (
              <button type="button" onClick={fix.onClick} className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-ink hover:brightness-110">
                {fix.label}
              </button>
            )}
            <button type="button" onClick={() => onRetry(!visible)} className="rounded-md bg-control px-3 py-1.5 text-ink hover:bg-raised-hover">
              {t("computer.preview.retry")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
