import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw } from "../icons";
import { resolveAddressBarInput } from "@/lib/browser-address";
import { createBrowserControl, type BrowserControl } from "@/lib/browser-control";
import {
  browserStreamAccess, createPreviewStreamClient, type PreviewStreamClient, type PreviewStreamControl,
  type PreviewStreamInput, type PreviewStreamMouseButton,
} from "@/lib/browser-stream-client";
import { createLiveStreamClient, type LiveResume, type LiveStreamClient } from "@/lib/browser-stream-v1";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { blankPage } from "@/lib/local-browser";
import { friendlyError } from "@/lib/plain-error";
import { answerSignIn } from "@/lib/sign-in";
import { systemDialogs } from "@/lib/system-dialog";
import { browserScope, withBrowserScope } from "@/lib/team-browser";
import { api, useStore, type Bot } from "@/state/store";
import type { BrowserNav } from "@/components/browser/ChromeRow";
import { StreamSurface, type StreamSurfaceHandle, type SurfaceConnect } from "@/components/browser/StreamSurface";
import { START_PAGE } from "@/components/bot-panel/LocalBrowser";
import { tabName, type StripTab } from "@/components/bot-panel/browser-strip";
import { BROWSER_HELD_ELSEWHERE } from "../../shared/browser-held";
import { haptic } from "./haptics";
import { usePlatform } from "./platform";
import { ScreenTrackpad, type RemoteInput } from "./ScreenTrackpad";
import { WHEEL_MASK } from "./screen-trackpad";
import { PhoneTakeoverShell, type TakeoverMenuItem } from "./PhoneTakeoverViewer";

const NO_NAV: BrowserNav = { url: "", loading: false, canGoBack: false, canGoForward: false };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;
const WHEEL_ALL = WHEEL_MASK.up | WHEEL_MASK.down | WHEEL_MASK.left | WHEEL_MASK.right;
const WHEEL_PX = 80;
const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_SLOP = 16;

const KEY_CODES: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
};

function tabsOf(value: unknown): StripTab[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tab) => tab && typeof tab === "object" && typeof tab.tabId === "string"
    ? [{ tabId: tab.tabId, title: typeof tab.title === "string" ? tab.title : "", url: typeof tab.url === "string" ? tab.url : "", active: tab.active === true, ...(tab.held === true ? { held: true } : {}) }]
    : []);
}

const landscapeQuery = () => typeof matchMedia === "function" ? matchMedia("(orientation: landscape)") : null;
const subscribeLandscape = (listener: () => void) => {
  const query = landscapeQuery();
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
};
const isLandscape = () => landscapeQuery()?.matches ?? false;

/** True when tapping a bot's Computer button on a phone should launch the browser directly into fullscreen takeover
 * instead of opening the Computer settings sheet (local Mac/PC bots, browser-only bots, or active browser help). */
export function opensBrowserTakeoverDirectly(
  bot: Pick<Bot, "id" | "browser" | "computer">,
  state: { config?: { cloudHome?: boolean } | null; computerControl?: Record<string, { help?: { place?: string } | null } | undefined> },
): boolean {
  if (bot.browser === false) return false;
  const current = bot.computer ?? "auto";
  const helpBrowser = state.computerControl?.[bot.id]?.help?.place === "browser";
  if (current === "off" && !helpBrowser) return false;
  const local = state.config?.cloudHome !== true;
  const ownScreen = current === "vm" || (!local && current !== "browser");
  return !ownScreen || helpBrowser;
}

