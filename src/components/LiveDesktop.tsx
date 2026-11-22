import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Hand, Loader2, Minimize2, RefreshCw, Send } from "../icons";
import type RFB from "@novnc/novnc";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/copy-text";
import { connectDesktop, copyFromDesktop, desktopSize, isPasteShortcut, keyOnDesktop, pasteOnDesktop, pointerOnDesktop, typeOnDesktop } from "@/lib/desktop-connection";
import { t } from "@/lib/i18n";
import { isMacPlatform } from "@/lib/keyboard-shortcuts";
import { PlatformContext } from "@/mobile/platform";
import { phoneApp } from "@/lib/store-app";
import { rememberScreen } from "./bot-panel/last-screen";
import { ScreenTrackpad, type RemoteInput } from "@/mobile/ScreenTrackpad";
import type { BotAvatarProps } from "./Avatar";
import { BotPointer } from "./BotPointer";
import { ComputerFullscreen } from "./ComputerFullscreen";
import { Icon } from "./Icon";
import { useLaunchFeedback } from "./launch-feedback";
import { useCaptionChrome, useDesktopCapabilities } from "./DesktopCapabilities";

type Connection = "connecting" | "connected" | "disconnected";

/** The computer the person took control of, live and drivable where they were watching it. */
export function LiveDesktop({ target, threadId, botId, bot, name, poster, expanded, onExpandedChange, onHandBack, handingBack, onUnreachable, onReadyChange, onTakeControl, onOpenPreview, onScreenSize, waking, originalViewer = false, viewOnly = false, wake = false, taking = false, asked = false }: {
  target: string;
  /** Whose pointer to draw over the screen while it is watched. */
  botId?: string;
  bot?: BotAvatarProps["bot"];
  viewOnly?: boolean;
  /** The computer is waking: the picture is asked for beside the wake and shows the moment the desktop answers. */
  wake?: boolean;
  /** Take control was asked for and the answer is on its way. */
  taking?: boolean;
  /** The bot asked for the person's hands (a sign-in): handing back reads I'm done rather than Stop. */
  asked?: boolean;
  /** What shows until the first frame: the bot waking up, never a connecting line. */
  waking?: (expanded: boolean) => ReactNode;
  /** The desktop's own size in pixels, once its first frame arrives, so the frame around it can match its shape. */
  onScreenSize?: (width: number, height: number) => void;
  onReadyChange?: (ready: boolean) => void;
  onTakeControl?: () => void;
  onOpenPreview?: () => void;
  originalViewer?: boolean;
  threadId: string;
  name: string;
  /** The last watched frame, shown until the first live one arrives. */
  poster: string | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onHandBack: () => void;
  handingBack: boolean;
  /** The desktop never came up, so the person cannot drive it. */
  onUnreachable: () => void;
}) {
  const screen = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [revival, setRevival] = useState(0);
  const identity = `${target}:${threadId}`;
  const [retryState, setRetry] = useState({ identity, attempt: 0 });
  const attempt = retryState.identity === identity ? retryState.attempt : 0;
  const reconnect = () => setRetry({ identity, attempt: attempt + 1 });
  const [text, setText] = useState("");
  const live = useRef<string | null>(null);
  const watching = useRef(viewOnly);
  watching.current = viewOnly;
  const wakeRequest = useRef(wake);
  wakeRequest.current = wake;
  const { dragProps, noDragStyle } = useCaptionChrome();
  const macInset = useDesktopCapabilities().capabilities.windowChrome === "mac-inset";
  const readyChanged = useRef(onReadyChange);
  readyChanged.current = onReadyChange;
  const unreachable = useRef(onUnreachable);
  unreachable.current = onUnreachable;
  const whose = useRef(botId);
  whose.current = botId;
  const sized = useRef(onScreenSize);
  sized.current = onScreenSize;
  const [aspect, setAspect] = useState<number | undefined>(undefined);
  const platform = useContext(PlatformContext);
  const phoneKeyboard = useRef<HTMLInputElement>(null);
  const remoteClipboard = useRef<string | null>(null);
  const [trackpadMode, setTrackpadMode] = useState(true);
  const [recenterNonce, setRecenterNonce] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const showToast = useCallback((message: string) => {
    clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 1_800);
  }, []);
  const remoteInput = useMemo<RemoteInput>(() => ({
    size: () => rfb.current && desktopSize(rfb.current),
    pointer: (x, y, mask) => { if (rfb.current) pointerOnDesktop(rfb.current, x, y, mask); },
    key: (keysym, code) => { if (rfb.current) keyOnDesktop(rfb.current, keysym, code); },
    text: (typed) => { if (rfb.current && !rfb.current.viewOnly) typeOnDesktop(rfb.current, typed); },
  }), []);

  useEffect(() => {
    const controller = new AbortController();
    let client: RFB | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    let decoded = false;
    const reportReady = readyChanged.current;
    reportReady?.(false);
    const lost = () => {
      if (controller.signal.aborted || ended) return;
      ended = true;
      reportReady?.(false);
      setConnection("disconnected");
      setText("");
      if (live.current !== identity || attempt > 0) unreachable.current();
      else if (attempt === 0) retry = setTimeout(() => setRetry({ identity, attempt: 1 }), 1_000);
    };
    setText("");
    setConnection("connecting");
    void connectDesktop(screen.current!, target, {
      threadId,
      signal: controller.signal,
      viewOnly: watching.current,
      wake: wakeRequest.current,
      events: {
        connected: () => {
          if (controller.signal.aborted) return;
          decoded = true;
          live.current = identity;
          const canvas = screen.current?.querySelector("canvas");
          if (canvas?.width && canvas.height) {
            setAspect(canvas.width / canvas.height);
            sized.current?.(canvas.width, canvas.height);
          }
          reportReady?.(true);
          setConnection("connected");
        },
        disconnected: lost,
        // in control, what the person copies on the desktop reaches their own clipboard, so pasting it back works too
        clipboard: (copied) => {
          if (copied) remoteClipboard.current = copied;
          if (copyFallback.current !== null) {
            clearTimeout(copyFallback.current);
            copyFallback.current = null;
            if (copied) void writeClipboard.current(copied, true);
            else showToastRef.current(t("desktopViewer.nothingSelected"));
            return;
          }
          if (!watching.current && copied) void writeClipboard.current(copied, false);
        },
      },
    }).then((connected) => {
      if (controller.signal.aborted) return connected.disconnect();
      client = connected;
      rfb.current = connected;
      connected.viewOnly = watching.current || !decoded;
      connected.focusOnClick = !connected.viewOnly;
    }, () => { if (!controller.signal.aborted) lost(); });
    const disconnect = () => {
      // on the phone its view comes back often (a tab, the sheet): it starts again on the last picture, not an empty frame
      const owner = whose.current;
      if (decoded && owner && phoneApp()) {
        try { rememberScreen(owner, threadId, screen.current?.querySelector("canvas")?.toDataURL("image/jpeg", 0.8)); } catch { /* a canvas it cannot read */ }
      }
      setText("");
      reportReady?.(false);
      controller.abort();
      clearTimeout(retry);
      client?.disconnect();
    };
    const restore = (event: PageTransitionEvent) => { if (event.persisted) setRevival(value => value + 1); };
    window.addEventListener("pagehide", disconnect);
    window.addEventListener("pageshow", restore);
    return () => {
      disconnect();
      window.removeEventListener("pagehide", disconnect);
      window.removeEventListener("pageshow", restore);
      if (rfb.current === client) rfb.current = null;
    };
  }, [target, threadId, identity, attempt, revival]);

  useLayoutEffect(() => {
    const client = rfb.current;
    if (!client) return;
    client.viewOnly = viewOnly || connection !== "connected";
    client.focusOnClick = !client.viewOnly;
    if (connection === "connected" && !viewOnly) client.focus({ preventScroll: true });
  }, [expanded, connection, viewOnly]);

  useEffect(() => { if (viewOnly) setText(""); }, [viewOnly]);

  // the person's paste shortcut pastes their clipboard into the desktop instead of reaching the guest as Alt+V or Ctrl+V
  useEffect(() => {
    const element = screen.current;
    if (!element || viewOnly || connection !== "connected") return;
    const mac = isMacPlatform();
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const send = (text: string) => { if (rfb.current) pasteOnDesktop(rfb.current, text); };
    const keydown = (event: KeyboardEvent) => {
      if (!isPasteShortcut(event, mac)) return;
      // noVNC must not see it, so the browser's own paste follows with the text; no paste event means reading it directly
      event.stopPropagation();
      clearTimeout(fallback);
      fallback = setTimeout(() => void navigator.clipboard?.readText().then(send, () => {}), 150);
    };
    const paste = (event: ClipboardEvent) => {
      if (!element.contains(document.activeElement)) return;
      clearTimeout(fallback);
      event.preventDefault();
      send(event.clipboardData?.getData("text/plain") ?? "");
    };
    element.addEventListener("keydown", keydown, true);
    document.addEventListener("paste", paste, true);
    return () => {
      clearTimeout(fallback);
      element.removeEventListener("keydown", keydown, true);
      document.removeEventListener("paste", paste, true);
    };
  }, [viewOnly, connection]);

  const label = t("computer.viewerTitle", { name });
  const pill = (
    <span className="pointer-events-none flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm">
      <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
      {t(viewOnly ? "computer.watching" : "computer.inControl")}
    </span>
  );
  const iconButton = "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";

  const typingForm = (
    <form style={noDragStyle} className="ml-auto flex min-w-0 items-center gap-1" onSubmit={(event) => {
      event.preventDefault();
      if (viewOnly || !rfb.current || connection !== "connected" || !text) return;
      typeOnDesktop(rfb.current, text);
      setText("");
    }}>
      <input value={text} onChange={(event) => setText(event.target.value)} maxLength={4096}
        autoComplete="off" autoCapitalize="off" spellCheck={false}
        placeholder={t("desktopViewer.text")} aria-label={t("desktopViewer.text")}
        className={cn("min-w-0 rounded-lg border border-transparent bg-inset px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-focus", "w-44 max-sm:w-28")} />
      <button type="submit" disabled={connection !== "connected" || !text} title={t("desktopViewer.send")} aria-label={t("desktopViewer.send")} className={cn(iconButton, "bg-control text-ink hover:bg-raised-hover")}>
        <Send size={14} aria-hidden="true" />
      </button>
    </form>
  );

  const launching = useLaunchFeedback(screen, !viewOnly && connection === "connected");
  const phoneTrackpad = Boolean(platform) && originalViewer && expanded && !viewOnly && connection === "connected";

  const handlePhoneKeyboard = useCallback(() => {
    const field = phoneKeyboard.current;
    if (!field) return;
    if (document.activeElement === field) {
      field.blur();
      platform?.hideKeyboard?.();
    } else {
      field.focus({ preventScroll: true });
    }
  }, [platform]);

  const handlePasteFromPhone = useCallback(async (provided?: string) => {
    const client = rfb.current;
    if (!client || viewOnly) return;
    const clip = provided !== undefined ? provided : await platform?.readClipboard?.().catch(() => null);
    if (!clip) {
      showToast(t("desktopViewer.clipboardEmpty"));
      return;
    }
    pasteOnDesktop(client, clip);
    showToast(t("desktopViewer.pasted"));
  }, [platform, showToast, viewOnly]);

  const copyFallback = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const writeClipboard = useRef(async (_value: string, _announce: boolean) => {});
  writeClipboard.current = async (value: string, announce: boolean) => {
    const ok = platform?.writeClipboard
      ? await platform.writeClipboard(value).catch(() => false)
      : (await copyText(value)) === "copied";
    if (announce && ok) showToast(t("desktopViewer.copiedToPhone"));
  };
  useEffect(() => () => { if (copyFallback.current !== null) clearTimeout(copyFallback.current); }, []);

  const handleCopyToPhone = useCallback(() => {
    const client = rfb.current;
    if (!client || viewOnly) return;
    copyFromDesktop(client);
    if (copyFallback.current !== null) clearTimeout(copyFallback.current);
    copyFallback.current = setTimeout(() => {
      copyFallback.current = null;
      if (remoteClipboard.current) void writeClipboard.current(remoteClipboard.current, true);
      else showToast(t("desktopViewer.nothingSelected"));
    }, 350);
  }, [showToast, viewOnly]);

  const desktopFrame = (
      <div className={cn("relative h-full w-full overflow-hidden", expanded ? "bg-black" : "bg-inset")}>
        {poster && connection !== "connected" && (
          <img src={poster} alt="" aria-hidden="true" className={cn("absolute inset-0 h-full w-full object-contain", !phoneApp() && "opacity-50")} />
        )}
        <div ref={screen} role="application" aria-label={label} data-live-desktop-screen="" data-watching={viewOnly ? "" : undefined} className="absolute inset-0" />
        {botId && viewOnly && connection === "connected" && <BotPointer host={screen} botId={botId} />}
        {phoneTrackpad && <ScreenTrackpad screen={screen} input={remoteInput} keyboard={phoneKeyboard} haptic={platform?.haptic} label={label} mode={trackpadMode ? "trackpad" : "direct"} recenterNonce={recenterNonce} />}
        {launching && (
          <span data-launch-spinner="" aria-hidden="true" className="pointer-events-none absolute z-[3] size-7 -translate-x-1/2 -translate-y-1/2" style={{ left: launching.x, top: launching.y }}>
            <span className="absolute inset-0 rounded-full border-2 border-white/25 border-t-white/90 drop-shadow-[0_0_2px_rgb(0_0_0/0.6)] motion-safe:animate-spin" />
          </span>
        )}
        {viewOnly && (originalViewer ? !expanded && onOpenPreview : onTakeControl) && (
          <button type="button" data-panel-action={originalViewer ? "open-computer" : undefined} aria-label={originalViewer ? t("computer.open") : t("computer.takeControl")}
            title={originalViewer ? t("computer.open") : t("computer.takeControl")}
            onClick={originalViewer ? onOpenPreview : onTakeControl} disabled={!originalViewer && connection !== "connected"}
            className="group/screen absolute inset-0 flex cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-wait">
            {originalViewer && <span data-panel-open-pill="" aria-hidden="true" className="pointer-events-none relative z-[2] inline-flex items-center gap-1.5 rounded-full bg-[rgb(0_0_0/0.9)] px-2.5 py-2 text-[13px] font-medium leading-4 tracking-[0.01em] text-white opacity-0 transition-opacity duration-[120ms] ease-out group-hover/screen:opacity-100 group-focus-within/screen:opacity-100 touch:opacity-100">
              <Icon name="arrows-expand-simple" size={12} />{t("computer.open")}
            </span>}
          </button>
        )}
        {connection === "connecting" && waking?.(expanded)}
        {connection === "disconnected" && (
          <div role="alert" className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 bg-card/95 p-3 text-center text-[12px] text-ink-secondary">
            <span>{t("desktopViewer.disconnected")}</span>
            <button type="button" onClick={reconnect} className="flex items-center gap-1.5 rounded-md bg-control px-3 py-1.5 text-ink hover:bg-raised-hover">
              <RefreshCw size={13} aria-hidden="true" />
              {t("desktopViewer.reconnect")}
            </button>
          </div>
        )}
      </div>
  );
  if (originalViewer) return (
    <div data-live-desktop="" data-state={connection} data-view-only={viewOnly ? "true" : undefined}
      data-expanded={expanded ? "true" : undefined} className="relative h-full w-full">
      <ComputerFullscreen
        embedded
        expanded={expanded}
        label={label}
        bot={bot}
        name={name}
        aspect={aspect}
        connecting={Boolean(platform) && connection === "connecting"}
        toast={toast}
        onExit={() => onExpandedChange(false)}
        onKeyboard={phoneTrackpad ? handlePhoneKeyboard : undefined}
        trackpadMode={trackpadMode}
        onToggleTrackpad={phoneTrackpad ? () => setTrackpadMode((on) => !on) : undefined}
        onRecenterPointer={phoneTrackpad ? () => setRecenterNonce((n) => n + 1) : undefined}
        onPasteFromPhone={phoneTrackpad ? (text) => void handlePasteFromPhone(text) : undefined}
        onCopyToPhone={phoneTrackpad ? handleCopyToPhone : undefined}
        frame={desktopFrame}
        note={null}
        control={viewOnly
          ? { held: false, onTake: onTakeControl, busy: connection !== "connected" || handingBack || taking, pending: taking }
          : { held: true, onDone: onHandBack, asked, busy: handingBack }}
      />
    </div>
  );

  return (
    <div
      data-live-desktop
      data-state={connection}
      data-view-only={viewOnly ? "true" : undefined}
      data-expanded={expanded ? "true" : undefined}
      className={cn(expanded ? "fixed inset-0 z-[65] flex flex-col bg-app" : "relative h-full w-full")}
      onKeyDown={(event) => {
        if (expanded && event.key === "Escape" && !(event.target instanceof HTMLCanvasElement)) onExpandedChange(false);
      }}
    >
      {expanded && (
        <header {...dragProps} className={cn("flex shrink-0 flex-wrap items-center gap-2 border-b border-transparent bg-panel pb-2 pt-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+8px)] pe-[calc(var(--safe-area-inset-right,env(safe-area-inset-right,0px))+12px)]", macInset ? "pl-[86px]" : "ps-[calc(var(--safe-area-inset-left,env(safe-area-inset-left,0px))+12px)]")}>
          <span className="min-w-0 truncate text-[13px] font-medium text-ink">{label}</span>
          {!viewOnly && pill}
          {viewOnly && onTakeControl && <button type="button" style={noDragStyle} onClick={onTakeControl} disabled={connection !== "connected"} className={cn(iconButton, "ml-auto bg-control text-ink hover:bg-raised-hover")}>{t("computer.takeControl")}</button>}
          {!viewOnly && typingForm}
          <button type="button" style={noDragStyle} onClick={() => onExpandedChange(false)} className={cn(iconButton, "bg-control text-ink hover:bg-raised-hover")}>
            <Minimize2 size={14} aria-hidden="true" />
            <span className="max-sm:hidden">{t("desktopViewer.exitFullscreen")}</span>
          </button>
          {!viewOnly && <button type="button" style={noDragStyle} onClick={onHandBack} disabled={handingBack} className={cn(iconButton, "bg-accent font-medium text-accent-ink hover:brightness-110")}>
            {handingBack ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Hand size={14} aria-hidden="true" />}
            {t("computer.handBack")}
          </button>}
        </header>
      )}
      {desktopFrame}
    </div>
  );
}
