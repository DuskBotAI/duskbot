import type { ShortcutsBridge } from "./shortcuts";
import { createContext, useContext } from "react";
import type { MobileOpenTarget } from "../../shared/mobile-link";
import type { TurnActivityAttributes, TurnActivityState } from "../../shared/phone-activity";
import type { NativeAction } from "./phone-actions";
import { friendlyError } from "@/lib/plain-error";
import { copyText } from "@/lib/copy-text";
import type { GlassBridge } from "./native-glass";
import type { MenuBridge } from "./native-menu";
import type { SystemControls } from "@/lib/system-control";
import type { SystemDialogs } from "@/lib/system-dialog";

export type HapticKind = "light" | "soft" | "medium" | "selection" | "error" | "success";

export interface KeyboardFrame {
  /** Height the keyboard covers, in css px, 0 when hidden. */
  height: number;
  /** Starting to move (`will`) or settled (`did`). */
  phase: "will" | "did";
  /** A `will` straight from the system's notification: the keyboard's own duration in seconds and when it started to
   * move, in epoch ms, so the page can start its ride as far in as the bridge hop cost. */
  duration?: number;
  at?: number;
  /** The native side lifts the whole page by this many css px itself, in the keyboard's own animation; a `did` with it
   * is that move stopped, for the page to take the space itself. */
  lift?: number;
}

export type BackGestureEvent =
  | { phase: "start" | "progress"; progress: number }
  | { phase: "cancel" | "commit" };

export interface ScanResult {
  text: string;
}

/** A push still in Notification Center: its own identifier, the conversation and the notification it was for. */
export interface DeliveredNotification { id: string; threadId?: string; notificationId?: string }

export interface AppleCredential { identityToken: string; authorizationCode: string; givenName?: string; familyName?: string }

export type CameraPermission = "granted" | "denied" | "prompt";

/** A live QR scan under our own viewfinder. Natively the camera draws behind a transparent WebView (the page adds
 * `mobile-scanning` to <html> while it runs); in a browser it plays into the given <video>. */
export interface CameraSession {
  stop(): Promise<void>;
  torch?: { set(on: boolean): Promise<void> };
  /** The system drew the whole scanner itself (iPhone, VisionKit): the page shows none of its own. */
  fullScreen?: boolean;
  /** A read code is being redeemed: a full screen scanner pauses and says so. */
  busy?(on: boolean, label?: string): void;
}

/** The page's words for a scanner the system draws full screen. */
export interface ScanOverlay {
  title: string;
  hint: string;
  close: string;
  torch: string;
  /** buttons under the viewfinder; `icon` is an SF Symbol */
  actions: { key: string; title: string; icon?: string }[];
}

export interface CameraScanner {
  permission(): Promise<CameraPermission>;
  request(): Promise<CameraPermission>;
  /** The OS settings page for this app, where a refused camera is turned back on. */
  openSettings?(): Promise<void>;
  start(options: {
    onCode: (text: string) => void;
    onError?: (message: string) => void;
    video?: HTMLVideoElement | null;
    overlay?: ScanOverlay;
    /** a button of the overlay, or "close" */
    onAction?: (key: string) => void;
  }): Promise<CameraSession>;
}

/** One entry of a system menu. `symbol` is an SF Symbol name; `separated` starts a new group. */
export interface SystemMenuAction { key: string; label: string; detail?: string; symbol?: string; danger?: boolean; disabled?: boolean; checked?: boolean; separated?: boolean }

/** One button in the system's bar. `symbol` is an SF Symbol name; `picture` is a part of the page the device keeps a
 * snapshot of under `key` (a bot's face), shown beside `title`. */
export interface BarItem {
  id: string;
  label: string;
  symbol?: string;
  title?: string;
  role?: "close" | "cancel" | "done" | "confirm";
  badge?: number;
  disabled?: boolean;
  picture?: { key: string; data?: string; url?: string; x?: number; y?: number; width?: number; height?: number };
}

export interface BarSearchConfig {
  key: string;
  placeholder: string;
  value?: string;
  autoFocus?: boolean;
}

export interface BarConfig { title?: string; status?: string; leading: BarItem[]; trailing: BarItem[]; search?: BarSearchConfig }

/** The system's own bar and sheet around the page (iOS 26): bar buttons in the system's glass, and a sheet that is the
 * page itself, presented by the system over a picture of what it left. */