/** Fullscreen pure-black built-in browser takeover on phones, matching the remote desktop viewer's controls. */
export function PhoneBrowserTakeover({ bot, signIn, onClose }: {
  bot: Bot;
  signIn: { url: string; site: string; nonce: number } | null;
  onClose: () => void;
}) {
  const { state } = useStore();
  const platform = usePlatform();
  const landscape = useSyncExternalStore(subscribeLandscape, isLandscape, () => false);
  const [fallback, setFallback] = useState(false);
  const stream = state.config?.browserEngine?.engine === "chrome" && !fallback;
  const scopedThread = browserScope(state.config?.team, bot.threadId).threadId;
  const [attempt, setAttempt] = useState(0);
  const [connected, setConnected] = useState(false);
  const [painted, setPainted] = useState(false);
  const [tabs, setTabs] = useState<readonly StripTab[]>([]);
  const [heard, setHeard] = useState(false);
  const [nav, setNav] = useState<BrowserNav>(NO_NAV);
  const [error, setError] = useState("");
  const [gone, setGone] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [trackpadMode, setTrackpadMode] = useState(false);
  const [recenterNonce, setRecenterNonce] = useState(0);

  const screenRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<StreamSurfaceHandle | null>(null);
  const keyboardRef = useRef<HTMLInputElement>(null);
  const clientRef = useRef<PreviewStreamClient | null>(null);
  const browserControl = useRef<BrowserControl | null>(null);
  const controlRef = useRef<PreviewStreamControl | null>(null);
  const resume = useRef<LiveResume & { key: string }>({ key: "", viewer: "" });
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const signInHandled = useRef(0);
  const signInUrl = useRef<string | null>(null);
  const openingDone = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointerState = useRef({
    mask: 0,
    lastClick: null as { button: PreviewStreamMouseButton; x: number; y: number; at: number; count: number } | null,
  });

  const signInHelp = state.computerControl?.[bot.id]?.help?.place === "browser" ? state.computerControl[bot.id]!.help! : null;

  useEffect(() => {
    openingDone.current = false;
  }, [bot.id, bot.threadId, attempt]);

  const showToast = useCallback((message: string) => {
    clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 1_800);
  }, []);

  useEffect(() => () => {
    clearTimeout(toastTimer.current);
    browserControl.current?.close();
  }, []);

  const connect = useCallback<SurfaceConnect>((target, events) => {
    const scope: Record<string, string> = scopedThread ? { threadId: scopedThread } : {};
    const together = { ...scope, together: "1" };
    if (stream) return createPreviewStreamClient({ access: browserStreamAccess(bot.id, window.location, together), ...target }, events);
    const resumeKey = `${bot.id}\n${bot.browserProfile ?? ""}${scopedThread ? `\n${scopedThread}` : ""}`;
    if (resume.current.key !== resumeKey) resume.current = { key: resumeKey, viewer: "" };
    return createLiveStreamClient(bot.id, events, (body, viewerId) => api(withBrowserScope(`/api/bots/${encodeURIComponent(bot.id)}/browser/action`, scope), {
      method: "POST", body: JSON.stringify({ ...body, viewerId }), timeoutMs: 120_000,
    }), resume.current, together, { width: target.width, height: target.height });
  }, [bot.id, bot.browserProfile, scopedThread, stream]);

  const send = useCallback((input: PreviewStreamInput) => {
    if (browserControl.current) {
      if (controlRef.current?.controller === "another-viewer") { setError(BROWSER_HELD_ELSEWHERE); return false; }
      setError("");
      if (input.type === "releaseControl") { browserControl.current.handBack(); return true; }
      if (input.type === "takeControl") { browserControl.current.takeControl(); return true; }
      if (input.type === "restart" || input.type === "dialog") return clientRef.current?.send(input) ?? false;
      browserControl.current.interact(input);
      return true;
    }
    if (clientRef.current?.send(input)) { setError(""); return true; }
    if (controlRef.current?.controller === "another-viewer") setError(BROWSER_HELD_ELSEWHERE);
    return false;
  }, []);

  const onControl = useCallback((next: PreviewStreamControl | null) => {
    controlRef.current = next;
    browserControl.current?.observe();
    if (!browserControl.current && next?.canOperate && next.controller === "unclaimed") {
      clientRef.current?.send({ type: "takeControl" });
    }
  }, []);

  const onClient = useCallback((client: PreviewStreamClient | null) => {
    clientRef.current = client;
    browserControl.current?.close();
    browserControl.current = null;
    if (client && "transport" in client) {
      const created = createBrowserControl({
        transport: (client as LiveStreamClient).transport,
        owned: () => controlRef.current?.controller === "you",
        mine: () => controlRef.current?.owned === true,
        onTakeStatus: () => {},
        onError: setError,
        onHalted: () => setError(t("browser.input.tooSlow")),
      });
      created.keep(true);
      browserControl.current = created;
    }
  }, []);

  useEffect(() => {
    if (!connected) return;
    browserControl.current?.keep(true);
    browserControl.current?.takeControl();
    if (!browserControl.current && controlRef.current?.canOperate && controlRef.current.controller === "unclaimed") {
      clientRef.current?.send({ type: "takeControl" });
    }
    if (!signIn || signInHandled.current === signIn.nonce) return;
    signInHandled.current = signIn.nonce;
    signInUrl.current = signIn.url;
  }, [signIn, connected]);

  useEffect(() => {
    const url = signInUrl.current;
    if (!url || !connected || !heard) return;
    signInUrl.current = null;
    openingDone.current = true;
    const current = tabsRef.current.find((tab) => tab.active) ?? tabsRef.current[0];
    if (!current || blankPage(current.url)) send({ type: "navigate", url });
  }, [connected, heard, send, signIn]);

  const onMessage = useCallback((message: Readonly<Record<string, unknown>>) => {
    if (message.type === "tabs") {
      const next = tabsOf(message.tabs);
      setTabs(next);
      setHeard(true);
      if (next.some((tab) => !blankPage(tab.url))) {
        openingDone.current = true;
      } else if (!openingDone.current && !signInUrl.current && !signIn?.url) {
        openingDone.current = true;
        if (next.length > 0) send({ type: "navigate", url: START_PAGE });
        else send({ type: "tabNew", url: START_PAGE });
      }
      const active = next.find((tab) => tab.active);
      if (active) setNav((current) => ({ ...current, url: active.url }));
    } else if (message.type === "nav" && typeof message.url === "string") {
      setNav({ url: message.url, loading: message.loading === true, canGoBack: message.canGoBack === true, canGoForward: message.canGoForward === true });
    } else if (message.type === "url" && typeof message.url === "string") {
      setNav((current) => ({ ...current, url: message.url as string }));
    } else if (message.type === "asleep") {
      setConnected(false);
      setPainted(false);
      setGone(true);
    }
  }, [send, signIn?.url]);

  const remoteInput = useMemo<RemoteInput>(() => ({
    size: () => {
      const vp = surfaceRef.current?.viewport();
      if (vp && vp.width > 0 && vp.height > 0) return { width: vp.width, height: vp.height };
      const canvas = surfaceRef.current?.canvas();
      return canvas?.width && canvas.height ? { width: canvas.width, height: canvas.height } : null;
    },
    pointer: (x, y, mask) => {
      const prev = pointerState.current.mask;
      pointerState.current.mask = mask;
      const raised = mask & ~prev;
      if (raised & WHEEL_ALL) {
        const deltaY = (raised & WHEEL_MASK.down ? WHEEL_PX : 0) - (raised & WHEEL_MASK.up ? WHEEL_PX : 0);
        const deltaX = (raised & WHEEL_MASK.right ? WHEEL_PX : 0) - (raised & WHEEL_MASK.left ? WHEEL_PX : 0);
        send({ type: "wheel", x, y, deltaX, deltaY, modifiers: 0 });
        return;
      }
      const prevButtons = ((prev & 1) ? 1 : 0) | ((prev & 4) ? 2 : 0);
      const nextButtons = ((mask & 1) ? 1 : 0) | ((mask & 4) ? 2 : 0);
      if ((prev & WHEEL_ALL) && !(mask & WHEEL_ALL) && prevButtons === nextButtons) return;
      if (prevButtons !== nextButtons) {
        const diff = prevButtons ^ nextButtons;
        const button: PreviewStreamMouseButton = diff & 1 ? "left" : "right";
        const down = Boolean(nextButtons & diff);
        let clickCount = 1;
        if (down) {
          const now = performance.now();
          const last = pointerState.current.lastClick;
          clickCount = last && last.button === button && now - last.at < DOUBLE_CLICK_MS && Math.hypot(x - last.x, y - last.y) < DOUBLE_CLICK_SLOP ? Math.min(3, last.count + 1) : 1;
          pointerState.current.lastClick = { button, x, y, at: now, count: clickCount };
        } else {
          clickCount = pointerState.current.lastClick?.button === button ? pointerState.current.lastClick.count : 1;
        }
        send({ type: "mouse", action: down ? "down" : "up", x, y, button, buttons: nextButtons, clickCount, modifiers: 0 });
        return;
      }
      const heldButton: PreviewStreamMouseButton = nextButtons & 1 ? "left" : nextButtons & 2 ? "right" : "none";
      send({ type: "mouse", action: "move", x, y, button: heldButton, buttons: nextButtons, clickCount: 0, modifiers: 0 });
    },
    key: (_keysym, code) => {
      const info = KEY_CODES[code];
      if (!info) return;
      send({ type: "key", action: "down", key: info.key, code: info.code, keyCode: info.keyCode, ...(info.text ? { text: info.text } : {}), modifiers: 0 });
      send({ type: "key", action: "up", key: info.key, code: info.code, keyCode: info.keyCode, modifiers: 0 });
    },
    text: (typed) => {
      if (typed) send({ type: "text", text: typed });
    },
  }), [send]);

  const handleExit = useCallback(() => {
    if (!signInHelp) send({ type: "releaseControl" });
    onClose();
  }, [signInHelp, send, onClose]);

  const handleDone = useCallback(async () => {
    if (finishing) return;
    setFinishing(true);
    setError("");
    try {
      if (signInHelp) {
        await answerSignIn(signInHelp, "done");
      } else {
        send({ type: "releaseControl" });
      }
      onClose();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setFinishing(false);
    }
  }, [finishing, signInHelp, send, onClose]);

  const handleKeyboard = useCallback(() => {
    const input = keyboardRef.current;
    if (!input) {
      surfaceRef.current?.focusPage();
      return;
    }
    if (document.activeElement === input) {
      input.blur();
      platform.hideKeyboard?.();
    } else {
      input.focus({ preventScroll: true });
    }
  }, [platform]);

  const copyRequestedRef = useRef(false);

  const handlePasteFromPhone = useCallback(async (provided?: string) => {
    const text = provided !== undefined ? provided : await platform.readClipboard?.().catch(() => null);
    if (!text) {
      haptic("error");
      showToast(t("desktopViewer.clipboardEmpty"));
      return;
    }
    send({ type: "text", text });
    haptic("success");
    showToast(t("desktopViewer.pasted"));
  }, [platform, send, showToast]);

  const handleRemoteClipboard = useCallback((text: string) => {
    const requested = copyRequestedRef.current;
    copyRequestedRef.current = false;
    if (!text) {
      if (requested) {
        haptic("error");
        showToast(t("desktopViewer.nothingSelected"));
      }
      return;
    }
    void (async () => {
      const ok = platform.writeClipboard
        ? await platform.writeClipboard(text).catch(() => false)
        : (await copyText(text)) === "copied";
      if (ok) {
        haptic("success");
        showToast(t("desktopViewer.copiedToPhone"));
      } else {
        haptic("error");
      }
    })();
  }, [platform, showToast]);

  const handleCopyToPhone = useCallback(() => {
    copyRequestedRef.current = true;
    send({ type: "copy" });
  }, [send]);

  const openUrlDialog = useCallback(async () => {
    const dialogs = systemDialogs();
    let raw: string | null = null;
    if (dialogs) {
      const result = await dialogs.form({
        title: t("desktopViewer.browser.openUrl"),
        requireChange: false,
        fields: [{
          id: "url",
          label: t("browser.panel.address"),
          placeholder: t("desktopViewer.browser.urlPlaceholder"),
          value: nav.url,
          kind: "url",
          autoFocus: true,
        }],
        saveLabel: t("computer.open"),
      });
      if (result.saved) raw = result.values.url ?? null;
    } else if (typeof window.prompt === "function") {
      raw = window.prompt(t("desktopViewer.browser.openUrl"), nav.url);
    }
    if (!raw?.trim()) return;
    const resolved = resolveAddressBarInput(raw);
    if (resolved) send({ type: "navigate", url: resolved });
    else setError(t("browser.panel.enterAddress"));
  }, [nav.url, send]);

  const activeTab = tabs.find((tab) => tab.active) ?? tabs[0] ?? null;
  const extraMenuItems = useMemo<TakeoverMenuItem[]>(() => {
    const items: TakeoverMenuItem[] = [
      {
        key: "browser:reload",
        label: t("desktopViewer.browser.reload"),
        symbol: "arrow.clockwise",
        separated: true,
        icon: <RotateCw size={16} />,
        onSelect: () => send({ type: "reload" }),
      },
      {
        key: "browser:back",
        label: t("desktopViewer.browser.back"),
        symbol: "chevron.backward",
        disabled: !nav.canGoBack,
        icon: <ArrowLeft size={16} />,
        onSelect: () => send({ type: "history", delta: -1 }),
      },
      {
        key: "browser:forward",
        label: t("desktopViewer.browser.forward"),
        symbol: "chevron.forward",
        disabled: !nav.canGoForward,
        icon: <ArrowRight size={16} />,
        onSelect: () => send({ type: "history", delta: 1 }),
      },
      {
        key: "browser:url",
        label: t("desktopViewer.browser.openUrl"),
        symbol: "globe",
        icon: <Globe size={16} />,
        onSelect: () => void openUrlDialog(),
      },
      {
        key: "browser:newTab",
        label: t("desktopViewer.browser.newTab"),
        symbol: "plus",
        icon: <Plus size={16} />,
        onSelect: () => send({ type: "tabNew", url: START_PAGE }),
      },
    ];
    if (tabs.length > 1) {
      tabs.forEach((tab, index) => {
        items.push({
          key: `tab:${tab.tabId}`,
          label: tabName(tab),
          checked: tab.tabId === activeTab?.tabId,
          separated: index === 0,
          onSelect: () => send({ type: "tabSelect", tabId: tab.tabId }),
        });
      });
    }
    return items;
  }, [nav.canGoBack, nav.canGoForward, openUrlDialog, send, tabs, activeTab?.tabId]);

  const frame = (
    <div className="relative size-full overflow-hidden bg-black">
      <div ref={screenRef} className="absolute inset-0 flex flex-col">
        <StreamSurface
          key={`${attempt}:${stream ? "stream" : "live"}:${bot.browserProfile ?? ""}`}
          ref={surfaceRef}
          connect={connect}
          input={send}
          together
          fixedViewport={DESKTOP_VIEWPORT}
          onClipboard={handleRemoteClipboard}
          suppressConnectingSpinner
          label={t("localBrowser.page", { name: bot.name })}
          onClient={onClient}
          onControl={onControl}
          onMessage={onMessage}
          onFirstFrame={() => setPainted(true)}
          onConnectedChange={(next) => {
            setConnected(next);
            if (!next) { setHeard(false); setPainted(false); }
            else { setError(""); setGone(false); }
          }}
          onUnauthorized={() => { if (stream) setFallback(true); else setAttempt((n) => n + 1); }}
          onGone={() => {
            setConnected(false);
            setPainted(false);
            setGone(true);
            setError(t("browser.panel.disconnected"));
          }}
        />
      </div>
      <ScreenTrackpad
        screen={screenRef}
        input={remoteInput}
        keyboard={keyboardRef}
        haptic={platform.haptic}
        label={t("localBrowser.page", { name: bot.name })}
        mode={trackpadMode ? "trackpad" : "direct"}
        recenterNonce={recenterNonce}
      />
    </div>
  );

  const shell = (
    <PhoneTakeoverShell
      label={t("localBrowser.label", { name: bot.name })}
      bot={bot}
      name={bot.name}
      platform={platform}
      landscape={landscape}
      onExit={handleExit}
      frame={gone ? null : frame}
      note={gone ? (
        <div className="flex flex-col items-center gap-3">
          <p className="max-w-[280px] text-[15px] leading-5 text-white/70">{error || t("desktopViewer.disconnected")}</p>
          <button
            type="button"
            onClick={() => { setGone(false); setError(""); setAttempt((n) => n + 1); }}
            className="takeover-glass inline-flex h-11 cursor-pointer items-center rounded-full px-5 text-[15px] font-medium text-white"
          >
            {t("desktopViewer.reconnect")}
          </button>
        </div>
      ) : null}
      connecting={!gone && !painted && !error}
      control={{ held: true, asked: Boolean(signInHelp || signIn), onDone: () => void handleDone(), busy: finishing }}
      watchHint={{ count: 0, shown: false }}
      alert={gone ? null : error || null}
      toast={toast}
      onKeyboard={handleKeyboard}
      trackpadMode={trackpadMode}
      onToggleTrackpad={() => setTrackpadMode((on) => !on)}
      onRecenterPointer={() => setRecenterNonce((n) => n + 1)}
      onPasteFromPhone={(text) => void handlePasteFromPhone(text)}
      onCopyToPhone={handleCopyToPhone}
      extraMenuItems={extraMenuItems}
      aspect={DESKTOP_VIEWPORT.width / DESKTOP_VIEWPORT.height}
    />
  );

  return typeof document !== "undefined" ? createPortal(shell, document.body) : shell;
}
