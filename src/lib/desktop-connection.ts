import RFB from "@novnc/novnc";
import { DESKTOP_VIEWER_TARGET } from "../../shared/desktop-viewer";
import { directScreenWanted, linkProxyState, linkProxyTurn, onLinkProxy, openDirectScreen, type DirectScreen } from "./screen-direct";
import { noteScreen, trail } from "./trail";

export interface DesktopConnectionEvents {
  connected(): void;
  disconnected(): void;
  clipboard?(text: string): void;
}

/** The connection never came up: the link was wrong, the desktop is gone, or it did not answer in time. */
export class DesktopUnreachable extends Error {
  readonly invalid: boolean;
  constructor(invalid = false) {
    super(invalid ? "invalid desktop link" : "desktop unreachable");
    this.invalid = invalid;
  }
}

/** Security: only desktop pixels and input cross the VM boundary. The app's own noVNC client talks RFB through the
 * desktop proxy; the VM never supplies page code. A VPS opens its tunnel first; a Local VM's viewer runs with it. */
export async function connectDesktop(screen: HTMLElement, target: string, options: {
  threadId?: string | null;
  signal: AbortSignal;
  viewOnly?: boolean;
  /** The computer is being woken right now: the server opens its picture as soon as the container runs. */
  wake?: boolean;
  events: DesktopConnectionEvents;
}): Promise<RFB> {
  if (!DESKTOP_VIEWER_TARGET.test(target)) throw new DesktopUnreachable(true);
  const { signal: cancelled, events } = options;
  const signal = AbortSignal.any([cancelled, AbortSignal.timeout(options.wake ? 75_000 : 30_000)]);
  let config: { password?: string | null } | undefined;
  if (target.startsWith("vps/")) {
    const query = `?${new URLSearchParams({ viewer: "proxy", ...(options.wake ? { wake: "1" } : {}), ...(options.threadId ? { threadId: options.threadId } : {}) })}`;
    const joined = await fetch(`/api/bots/${target.slice(4)}/computer/join${query}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal,
    });
    if (!joined.ok) throw new DesktopUnreachable();
    const result = await joined.json();
    if (result?.viewer && (result.viewer.password === null || typeof result.viewer.password === "string")) config = result.viewer;
  }
  const path = `/api/desktop-viewer/${target}`;
  const query = target.startsWith("vps/") && options.threadId ? `?${new URLSearchParams({ threadId: options.threadId })}` : "";
  if (!config) {
    const response = await fetch(`${path}${query}`, { signal, credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new DesktopUnreachable();
    config = await response.json();
  }
  cancelled.throwIfAborted();
  // a VPS server answers the desktop's handshake itself, so the first picture is one round trip away, not five
  const socketQuery = target.startsWith("vps/") ? `?${new URLSearchParams({ ...(options.threadId ? { threadId: options.threadId } : {}), rfb: "server" })}` : query;
  // a server on another machine is asked for a direct (WebRTC) path first; whatever fails, the relay carries it as before
  let direct: Extract<DirectScreen, { channel: RTCDataChannel }> | undefined;
  let fallback: string | undefined;
  if (directScreenWanted(location.hostname)) {
    const attempt = await openDirectScreen(`${path}/direct${socketQuery}`, { signal, ...(onLinkProxy(location.hostname) ? { turn: () => linkProxyTurn(), linkDirect: async () => (await linkProxyState()).direct } : {}) });
    cancelled.throwIfAborted();
    if ("channel" in attempt) direct = attempt;
    else fallback = attempt.fallback;
  }
  const websocket = new URL(`${path}/websockify${socketQuery}`, location.href);
  websocket.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  if (fallback) websocket.searchParams.set("direct", fallback);
  // the trail: which way this screen goes (webrtc direct, cloudflare's turn, or the websocket over the link)
  const screenPath = direct ? direct.path ?? "direct" : "websocket";
  const kind = target.startsWith("vps/") ? "vps" : "vm";
  const openedAt = performance.now();
  noteScreen(target, screenPath, fallback);
  trail("desktop.stream.start", { kind, bot: target.startsWith("vps/") ? target.slice(4) : undefined, path: screenPath, ...(fallback ? { fallback } : {}), viewOnly: options.viewOnly === true });
  const client = new RFB(screen, direct?.channel ?? websocket.href, {
    credentials: { password: config?.password ?? "", username: "", target: "" },
  });
  hideDesktopPointer(client);
  client.viewOnly = true;
  client.focusOnClick = false;
  client.scaleViewport = true;
  client.background = "transparent";
  let ended = false;
  let decoded = false;
  let frameCheck: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => { client.disconnect(); end(); }, 15_000);
  let endTrailed = false;
  const trailEnd = (reason: string) => {
    if (endTrailed) return;
    endTrailed = true;
    trail("desktop.stream.end", { kind, path: screenPath, reason, ms: Math.round(performance.now() - openedAt), sawPicture: decoded });
  };
  cancelled.addEventListener("abort", () => trailEnd("closed"), { once: true });
  function end() {
    clearTimeout(deadline);
    clearTimeout(frameCheck);
    trailEnd(decoded ? "dropped" : "no-picture");
    if (ended || cancelled.aborted) return;
    ended = true;
    cancelled.removeEventListener("abort", abort);
    events.disconnected();
  }
  const abort = () => { clearTimeout(deadline); clearTimeout(frameCheck); client.disconnect(); };
  cancelled.addEventListener("abort", abort, { once: true });
  const showFirstFrame = () => {
    if (cancelled.aborted || ended || decoded) return;
    try {
      const canvas = screen.querySelector("canvas");
      // noVNC 1.7 leaves its visible canvas transparent until a decoded framebuffer update is painted.
      if (canvas?.width && canvas.height && canvas.getContext("2d")?.getImageData(0, 0, 1, 1).data[3]) {
        decoded = true;
        clearTimeout(deadline);
        client.viewOnly = options.viewOnly === true;
        client.focusOnClick = !client.viewOnly;
        trail("desktop.stream.picture", { kind, path: screenPath, ms: Math.round(performance.now() - openedAt) });
        events.connected();
      } else frameCheck = setTimeout(showFirstFrame, 32);
    } catch {
      client.disconnect();
      end();
    }
  };
  client.addEventListener("connect", showFirstFrame);
  client.addEventListener("disconnect", end);
  client.addEventListener("clipboard", (event) => {
    if (!cancelled.aborted && !ended) events.clipboard?.(event.detail.text);
  });
  return client;
}

type DrawsPointer = { _cursor?: { change?: unknown; clear?: unknown } };

/** noVNC draws the desktop's own pointer image under the person's mouse (on a phone, where they last tapped), not where
 * the desktop's pointer is: a frozen second pointer beside the bot's. The bot's pointer is drawn over the view instead
 * and a person keeps their own. noVNC 1.7 has no public switch, so its cursor's draw calls are emptied before it
 * attaches, on the next tick. */
export function hideDesktopPointer(client: RFB): void {
  const cursor = (client as unknown as DrawsPointer)._cursor;
  if (!cursor) return;
  cursor.change = () => {};
  cursor.clear = () => {};
}

const XK_SHIFT_L = 0xffe1;
const XK_CONTROL_L = 0xffe3;
const XK_INSERT = 0xff63;
const XK_C = 0x0063;
type HeldKeys = { _keyboard?: { _keyDownList?: Record<string, number>; _sendKeyEvent?(keysym: number, code: string, down: boolean): void } };

/** The paste shortcut of the person's own machine: Cmd+V on a Mac, Ctrl+V elsewhere (with or without Shift). */
export function isPasteShortcut(event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey">, mac: boolean): boolean {
  if (event.altKey || !(event.code === "KeyV" || event.key.toLowerCase() === "v")) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** Pastes text into the focused app on the desktop: the guest clipboard (and with it the X selection) takes the text,
 * then Shift+Insert, the one paste key Linux text fields, browsers and terminals all answer. The shortcut's modifier
 * is released first, as the guest saw it (Cmd arrives as Alt), so the guest gets a bare Shift+Insert. */
export function pasteOnDesktop(client: RFB, text: string): void {
  if (!text || client.viewOnly) return;
  // noVNC 1.7 keeps no public way to release held keys without also dropping input; this is its own release path
  const keyboard = (client as unknown as HeldKeys)._keyboard;
  const held = keyboard?._keyDownList;
  if (held && keyboard?._sendKeyEvent) for (const code of Object.keys(held)) keyboard._sendKeyEvent(held[code]!, code, false);
  client.clipboardPasteFrom(text);
  client.sendKey(XK_SHIFT_L, "ShiftLeft", true);
  client.sendKey(XK_INSERT, "Insert", true);
  client.sendKey(XK_INSERT, "Insert", false);
  client.sendKey(XK_SHIFT_L, "ShiftLeft", false);
}

/** Sends Ctrl+C to the focused app on the desktop so its selection reaches the clipboard event. */
export function copyFromDesktop(client: RFB): void {
  if (client.viewOnly) return;
  client.sendKey(XK_CONTROL_L, "ControlLeft", true);
  client.sendKey(XK_C, "KeyC", true);
  client.sendKey(XK_C, "KeyC", false);
  client.sendKey(XK_CONTROL_L, "ControlLeft", false);
}

/** Explicit text entry works with phone keyboards without reading the clipboard; non-Latin text uses Unicode keysyms. */
export function typeOnDesktop(client: RFB, text: string): void {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    client.sendKey(code === 10 ? 0xff0d : code === 9 ? 0xff09 : code <= 255 ? code : 0x01000000 | code, null);
  }
}

type SendsPointer = { _sock?: unknown; _rfbConnectionState?: string; _fbWidth?: number; _fbHeight?: number };
type PointerMessages = { messages?: { pointerEvent?(sock: unknown, x: number, y: number, mask: number): void } };

/** The desktop's own size in pixels, once connected. */
export function desktopSize(client: RFB): { width: number; height: number } | null {
  const { _fbWidth: width, _fbHeight: height } = client as unknown as SendsPointer;
  return width && height ? { width, height } : null;
}

/** A pointer event at a desktop pixel, on the same RFB channel noVNC's own mouse uses. noVNC 1.7 only sends pointer
 * events from its canvas's mouse and touch handlers, which take element coordinates, so the phone's trackpad writes the
 * protocol message itself. */
export function pointerOnDesktop(client: RFB, x: number, y: number, mask: number): void {
  const internals = client as unknown as SendsPointer;
  const send = (RFB as unknown as PointerMessages).messages?.pointerEvent;
  if (client.viewOnly || internals._rfbConnectionState !== "connected" || !internals._sock || !send) return;
  send(internals._sock, Math.round(x), Math.round(y), mask);
}

/** One key press on the desktop by X keysym, as a key down and up. */
export function keyOnDesktop(client: RFB, keysym: number, code: string): void {
  client.sendKey(keysym, code);
}