export interface MobileChrome {
  /** Null takes the bar away. */
  setBar(config: BarConfig | null): void;
  onBarPress(listener: (id: string) => void): () => void;
  onPictureTaken(listener: (key: string) => void): () => void;
  /** Fired when text in the navigation bar's native UISearchController changes. */
  onSearchChange?(listener: (text: string) => void): () => void;
  /** Fired when the person taps Cancel on the navigation bar's native UISearchController. */
  onSearchCancel?(listener: () => void): () => void;
  /** Holds a picture of the screen over the page, so the page can redraw itself underneath unseen, until `thaw`. */
  freeze(): Promise<void>;
  thaw(): Promise<void>;
  /** `height` is the content's height in css px for a sheet that hugs it; null fills the screen. */
  presentSheet(height: number | null): Promise<void>;
  resizeSheet(height: number): void;
  dismissSheet(): Promise<void>;
  /** The person swiped the sheet away. */
  onSheetDismissed(listener: () => void): () => void;
  /** Snapshots the current sheet page and covers it so the pushed view can paint before `commitPush`. */
  beginPush?(): Promise<boolean>;
  /** Pushes the rendered view onto the sheet's UINavigationController under `token`. */
  commitPush?(token: string): Promise<boolean>;
  /** Aborts a prepared push and removes its cover. */
  cancelPush?(): Promise<void>;
  /** Pops back to the page below `token` on the sheet's UINavigationController. */
  popPage?(token: string, options?: { animated?: boolean }): Promise<boolean>;
  /** Reveals the underlying page after a pop once the page has unmounted the popped view. */
  finishPop?(): Promise<void>;
  /** Collapses any pushed snapshot controllers on the sheet's navigation stack without animation. */
  resetPushStack?(): Promise<void>;
  /** Fired when a native Back tap, swipe-back or back-menu jump pops one or more pushed tokens (topmost first). */
  onPagePopped?(listener: (tokens: string[]) => void): () => void;
}

/** Everything the phone layer asks of the device. The native app supplies Capacitor plugins; the web preview and a
 * plain browser get the fallbacks in `webPlatform`. Capability flags, never user-agent guesses. */
export interface OrientationBridge {
  allowLandscape(on: boolean): void;
  rotate(to: "portrait" | "landscape"): void;
}

export interface TurnActivityBridge {
  /** the activity's id, or null when the person turned Live Activities off */
  start(attributes: TurnActivityAttributes, state: TurnActivityState): Promise<string | null>;
  update(id: string, state: TurnActivityState): Promise<void>;
  /** stays a few minutes; `now` takes it away at once */
  end(id: string, state: TurnActivityState, now?: boolean): Promise<void>;
  /** the ones running, the ones a push started among them */
  list(): Promise<Array<{ id: string; botId: string; threadId: string; startedAt: number }>>;
  /** each activity's push token, as the system issues or renews it */
  onToken(listener: (token: { id: string; threadId: string; token: string; startedAt: number }) => void): () => void;
  /** the push-to-start token (iOS 17.2 and later) */
  onStartToken(listener: (token: string) => void): () => void;
  /** the X25519 public key (base64url) the done line is sealed to, or null when the phone shows no previews */
  lineKey(): Promise<string | null>;
}

/** The Keychain could not be read just now (the phone is locked): what it holds is unknown, never "nothing". */
export class SecretsLocked extends Error {
  constructor() {
    super("the keychain is locked");
    this.name = "SecretsLocked";
  }
}

/** Calls `again` once the app comes back in front, or after a few seconds if no resume is heard; returns a stop. */
export function waitForFront(platform: Pick<MobilePlatform, "onResume">, again: () => void, fallbackMs = 3_000): () => void {
  let done = false;
  const fire = () => { if (done) return; done = true; stop(); again(); };
  const stopResume = platform.onResume?.(fire);
  const timer = setTimeout(fire, fallbackMs);
  const stop = () => { clearTimeout(timer); stopResume?.(); };
  return () => { done = true; stop(); };
}

