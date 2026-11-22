import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  Check, ChevronLeft, ChevronsUpDown, ClipboardList, Copy, CornerUpLeft, Crosshair, Eye, Keyboard, Loader2,
  MoreHorizontal, MousePointer2, ZoomIn,
} from "../icons";
import { BotAvatar, type BotAvatarProps } from "@/components/Avatar";
import type { ScreenControl } from "@/components/ComputerFullscreen";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { keyboardInset } from "@/lib/phone-viewport";
import { readSkinChoice, THEME_SKINS } from "@/lib/skins";
import { haptic } from "./haptics";
import { frameOf, safeInsetPx, useGlassPill, type TakeoverGlassButton, type TakeoverGlassButtonId, type TakeoverGlassMenuItem, type TakeoverGlassState } from "./native-glass";
import type { MobilePlatform, SystemMenuAction } from "./platform";
import { closesOnBack, Sheet } from "./Sheet";
import { SettingsRow, SettingsSection } from "./sheets/SettingsRow";

export interface TakeoverMenuItem extends SystemMenuAction {
  onSelect: (text?: string) => void;
  icon?: ReactNode;
}

const SPOKES = [0, 45, 90, 135, 180, 225, 270, 315] as const;

export function IosActivitySpinner({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="takeover-spinner text-white">
      {SPOKES.map((angle, index) => (
        <rect
          key={angle}
          x="10.85"
          y="2"
          width="2.3"
          height="6.2"
          rx="1.15"
          fill="currentColor"
          opacity={0.22 + (index / SPOKES.length) * 0.78}
          transform={`rotate(${angle} 12 12)`}
        />
      ))}
    </svg>
  );
}

function QuestionGlyph() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
      <circle cx="12" cy="17.2" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function RightClickGlyph() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="5" cy="7" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="5" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="5" cy="17" r="1.1" fill="currentColor" stroke="none" />
      <path d="M9.5 7h9.5M9.5 12h9.5M9.5 17h9.5" />
    </svg>
  );
}

function TrackpadGlyph() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-5" />
      <circle cx="18.5" cy="5.5" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function useViewerKeyboardHeight(platform: MobilePlatform): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (platform.onKeyboard) {
      return platform.onKeyboard((frame) => {
        if (frame.lift !== undefined) return;
        setHeight(frame.height > 0 ? frame.height : 0);
      });
    }
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => setHeight(keyboardInset(window.innerHeight, vv));
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, [platform]);
  return height;
}

const circleGlass = "takeover-glass pointer-events-auto inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/75 disabled:opacity-45";

function TakeoverControlButton({ control, hint, compact = false }: {
  control: ScreenControl;
  hint: { count: number; shown: boolean };
  compact?: boolean;
}) {
  const action = control.held ? control.onDone : control.onTake;
  const label = controlTitle(control);
  const status = control.held ? t("computer.inControl") : t("computer.watching");

  return (
    <div
      data-computer-control={control.held ? "held" : "watching"}
      data-compact={compact ? "" : undefined}
      className="pointer-events-auto relative inline-flex items-center"
    >
      <span aria-live="polite" className="sr-only">
        {status}
        {hint.shown ? ` ${t("computer.takeControlHint")}` : ""}
      </span>
      {!control.held && (
        <span
          key={hint.count}
          aria-hidden="true"
          data-computer-hint={hint.shown ? "" : undefined}
          className={cn(
            "pointer-events-none absolute inset-0 rounded-full opacity-0 shadow-[0_0_0_3px_rgb(255_255_255/0.24),0_0_16px_3px_rgb(255_255_255/0.18)]",
            hint.shown && "computer-watch-hint",
          )}
        />
      )}
      {action ? (
        <button
          type="button"
          onClick={() => { haptic("tap"); action(); }}
          disabled={control.busy}
          aria-busy={control.busy || undefined}
          data-takeover-glass="control"
          className={cn(
            "takeover-glass relative inline-flex cursor-pointer items-center justify-center rounded-full font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/75 disabled:cursor-wait disabled:opacity-55",
            compact ? "min-h-9 px-3 text-[13px] leading-[18px]" : "h-11 px-[18px] text-[15px] leading-5",
          )}
        >
          <span className={cn(!control.held && control.pending && "invisible")}>{label}</span>
          {!control.held && control.pending && (
            <span data-computer-taking="" aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
              <Loader2 size={15} className="animate-spin motion-reduce:animate-none" />
            </span>
          )}
        </button>
      ) : (
        <span data-takeover-glass="control" className={cn("takeover-glass inline-flex items-center rounded-full font-medium text-white/75", compact ? "min-h-9 px-3 text-[13px]" : "h-11 px-[18px] text-[15px]")}>
          {status}
        </span>
      )}
    </div>
  );
}