export interface MobilePlatform {
  kind: "ios" | "android" | "web";
  native: boolean;
  haptic(kind: HapticKind): void;
  /** Native keyboard events; absent where the visual viewport is the only signal. */
  onKeyboard?(listener: (frame: KeyboardFrame) => void): () => void;
  hideKeyboard?(): void;
  /** Android: the field that now has focus is the chat composer's (`true`), whose keyboard the page rides in a window
   * of full height, or another, for which the window ends at the keyboard. */
  keyboardMode?(ride: boolean): void;
  setStatusBar?(style: "dark" | "light"): void;
  /** The look the system's own surfaces take over the app (its menus, the keyboard): the app's, or the phone's for "system". */
  setAppearance?(scheme: "system" | "light" | "dark"): void;
  /** Android's back; return true when handled. The newest listener is asked first and an older one only when it
   * declines (`handleBack`); when none takes it the app goes to the background. */
  onBack?(listener: () => boolean): () => void;
  /** A back listener is on its first screen and would decline (default: it is not). While every listener is, back goes
   * to the system, which plays its predictive back-to-home. */
  backAtRoot?(listener: () => boolean, atRoot: boolean): void;
  /** Android 14+: while `on` and this back listener is the newest, the back gesture drives the page itself. */
  backGesture?(listener: () => boolean, on: boolean): void;
  /** The back gesture's start, its progress (0 to 1 of the way the system lets it go), a cancel, and its commit. A
   * listener returns true for a commit it plays itself; a commit nobody takes (a back button) goes to `onBack`. */
  onBackGesture?(listener: (event: BackGestureEvent) => boolean): () => void;
  /** Links the OS hands the app: duskbot://pair, duskbot://open, the desktop's thread links. A listener returns
   * true when the link was its kind; the link that launched the app waits for the first listener that takes it. */
  onAppUrl?(listener: (url: string) => boolean): () => void;
  onResume?(listener: () => void): () => void;
  /** The app went to the background. */
  onPause?(listener: () => void): () => void;
  /** The phone moved to another network (Wi-Fi to cellular, another Wi-Fi) or lost or got one back. */
  onNetworkChange?(listener: () => void): () => void;
  /** Non-secret key/value storage. */
  prefs: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
    /** every key kept, where the storage can list them */
    keys?(): Promise<string[]>;
  };
  /** Keychain/Keystore. The web fallback keeps secrets in session memory only. */
  secrets: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
  /** Keychain/Keystore items a build from before the rename to dusk bot kept under its own prefix, by their key past it;
   * a phone updated from such a build still holds its sign-ins and place tokens there. */
  legacySecrets?: {
    keys(): Promise<string[]>;
    get(key: string): Promise<string | null>;
    remove(key: string): Promise<void>;
  };
  /** The system's pull-down menu (iOS) opened from a control at `anchor` (its frame in the viewport, css px). Resolves the
   * key picked, or null when the menu was closed without a pick. */
  showMenu?(anchor: { x: number; y: number; width: number; height: number }, items: SystemMenuAction[]): Promise<string | null>;
  chrome?: MobileChrome;
  /** The system's own segmented control and switch (iOS 26), in the page. */
  controls?: SystemControls;
  /** Native UIKit alerts and SwiftUI modal form sheets (iOS). */
  dialogs?: SystemDialogs;
  scanQr?(): Promise<ScanResult | null>;
  camera?: CameraScanner;
  readClipboard?(): Promise<string | null>;
  writeClipboard?(text: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  /** Closes the in-app browser sheet openExternal showed, if one is up. */
  closeBrowser?(): void;
  share?(data: { title?: string; text?: string; url?: string }): Promise<void>;
  /** A file to the system share sheet (Save to Files, Save Image); absent in a build without the file plugin. */
  shareFile?(file: File): Promise<void>;
  /** Sign in with Apple through the system sheet (iPhone): Apple binds `nonceHash` (sha-256 hex) into the identity token.
   * Null when the person closed the sheet; throws when it failed. */
  appleSignIn?(nonceHash: string): Promise<AppleCredential | null>;
  /** Push registration; resolves the device token or null when refused or unsupported. Without `prompt` it never shows
   * the system's question: a phone not yet asked resolves null. */
  registerPush?(options?: { prompt?: boolean }): Promise<{ token: string; platform: "apns" | "fcm" } | null>;
  /** Whether the system lets this app show notifications: `prompt` until the person has been asked. */
  pushPermission?(): Promise<"granted" | "denied" | "prompt">;
  onNotificationOpen?(listener: (target: MobileOpenTarget) => void): () => void;
  /** The conversation on screen, null for none: a push about it shows nothing while the app is open, any other shows
   * the system's own banner. */
  setViewingThread?(threadId: string | null): void;
  /** What Notification Center holds from the bot host, and its removal. */
  deliveredNotifications?(): Promise<DeliveredNotification[]>;
  removeDeliveredNotifications?(ids: readonly string[]): Promise<void>;
  /** A push's button, its reply field, a tap on a push from the bot host, or a Live Activity's button; one that arrived
   * before a listener waits for the first. */
  onPhoneAction?(listener: (action: NativeAction) => void): () => void;
  /** The iPhone's Live Activities (ActivityKit), where the system allows them. */
  turnActivity?: TurnActivityBridge;
  /** The chat header and composer drawn in the OS's own glass, where the app has it. */
  glass?: GlassBridge;
  /** The system's own context menu over the page's items, where the app has it. */
  menu?: MenuBridge;
  /** The phone may turn sideways while a remote screen is open; everywhere else the app stays upright. */
  orientation?: OrientationBridge;
  /** Siri, Spotlight and the Shortcuts app: message, call or open a bot, where the app has them. */
  shortcuts?: ShortcutsBridge;
  deviceName(): string;
  appVersion: string;
}

const memorySecrets = new Map<string, string>();

function storageOf(kind: "localStorage" | "sessionStorage"): Storage | null {
  try { return globalThis[kind] ?? null; } catch { return null; }
}

/** Hands Android's back to the newest listener, then each older one while they decline; true when one took it. */
export function handleBack(listeners: ReadonlyArray<() => boolean>): boolean {
  for (let at = listeners.length - 1; at >= 0; at -= 1) if (listeners[at]!()) return true;
  return false;
}

export function webPlatform(): MobilePlatform {
  const local = storageOf("localStorage");
  return {
    kind: "web",
    native: false,
    haptic(kind) {
      // android chrome honours vibrate; ios safari ignores it, which is the honest answer for a browser
      const pattern = kind === "error" ? [12, 40, 12] : kind === "medium" ? 14 : kind === "selection" ? 4 : 8;
      try { navigator.vibrate?.(pattern); } catch {}
      if (import.meta.env.DEV) document.documentElement.dataset.lastHaptic = `${kind}:${Date.now()}`;
    },
    prefs: {
      get: async (key) => local?.getItem(key) ?? null,
      set: async (key, value) => { local?.setItem(key, value); },
      remove: async (key) => { local?.removeItem(key); },
    },
    secrets: {
      get: async (key) => memorySecrets.get(key) ?? null,
      set: async (key, value) => { memorySecrets.set(key, value); },
      remove: async (key) => { memorySecrets.delete(key); },
    },
    camera: typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia ? {
      async permission() {
        try {
          const result = await navigator.permissions?.query({ name: "camera" as PermissionName });
          return result?.state === "granted" || result?.state === "denied" ? result.state : "prompt";
        } catch { return "prompt"; }
      },
      async request() {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
          for (const track of stream.getTracks()) track.stop();
          return "granted";
        } catch { return "denied"; }
      },
      async start({ onCode, onError, video }) {
        if (!video) throw new Error("video-required");
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        const seen = new Set<string>();
        let stopped = false;
        let frame = 0;
        let lastScan = -Infinity;
        let detecting = false;
        const stop = async () => {
          if (stopped) return;
          stopped = true;
          cancelAnimationFrame(frame);
          for (const track of stream.getTracks()) track.stop();
          if (video.srcObject === stream) {
            video.pause();
            video.srcObject = null;
          }
        };
        try {
          video.muted = true;
          video.playsInline = true;
          video.autoplay = true;
          video.srcObject = stream;
          await video.play();
          type Detector = { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> };
          const BarcodeDetector = (globalThis as typeof globalThis & {
            BarcodeDetector?: { new(options: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> };
          }).BarcodeDetector;
          const formats = BarcodeDetector ? await BarcodeDetector.getSupportedFormats() : [];
          if (BarcodeDetector && formats.includes("qr_code")) {
            const detector = new BarcodeDetector({ formats: ["qr_code"] });
            const scan = (now: number) => {
              if (stopped) return;
              frame = requestAnimationFrame(scan);
              if (detecting || now - lastScan < 150 || video.readyState < 2) return;
              lastScan = now;
              detecting = true;
              void detector.detect(video).then((codes) => {
                for (const { rawValue } of codes) {
                  if (stopped) return;
                  if (typeof rawValue !== "string" || seen.has(rawValue)) continue;
                  seen.add(rawValue);
                  onCode(rawValue);
                }
              }).catch((error: unknown) => {
                if (!stopped) onError?.(friendlyError(error));
              }).finally(() => { detecting = false; });
            };
            frame = requestAnimationFrame(scan);
          } else {
            onError?.("unsupported");
          }
          const track = stream.getVideoTracks()[0];
          const capabilities = track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
          return {
            stop,
            torch: capabilities?.torch ? {
              async set(on) {
                if (!stopped) await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
              },
            } : undefined,
          };
        } catch (error) {
          await stop();
          throw error;
        }
      },
    } : undefined,
    async readClipboard() {
      try { return await navigator.clipboard?.readText() ?? null; } catch { return null; }
    },
    async writeClipboard(text) {
      return (await copyText(text)) === "copied";
    },
    openExternal: async (url) => { window.open(url, "_blank", "noopener"); },
    share: typeof navigator !== "undefined" && "share" in navigator
      ? async (data) => { await navigator.share(data).catch(() => {}); }
      : undefined,
    deviceName: () => (/iphone/i.test(navigator.userAgent) ? "iPhone" : /android/i.test(navigator.userAgent) ? "Android phone" : "Phone browser"),
    appVersion: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev",
  };
}

export const PlatformContext = createContext<MobilePlatform | null>(null);

export function usePlatform(): MobilePlatform {
  const platform = useContext(PlatformContext);
  if (!platform) throw new Error("usePlatform outside the mobile root");
  return platform;
}