function FallbackMenuPopover({ items, placement, onClose, testId }: {
  items: readonly TakeoverMenuItem[];
  placement: "top-right" | "bottom-left";
  onClose: () => void;
  testId: string;
}) {
  return (
    <div className="fixed inset-0 z-[75]" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        role="menu"
        data-takeover-menu={testId}
        className={cn(
          "takeover-glass absolute min-w-[228px] max-w-[280px] overflow-hidden rounded-[22px] p-1.5 text-white",
          placement === "top-right"
            ? "right-4 top-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+58px)]"
            : "bottom-[calc(max(var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)),16px)+58px)] left-4",
        )}
      >
        {items.map((item, index) => (
          <div key={item.key}>
            {item.separated && index > 0 && <div className="my-1 h-px bg-white/10" role="separator" />}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => { onClose(); item.onSelect(); }}
              className="flex min-h-11 w-full items-center gap-3 rounded-[16px] px-3 py-2 text-left text-[15px] leading-5 text-white active:bg-white/12 disabled:opacity-40"
            >
              <span className="flex w-4 shrink-0 items-center justify-center text-white/90" aria-hidden="true">
                {item.checked ? <Check size={15} strokeWidth={2.4} /> : null}
              </span>
              {item.icon && <span className="flex shrink-0 items-center text-white/90" aria-hidden="true">{item.icon}</span>}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

interface HelpRow {
  icon: ReactNode;
  title: string;
  body: string;
}

interface HelpSection {
  heading: string;
  rows: readonly HelpRow[];
}

function buildHelpSections(): readonly HelpSection[] {
  return [
    {
      heading: t("desktopViewer.help.movingAround"),
      rows: [
        { icon: <Eye />, title: t("desktopViewer.help.takeControlTitle"), body: t("desktopViewer.help.takeControlBody") },
        { icon: <ChevronsUpDown />, title: t("desktopViewer.help.scrollTitle"), body: t("desktopViewer.help.scrollBody") },
        { icon: <MousePointer2 />, title: t("desktopViewer.help.clickDragTitle"), body: t("desktopViewer.help.clickDragBody") },
        { icon: <RightClickGlyph />, title: t("desktopViewer.help.rightClickTitle"), body: t("desktopViewer.help.rightClickBody") },
        { icon: <ZoomIn />, title: t("desktopViewer.help.zoomInTitle"), body: t("desktopViewer.help.zoomInBody") },
      ],
    },
    {
      heading: t("desktopViewer.help.typingClipboard"),
      rows: [
        { icon: <Keyboard />, title: t("desktopViewer.help.typeTitle"), body: t("desktopViewer.help.typeBody") },
        { icon: <ClipboardList />, title: t("desktopViewer.help.copyPasteTitle"), body: t("desktopViewer.help.copyPasteBody") },
      ],
    },
    {
      heading: t("desktopViewer.help.pointerEasier"),
      rows: [
        { icon: <TrackpadGlyph />, title: t("desktopViewer.help.trackpadTitle"), body: t("desktopViewer.help.trackpadBody") },
      ],
    },
    {
      heading: t("desktopViewer.help.handingBack"),
      rows: [
        { icon: <CornerUpLeft />, title: t("desktopViewer.help.doneTitle"), body: t("desktopViewer.help.doneBody") },
      ],
    },
  ];
}

export function UsingComputerHelpSheet({ open = true, onClose }: { open?: boolean; onClose: () => void }) {
  const sections = buildHelpSections();
  return (
    <Sheet open={open} onClose={onClose} title={t("desktopViewer.help")} full layerClassName="z-[80]">
      <div data-takeover-help-sheet="" className="pb-6">
        {sections.map((section) => (
          <SettingsSection key={section.heading} card title={section.heading}>
            {section.rows.map((row) => (
              <SettingsRow key={row.title} icon={row.icon} label={row.title} detail={row.body} chevron={false} />
            ))}
          </SettingsSection>
        ))}
      </div>
    </Sheet>
  );
}

function toNativeMenu(items: readonly TakeoverMenuItem[]): TakeoverGlassMenuItem[] {
  return items.map(({ onSelect: _onSelect, icon: _icon, ...action }) => action);
}

function restoreAppearance(platform: MobilePlatform): void {
  const skin = readSkinChoice();
  const dark = document.documentElement.dataset.skin === THEME_SKINS.dark;
  platform.setStatusBar?.(dark ? "light" : "dark");
  platform.setAppearance?.(skin === THEME_SKINS.dark ? "dark" : skin === THEME_SKINS.light ? "light" : "system");
}

function controlTitle(control: ScreenControl): string {
  const action = control.held ? control.onDone : control.onTake;
  if (!action) return control.held ? t("computer.inControl") : t("computer.watching");
  return control.held ? (control.asked ? t("computer.done") : t("computer.stopControl")) : t("computer.takeControl");
}

export function PhoneTakeoverShell({
  boxRef,
  label,
  bot,
  name,
  platform,
  landscape,
  onExit,
  frame,
  note,
  connecting = false,
  connectingText,
  control,
  watchHint,
  onFramePointerDown,
  alert,
  toast,
  onKeyboard,
  trackpadMode = false,
  onToggleTrackpad,
  onRecenterPointer,
  onPasteFromPhone,
  onCopyToPhone,
  extraMenuItems,
  aspect = 16 / 10,
  edgeToEdge = false,
}: {
  boxRef?: RefObject<HTMLDivElement | null>;
  label: string;
  bot?: BotAvatarProps["bot"];
  name?: string;
  platform: MobilePlatform;
  landscape: boolean;
  onExit: () => void;
  frame: ReactNode;
  note?: ReactNode;
  connecting?: boolean;
  connectingText?: string;
  control: ScreenControl | null;
  watchHint: { count: number; shown: boolean };
  onFramePointerDown?: () => void;
  alert?: string | null;
  toast?: string | null;
  onKeyboard?: () => void;
  trackpadMode?: boolean;
  onToggleTrackpad?: () => void;
  onRecenterPointer?: () => void;
  onPasteFromPhone?: (text?: string) => void;
  onCopyToPhone?: () => void;
  extraMenuItems?: readonly TakeoverMenuItem[];
  aspect?: number;
  edgeToEdge?: boolean;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [fallbackMenu, setFallbackMenu] = useState<"more" | "clipboard" | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const setShellEl = useCallback((node: HTMLDivElement | null) => {
    shellRef.current = node;
    if (boxRef) boxRef.current = node;
  }, [boxRef]);
  const moreRef = useRef<HTMLButtonElement>(null);
  const clipboardRef = useRef<HTMLButtonElement>(null);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const helpOpenRef = useRef(helpOpen);
  helpOpenRef.current = helpOpen;
  const kbHeight = useViewerKeyboardHeight(platform);

  const openHelp = useCallback(() => {
    haptic("tap");
    setHelpOpen(true);
  }, []);

  useEffect(() => {
    if (helpOpen) restoreAppearance(platform);
    else {
      platform.setStatusBar?.("light");
      platform.setAppearance?.("dark");
    }
  }, [helpOpen, platform]);

  useEffect(() => {
    platform.orientation?.allowLandscape(true);
    const unback = platform.onBack?.(() => {
      if (helpOpenRef.current) { setHelpOpen(false); return true; }
      exitRef.current();
      return true;
    });
    const unlayer = closesOnBack(() => exitRef.current());
    return () => {
      unlayer();
      unback?.();
      platform.orientation?.allowLandscape(false);
      restoreAppearance(platform);
    };
  }, [platform]);

  const moreItems: TakeoverMenuItem[] = [
    ...(onToggleTrackpad ? [{
      key: "trackpad",
      label: t("desktopViewer.trackpadMode"),
      symbol: "cursorarrow",
      checked: trackpadMode,
      icon: <MousePointer2 size={16} />,
      onSelect: onToggleTrackpad,
    }] : []),
    ...(onRecenterPointer ? [{
      key: "recenter",
      label: t("desktopViewer.recenterPointer"),
      symbol: "scope",
      disabled: !trackpadMode,
      icon: <Crosshair size={16} />,
      onSelect: onRecenterPointer,
    }] : []),
    ...(extraMenuItems ?? []),
  ];

  const clipboardItems: TakeoverMenuItem[] = [
    ...(onPasteFromPhone ? [{
      key: "paste",
      label: t("desktopViewer.pasteFromPhone"),
      symbol: "doc.on.clipboard",
      icon: <ClipboardList size={16} />,
      onSelect: onPasteFromPhone,
    }] : []),
    ...(onCopyToPhone ? [{
      key: "copy",
      label: t("desktopViewer.copyToPhone"),
      symbol: "doc.on.doc",
      icon: <Copy size={16} />,
      onSelect: onCopyToPhone,
    }] : []),
  ];

  const openMenu = async (kind: "more" | "clipboard", button: HTMLButtonElement | null, items: readonly TakeoverMenuItem[]) => {
    if (!items.length) return;
    haptic("tap");
    if (platform.showMenu && button) {
      const rect = button.getBoundingClientRect();
      const picked = await platform.showMenu(
        { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        toNativeMenu(items),
      );
      if (picked) items.find((item) => item.key === picked)?.onSelect();
      return;
    }
    setFallbackMenu((current) => (current === kind ? null : kind));
  };

  const displayName = bot?.name ?? name ?? "";
  const sideControl = landscape && Boolean(control);
  const backLabel = t("common.back");
  const helpLabel = t("desktopViewer.help");
  const moreLabel = t("desktopViewer.more");
  const clipboardLabel = t("desktopViewer.clipboard");
  const keyboardLabel = t("desktopViewer.keyboard");

  const glassInput = {
    control,
    landscape,
    kbHeight,
    helpOpen,
    fallbackMenu,
    moreItems,
    clipboardItems,
    onKeyboard,
    onExit,
    openHelp,
    backLabel,
    helpLabel,
    moreLabel,
    clipboardLabel,
    keyboardLabel,
  };
  const glassInputRef = useRef(glassInput);
  glassInputRef.current = glassInput;
  const triggerGlassSyncRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const glass = platform.glass;
    if (!glass?.takeover) return;
    const html = document.documentElement;
    let frame = 0;
    let fresh = 20;
    let count = 0;
    let last = "";

    const buildState = (): TakeoverGlassState | null => {
      const root = shellRef.current;
      const current = glassInputRef.current;
      if (!root || current.helpOpen || current.fallbackMenu !== null || document.querySelector(".mobile-sheet-layer")) return null;
      const buttons: TakeoverGlassButton[] = [];
      const add = (id: TakeoverGlassButtonId, spec: Omit<TakeoverGlassButton, "id" | "frame">) => {
        const el = root.querySelector<HTMLElement>(`[data-takeover-glass="${id}"]`);
        if (!el) return;
        const rect = frameOf(el);
        if (rect.w <= 0 || rect.h <= 0) return;
        buttons.push({ id, frame: rect, ...spec });
      };
      add("back", { label: current.backLabel, symbol: "chevron.left", symbolSize: 17, symbolWeight: "semibold" });
      add("help", { label: current.helpLabel, symbol: "questionmark", symbolSize: 17, symbolWeight: "semibold" });
      if (current.moreItems.length > 0) {
        add("more", {
          label: current.moreLabel,
          symbol: "ellipsis",
          symbolSize: 17,
          symbolWeight: "semibold",
          menu: toNativeMenu(current.moreItems),
        });
      }
      if (current.clipboardItems.length > 0) {
        add("clipboard", {
          label: current.clipboardLabel,
          symbol: "list.clipboard",
          symbolSize: 17,
          symbolWeight: "medium",
          menu: toNativeMenu(current.clipboardItems),
        });
      }
      if (current.control) {
        const c = current.control;
        const action = c.held ? c.onDone : c.onTake;
        const title = controlTitle(c);
        add("control", {
          label: title,
          title,
          compact: current.landscape,
          disabled: Boolean(c.busy),
          busy: Boolean(!c.held && c.pending),
          interactive: Boolean(action),
        });
      }
      if (current.onKeyboard) {
        add("keyboard", { label: current.keyboardLabel, symbol: "keyboard", symbolSize: 17, symbolWeight: "medium" });
      }
      return buttons.length ? { buttons } : null;
    };

    const sync = () => {
      const next = buildState();
      const key = JSON.stringify(next);
      if (key === last) return;
      last = key;
      if (next) html.dataset.nativeGlassTakeover = "";
      else delete html.dataset.nativeGlassTakeover;
      glass.takeover!(next);
    };

    const wake = () => {
      fresh = 20;
      sync();
    };
    triggerGlassSyncRef.current = wake;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (document.hidden) return;
      count += 1;
      if (fresh > 0) fresh -= 1;
      else if (count % 15 !== 0) return;
      sync();
    };

    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(wake) : null;
    if (shellRef.current) resizeObserver?.observe(shellRef.current);
    window.addEventListener("resize", wake);
    const stop = glass.onEvent((event) => {
      const current = glassInputRef.current;
      if (event.type === "takeoverTap") {
        switch (event.target) {
          case "back": haptic("back"); current.onExit(); break;
          case "help": current.openHelp(); break;
          case "control": {
            const action = current.control?.held ? current.control.onDone : current.control?.onTake;
            if (action && !current.control?.busy) { haptic("tap"); action(); }
            break;
          }
          case "keyboard":
            if (current.onKeyboard) { haptic("tap"); current.onKeyboard(); }
            break;
        }
      } else if (event.type === "takeoverMenu") {
        const items = event.target === "more" ? current.moreItems : event.target === "clipboard" ? current.clipboardItems : [];
        items.find((item) => item.key === event.key)?.onSelect(event.text);
      }
    });

    sync();
    frame = requestAnimationFrame(tick);
    return () => {
      triggerGlassSyncRef.current = null;
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", wake);
      stop();
      delete html.dataset.nativeGlassTakeover;
      glass.takeover!(null);
    };
  }, [platform]);

  useEffect(() => {
    triggerGlassSyncRef.current?.();
  });

  const takeoverPillOffset = (() => {
    if (landscape) return 18;
    const bar = shellRef.current?.querySelector<HTMLElement>("[data-takeover-bottom-bar]");
    if (bar) {
      const top = bar.getBoundingClientRect().top;
      if (top > 0 && top < window.innerHeight) return Math.max(18, Math.round(window.innerHeight - top + 12));
    }
    return Math.round(safeInsetPx("bottom") + kbHeight + 74);
  })();
  const pillText = !helpOpen ? (alert || toast || null) : null;
  const nativeTakeoverPill = useGlassPill(
    platform.glass,
    "bottom",
    pillText
      ? {
          id: alert ? "takeover-alert" : "takeover-toast",
          text: pillText,
          tone: alert ? "error" : "success",
          symbol: alert ? "exclamationmark.circle.fill" : "checkmark",
          offset: takeoverPillOffset,
          dark: true,
        }
      : null,
  );

  const backButton = (
    <button type="button" onClick={() => { haptic("back"); onExit(); }} aria-label={backLabel} title={backLabel} data-computer-exit="" data-takeover-glass="back" className={circleGlass}>
      <ChevronLeft size={22} strokeWidth={2} />
    </button>
  );
  const helpButton = (
    <button type="button" onClick={openHelp} aria-label={helpLabel} title={helpLabel} data-takeover-help="" data-takeover-glass="help" className={circleGlass}>
      <QuestionGlyph />
    </button>
  );
  const moreButton = moreItems.length > 0 && (
    <button ref={moreRef} type="button" onClick={() => void openMenu("more", moreRef.current, moreItems)} aria-label={moreLabel} title={moreLabel} data-takeover-more="" data-takeover-glass="more" className={circleGlass}>
      <MoreHorizontal size={20} />
    </button>
  );
  const clipboardButton = clipboardItems.length > 0 && (
    <button ref={clipboardRef} type="button" onClick={() => void openMenu("clipboard", clipboardRef.current, clipboardItems)} aria-label={clipboardLabel} title={clipboardLabel} data-takeover-clipboard="" data-takeover-glass="clipboard" className={circleGlass}>
      <ClipboardList size={19} />
    </button>
  );
  const keyboardButton = onKeyboard && (
    <button type="button" onClick={() => { haptic("tap"); onKeyboard(); }} aria-label={keyboardLabel} title={keyboardLabel} data-computer-keyboard="" data-takeover-glass="keyboard" className={circleGlass}>
      <Keyboard size={19} />
    </button>
  );

  return (
    <div
      ref={setShellEl}
      role="dialog"
      aria-modal={true}
      aria-label={label}
      tabIndex={-1}
      data-computer-fullscreen=""
      data-phone-takeover=""
      style={kbHeight > 0 ? { paddingBottom: kbHeight } : undefined}
      className="fixed inset-0 z-[70] flex flex-col bg-black text-white outline-none"
    >
      {landscape ? (
        <div
          data-computer-phone-bar=""
          className="pointer-events-none absolute inset-y-0 left-[var(--safe-area-inset-left,env(safe-area-inset-left,0px))] right-[var(--safe-area-inset-right,env(safe-area-inset-right,0px))] z-10 flex items-start justify-between px-2 py-2"
        >
          {backButton}
          <div className="flex flex-col items-end gap-2 self-stretch">
            <div className="flex items-center gap-2">
              {helpButton}
              {moreButton}
              {clipboardButton}
              {keyboardButton}
            </div>
            {sideControl && control && (
              <div data-computer-side-control="" className="mt-auto pb-1">
                <TakeoverControlButton control={control} hint={watchHint} compact />
              </div>
            )}
          </div>
        </div>
      ) : (
        <header
          data-computer-phone-bar=""
          className="relative z-10 flex shrink-0 items-center justify-between px-4 pb-2 pt-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+6px)]"
        >
          {backButton}

          {(bot || displayName) && (
            <div data-takeover-identity="" className="pointer-events-none absolute inset-x-[112px] bottom-2 flex h-11 items-center justify-center gap-2">
              {bot && <BotAvatar bot={bot} size={24} animated={false} trackPointer={false} personality={false} />}
              {displayName && <span className="truncate text-[17px] font-semibold tracking-[-0.015em] text-white">{displayName}</span>}
            </div>
          )}

          <div className="flex items-center gap-2.5">
            {helpButton}
            {moreButton}
          </div>
        </header>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden [container-type:size]">
        {frame ? (
          <div
            data-computer-frame=""
            className={cn("relative overflow-hidden bg-black", edgeToEdge ? "size-full" : "")}
            style={edgeToEdge ? undefined : { width: `min(100cqw, calc(100cqh * ${aspect}))`, aspectRatio: String(aspect) }}
            onPointerDown={onFramePointerDown}
          >
            {frame}
          </div>
        ) : note ? (
          <div data-computer-note="" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">{note}</div>
        ) : null}

        {connecting && (
          <div data-takeover-connecting="" role="status" className="pointer-events-none absolute inset-0 z-[5] flex flex-col items-center justify-center gap-3 bg-black">
            <IosActivitySpinner size={24} />
            <span className="text-[15px] leading-5 text-white/85">{connectingText ?? t("desktopViewer.connectingShort")}</span>
          </div>
        )}

        {alert && (
          <p role="alert" className={cn(nativeTakeoverPill ? "sr-only" : "takeover-glass absolute inset-x-4 top-2 z-20 mx-auto w-fit max-w-[90%] rounded-full px-3.5 py-1.5 text-center text-[13px] leading-[18px] text-[#ff6961]")}>
            {alert}
          </p>
        )}

        {toast && !alert && (
          <p role="status" data-takeover-toast="" className={cn(nativeTakeoverPill ? "sr-only" : "takeover-glass pointer-events-none absolute inset-x-4 bottom-3 z-20 mx-auto w-fit max-w-[85%] rounded-full px-3.5 py-1.5 text-center text-[13px] font-medium leading-[18px] text-white/95")}>
            {toast}
          </p>
        )}
      </div>

      {!landscape && (
        <div
          data-takeover-bottom-bar=""
          className={cn(
            "relative z-10 flex shrink-0 items-center justify-between px-4 pt-2",
            kbHeight > 0 ? "pb-2.5" : "pb-[max(var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)),16px)]",
          )}
        >
          <div>{clipboardButton}</div>
          <div className="flex items-center gap-2.5">
            {control && <TakeoverControlButton control={control} hint={watchHint} />}
            {keyboardButton}
          </div>
        </div>
      )}

      {fallbackMenu === "more" && createPortal(
        <FallbackMenuPopover items={moreItems} placement="top-right" testId="more" onClose={() => setFallbackMenu(null)} />,
        document.body,
      )}
      {fallbackMenu === "clipboard" && createPortal(
        <FallbackMenuPopover items={clipboardItems} placement="bottom-left" testId="clipboard" onClose={() => setFallbackMenu(null)} />,
        document.body,
      )}
      {createPortal(
        <UsingComputerHelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} />,
        document.querySelector(".dusk-mobile") ?? document.body,
      )}
    </div>
  );
}
