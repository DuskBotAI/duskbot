import { appliedTextScale } from "./text-scale";
import { useCallback, useEffect, useRef, type RefObject } from "react";
import { hasStrips, readAttachments, readReply, type ThumbCache } from "./native-glass-strips";
import type { SlidePath } from "./NavStack";
import type { MobilePlatform } from "./platform";
import { composerHandoff } from "./native-composer-ack";
import type { HomeGlassState } from "./native-home-glass";
import {
  cssPx,
  isGlassDark,
  safeInsetPx,
  useGlassPill,
  type FloatingPillGlassState,
  type PullRefreshGlassState,
  type SwipeReplyGlassState,
  type TakeoverGlassButton,
  type TakeoverGlassButtonId,
  type TakeoverGlassMenuItem,
  type TakeoverGlassState,
  type ViewerGlassState,
} from "./native-glass-overlays";
import { kbTrace } from "./keyboard";

export {
  isGlassDark,
  safeInsetPx,
  useGlassPill,
  type FloatingPillGlassState,
  type PullRefreshGlassState,
  type SwipeReplyGlassState,
  type TakeoverGlassButton,
  type TakeoverGlassButtonId,
  type TakeoverGlassMenuItem,
  type TakeoverGlassState,
  type ViewerGlassState,
};

/** A rect in css px from the top left of the screen, which on the phone is the native view's own point space. */
export interface GlassFrame { x: number; y: number; w: number; h: number }

export interface GlassHeader {
  back: GlassFrame;
  title: GlassFrame;
  right: GlassFrame | null;
  name: string;
  live: boolean;
  backLabel: string;
  titleLabel: string;
  rightLabel: string;
}

export type GlassButtonKind = "stop" | "mic" | "micSend" | "send" | "waits" | "followUp" | "discard" | "keep" | "call" | "hangUp";
/** `fill` and `ink` are the page's own colours for the button (#rrggbb or #rrggbbaa), so Send wears the bot's button as on the desktop. */
export interface GlassButton { kind: GlassButtonKind; disabled: boolean; label: string; fill?: string; ink?: string }

export interface GlassReply {
  text: string;
  label: string;
  clearLabel: string;
  thumbnail?: string;
}

export interface GlassAttachment {
  id: string;
  label: string;
  removeLabel: string;
  thumbnail?: string;
  uploading?: boolean;
  failed?: boolean;
  retryLabel?: string;
}

export interface GlassComposer {
  frame: GlassFrame;
  /** from the composer's bottom to the line it rests on (the home indicator's edge, or the keyboard's top) */
  gap: number;
  plus: boolean;
  plusLabel: string;
  placeholder: string;
  disabled: boolean;
  /** what dictation has heard so far, or its waiting words, while it listens: the capsule shows it by a live waveform in
   * the field's place */
  voice: string | null;
  /** `voice` is words heard, not the waiting words (apps before 1.3 ignore it) */
  voiceHeard?: boolean;
  /** the message being replied to, shown as a compact strip inside the capsule (apps before reply support ignore it) */
  reply?: GlassReply | null;
  /** queued image thumbnails shown inside the capsule above the input row (apps before attachment support ignore it) */
  attachments?: GlassAttachment[];
  buttons: GlassButton[];
  returnSends: boolean;
  /** the page's text zoom, so the native field's text matches the page's (apps before 1.3 ignore it) */
  fontScale: number;
  /** the empty space under the transcript's last row: a keyboard opening over a short chat lifts the page that much less */
  room: number;
}

export interface GlassJump {
  frame: GlassFrame;
  /** from the button's bottom to the line the composer dock rests on (the home indicator's edge, or the keyboard's top) */
  gap: number;
  label: string;
}

export interface GlassState {
  dark: boolean;
  /** how far the chat's page sits right of where it rests, in px; every frame in here is where its element rests */
  offset: number;
  /** the chat is open but something covers its chrome: the page draws its own at once, so the native one goes at once */
  handoff: boolean;
  accent: string;
  /** the page's ground colour (#rrggbb), which the native side paints where the page lifts away from */
  ground: string;
  header: GlassHeader | null;
  composer: GlassComposer | null;
  /** the floating scroll-to-bottom button above the composer (apps before jump support ignore it) */
  jump?: GlassJump | null;
  /** the button is mounted but covered by a sheet or menu, so the page's own stands in at once */
  jumpHandoff?: boolean;
  /** a call's bar has the composer's place: the composer fades out under it as it comes, and back in as it goes, instead
   * of swapping at once (apps before 1.4 ignore it) */
  call?: boolean;
}

/** A call's bar holding the composer's place (it marks itself `data-call-leaving` as it goes, for the composer to come
 * back under it). */
export function callHoldsComposer(chat: Element | null): boolean {
  return Boolean(chat?.querySelector("[data-call-surface]:not([data-call-leaving])"));
}

export type GlassEvent =
  | { type: "tap"; target: "back" | "title" | "right" | "plus" | "jump" | "clearReply" | "search" | "newBot" }
  | { type: "attachment"; id: string; action: "preview" | "remove" | "retry" }
  | { type: "takeoverTap"; target: TakeoverGlassButtonId }
  | { type: "takeoverMenu"; target: TakeoverGlassButtonId; key: string; text?: string }
  | { type: "viewerTap"; target: "close" | "share" }
  | { type: "pillTap"; slot: "top" | "bottom"; id: string; kind: "pill" | "action" | "dismiss" }
  | { type: "button"; index: number; kind?: GlassButtonKind }
  | { type: "text"; text: string }
  | { type: "submit" }
  | { type: "focus"; focused: boolean }
  | { type: "height"; height: number }
  /** the native field was emptied for the send `clearText` named */
  | { type: "cleared"; id: number }
  /** answers every update that asked for a composer: whether it is on screen now, or why not */
  | { type: "composer"; shown: boolean; reason?: string; frame?: GlassFrame }
  /** the keyboard starts to move: how far it will cover, its duration in seconds and when it started, in epoch ms. With
   * `lift` the native composer's field has it, and the native side lifts the whole web view by `lift` in the keyboard's
   * own animation; `settled` comes once that move has stopped, for the page to take the space itself. */
  | { type: "keyboard"; height: number; duration?: number; at?: number; lift?: number; settled?: boolean };

/** The phone's native glass chrome (ios/App/App/GlassChromePlugin.swift): it draws the chat header and composer
 * over the web view so the glass bends the transcript under it, and hands taps and typing back to the page. */
export interface GlassBridge {
  /** the native side answers each composer it is asked for with a `composer` event (apps before 1.3.1 never do) */
  acks?: boolean;
  /** the native side draws the floating jump-to-latest button in Liquid Glass */
  jump?: boolean;
  /** the native side draws the composer's reply strip inside the capsule */
  reply?: boolean;
  /** the native side draws image attachment thumbnails inside the capsule */
  attachments?: boolean;
  update(state: GlassState): void;
  setText(text: string, seq: number): void;
  /** Empties the native field for a send the page took, whatever it holds or the sequence it last took, and answers with
   * a `cleared` event (apps before 1.4 have none: their field follows `setText` alone). */
  clearText?(id: number): void;
  setAvatar(data: string | null): void;
  focus(): void;
  blur(): void;
  clear(): void;
  /** The chat's page starts a slide along `path` at `at` (epoch ms): the header and composer play the same path natively,
   * as far into it as the message took to arrive, with no frame updates in between. null stops them where they are. */
  slide(path: SlidePath | null, at?: number): void;
  /** The native header's own symbols, for the page's header to draw while it stands in for the glass. */
  glyphs?(): Promise<GlassGlyphs>;
  /** Home's top buttons, or null to hide them at once (apps before 1.3 have no home bar). */
  home?(state: HomeGlassState | null): void;
  /** Fullscreen takeover buttons in Liquid Glass, or null to hide them at once. */
  takeover?(state: TakeoverGlassState | null): void;
  /** Swipe-to-reply orb in Liquid Glass, or null to dismiss it (`instant` skips the exit animation). */
  swipeReply?(state: SwipeReplyGlassState | null, instant?: boolean): void;
  /** Pull-to-refresh orb in Liquid Glass, or null to dismiss it. */
  pullRefresh?(state: PullRefreshGlassState | null, instant?: boolean): void;
  /** Fullscreen image viewer controls in Liquid Glass, or null to hide them. */
  viewer?(state: ViewerGlassState | null): void;
  /** Floating status/toast Liquid Glass pill in the top or bottom slot, or null to dismiss (guarded by `clearId`). */
  pill?(slot: "top" | "bottom", state: FloatingPillGlassState | null, clearId?: string, instant?: boolean): void;
  onEvent(listener: (event: GlassEvent) => void): () => void;
}

/** A symbol as a black-on-clear png data url, and its size in points (css px). */
export interface GlassGlyph { data: string; w: number; h: number }
export type GlassGlyphs = Partial<Record<"back" | "right" | "jump", GlassGlyph>>;

/** The page's back and computer buttons wear the native header's symbols, so a sheet that hands the header to the page
 * (the glass cannot be drawn under it) changes nothing a person sees in them. */
export function applyGlassGlyphs(html: HTMLElement, glyphs: GlassGlyphs): boolean {
  const entries = Object.entries(glyphs).filter((entry): entry is [string, GlassGlyph] =>
    Boolean(entry[1] && typeof entry[1].data === "string" && entry[1].data.startsWith("data:image/png;base64,") && entry[1].w > 0 && entry[1].h > 0));
  if (entries.length === 0) return false;
  for (const [key, glyph] of entries) {
    html.style.setProperty(`--native-glyph-${key}`, `url("${glyph.data}")`);
    html.style.setProperty(`--native-glyph-${key}-w`, `${glyph.w}px`);
    html.style.setProperty(`--native-glyph-${key}-h`, `${glyph.h}px`);
  }
  html.dataset.nativeGlyphs = entries.map(([key]) => key).join(" ");
  return true;
}

let glyphsAsked: Promise<GlassGlyphs> | null = null;

const round = (n: number) => Math.round(n * 2) / 2;

export function frameOf(el: Element): GlassFrame {
  const box = el.getBoundingClientRect();
  return { x: round(box.left), y: round(box.top), w: round(box.width), h: round(box.height) };
}

/** Where a control rests on its page: `dx` (the page's own offset) comes off, and a press scaling it keeps its box, so
 * the native twin never shrinks with the page's unseen one. */
export function restingFrame(el: Element, dx: number): GlassFrame {
  const box = el.getBoundingClientRect();
  const w = (el as HTMLElement).offsetWidth || box.width;
  const h = (el as HTMLElement).offsetHeight || box.height;
  const cx = box.left + box.width / 2 - dx;
  const cy = box.top + box.height / 2;
  return { x: round(cx - w / 2), y: round(cy - h / 2), w: round(w), h: round(h) };
}

/** Covered by something drawn over the chat (a sheet, a context menu, a dialog): the topmost element at its centre is outside the chat. */
export function covered(el: Element, chat: Element): boolean {
  const doc = el.ownerDocument;
  const box = el.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return true;
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  if (x < 0 || y < 0 || x > doc.documentElement.clientWidth || y > doc.documentElement.clientHeight) return false;
  const hit = doc.elementFromPoint(x, y);
  return Boolean(hit) && !chat.contains(hit);
}

const JUMP_COVER = '[role="menu"], [role="listbox"], [data-sidebar-popover-menu], [data-composer-menu], [data-call-popover], [data-glass-nav], [data-testid="message-actions"]';

/** Covered by something outside the chat (a sheet, a dialog) or a floating menu/popover inside it. */
export function jumpCovered(el: Element, chat: Element): boolean {
  const doc = el.ownerDocument;
  const box = el.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return true;
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  if (x < 0 || y < 0 || x > doc.documentElement.clientWidth || y > doc.documentElement.clientHeight) return false;
  const hit = doc.elementFromPoint(x, y);
  if (!hit) return false;
  if (!chat.contains(hit)) return true;
  return hit !== el && !el.contains(hit) && Boolean(hit.closest(JUMP_COVER));
}

/** Which native control stands in for a button in the composer's actions, or null when it has no native twin. */
export function buttonKind(el: HTMLElement): GlassButtonKind | null {
  if (el.matches("[data-composer-stop]")) return "stop";
  if (el.matches('[data-voice-mic="start"]')) return "mic";
  if (el.matches('[data-voice-mic="send"]')) return "micSend";
  if (el.matches('[data-voice-mic="done"]')) return "keep";
  if (el.matches("[data-composer-send]")) return el.dataset.composerSend === "waits" ? "waits" : "send";
  if (el.closest("[data-composer-follow-up]") && el.getAttribute("aria-haspopup")) return "followUp";
  if (el.matches("[data-composer-discard]")) return "discard";
  if (el.matches('[data-call-button="composer"]')) return el.hasAttribute("data-call-active") ? "hangUp" : "call";
  return null;
}

const parsed = new Map<string, Rgba | null>();
let swatch: CanvasRenderingContext2D | null | undefined;
type Rgba = { r: number; g: number; b: number; a: number };

function rgba(value: string): Rgba | null {
  const color = value.trim();
  if (!color || color === "transparent") return null;
  if (/^#[0-9a-f]{6}$/i.test(color)) { const n = parseInt(color.slice(1), 16); return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 }; }
  const known = parsed.get(color);
  if (known !== undefined) return known;
  let out: Rgba | null = null;
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(color);
  if (rgb) {
    out = { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Number(rgb[4]) / (rgb[5] ? 100 : 1) };
  } else {
    // oklab(), color-mix() and the rest: let the canvas resolve it to a pixel
    if (swatch === undefined) {
      try { swatch = document.createElement("canvas").getContext("2d", { willReadFrequently: true }); } catch { swatch = null; }
    }
    if (swatch) {
      swatch.clearRect(0, 0, 1, 1);
      swatch.fillStyle = "#000";
      swatch.fillStyle = color;
      swatch.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = swatch.getImageData(0, 0, 1, 1).data;
      out = { r: r!, g: g!, b: b!, a: a! / 255 };
    }
  }
  if (parsed.size > 64) parsed.clear();
  parsed.set(color, out);
  return out;
}

const byte = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");

/** A computed css colour as #rrggbb, or null when it is mostly transparent or cannot be read. */
export function cssHex(value: string): string | null {
  const c = rgba(value);
  return c && c.a >= 0.5 ? `#${byte(c.r)}${byte(c.g)}${byte(c.b)}` : null;
}

/** A computed css colour as #rrggbb, or #rrggbbaa when it is see-through; null when it is not there at all. */
export function cssColor(value: string): string | null {
  const c = rgba(value);
  if (!c || c.a < 0.01) return null;
  const hex = `#${byte(c.r)}${byte(c.g)}${byte(c.b)}`;
  return c.a > 0.995 ? hex : hex + byte(c.a * 255);
}

/** Dark when the app's own ground is dark: the skin the person picked, whatever the system's appearance. */
export function darkGround(hex: string | null): boolean | null {
  if (!hex) return null;
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255) < 0.4;
}

/** The composer's action buttons in order, each with its native twin; null when one has none (the page keeps its own composer then). */
export function composerButtons(actions: Element | null): { buttons: GlassButton[]; elements: HTMLElement[] } | null {
  // in the order they are laid out, not written (a working bot's Stop sits last with `order`), and not as drawn mid-swap:
  // a control springing in carries a transform
  const elements = actions ? [...actions.querySelectorAll<HTMLElement>("button")].sort((a, b) => a.offsetLeft - b.offsetLeft) : [];
  const buttons: GlassButton[] = [];
  for (const el of elements) {
    const kind = buttonKind(el);
    if (!kind) return null;
    const { fill, ink } = restingColors(el);
    buttons.push({ kind, disabled: (el as HTMLButtonElement).disabled, label: el.getAttribute("aria-label") ?? "", fill, ink });
  }
  return { buttons, elements };
}

/** The button's fill and ink as they will rest: while a colour transition or the slot's handoff animation runs, where
 * it is heading, so the native button springs there once instead of chasing every frame between. */
export function restingColors(el: HTMLElement): { fill?: string; ink?: string } {
  const style = getComputedStyle(el);
  let fill = style.backgroundColor;
  let ink = style.color;
  for (const animation of el.getAnimations?.() ?? []) {
    const frames = animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : [];
    const end = frames[frames.length - 1] as Record<string, unknown> | undefined;
    if (typeof end?.backgroundColor === "string") fill = end.backgroundColor;
    if (typeof end?.color === "string") ink = end.color;
  }
  return { fill: cssColor(fill) ?? undefined, ink: cssColor(ink) ?? undefined };
}

export function sameState(a: GlassState | null, b: GlassState | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function drawSvgPart(ctx: CanvasRenderingContext2D, svg: SVGSVGElement, box: DOMRect, scale: number): boolean {
  const r = svg.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const vb = svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const [minX, minY, vbW, vbH] = vb && vb.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 && vb[3]! > 0
    ? vb as [number, number, number, number]
    : [0, 0, r.width, r.height];
  const shapes = svg.querySelectorAll("path, rect");
  if (!shapes.length) return false;
  ctx.save();
  ctx.translate((r.left - box.left) * scale, (r.top - box.top) * scale);
  ctx.scale((r.width * scale) / vbW, (r.height * scale) / vbH);
  ctx.translate(-minX, -minY);
  let drew = false;
  for (const shape of shapes) {
    const raw = shape.getAttribute("fill") ?? "";
    const computed = !raw || raw === "currentColor" || raw.includes("var(") ? getComputedStyle(shape).fill : raw;
    const fill = computed || raw;
    if (!fill || fill === "none") continue;
    ctx.fillStyle = fill;
    if (shape.tagName.toLowerCase() === "rect") {
      const x = Number(shape.getAttribute("x") ?? 0);
      const y = Number(shape.getAttribute("y") ?? 0);
      const w = Number(shape.getAttribute("width") ?? 0);
      const h = Number(shape.getAttribute("height") ?? 0);
      if (Number.isFinite(x) && Number.isFinite(y) && w > 0 && h > 0) {
        ctx.fillRect(x, y, w, h);
        drew = true;
      }
      continue;
    }
    const d = shape.getAttribute("d");
    if (!d || typeof Path2D !== "function") continue;
    ctx.fill(new Path2D(d));
    drew = true;
  }
  ctx.restore();
  return drew;
}

/** The chat's avatar as a png, from the canvases, images and static SVGs the page drew it with. */
export function rasterAvatar(host: Element | null): string | null {
  if (!host) return null;
  const box = host.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const scale = 3;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(box.width * scale);
  canvas.height = Math.round(box.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  let drawn = 0;
  for (const part of host.querySelectorAll<HTMLCanvasElement | HTMLImageElement | SVGSVGElement>("canvas, img, svg")) {
    if (part instanceof SVGSVGElement || part.tagName.toLowerCase() === "svg") {
      try {
        if (drawSvgPart(ctx, part as SVGSVGElement, box, scale)) drawn += 1;
      } catch { /* an SVG not ready yet */ }
      continue;
    }
    if (part instanceof HTMLImageElement && (!part.complete || !part.naturalWidth || !part.naturalHeight)) continue;
    const r = part.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    try {
      ctx.drawImage(part, (r.left - box.left) * scale, (r.top - box.top) * scale, r.width * scale, r.height * scale);
      drawn += 1;
    } catch { /* an image still loading */ }
  }
  if (!drawn) return null;
  try { return canvas.toDataURL("image/png"); } catch { return null; }
}

const setValue = typeof HTMLTextAreaElement !== "undefined"
  ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
  : undefined;

/** Types into the page's own field as a person would, so its mentions, commands and draft all follow. */
export function typeInto(field: HTMLTextAreaElement, text: string): void {
  if (field.value === text) return;
  setValue?.call(field, text);
  field.setSelectionRange(text.length, text.length);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function spoken(strip: Element | null): string {
  if (!strip) return "";
  return [...strip.childNodes].filter((node) => !(node instanceof Element && (node.matches(".sr-only") || node.querySelector("canvas, svg")))).map((node) => node.textContent ?? "").join(" ").trim();
}

function readHeader(nav: Element, dx: number): GlassHeader | null {
  const back = nav.querySelector("[data-glass=back]");
  const title = nav.querySelector("[data-glass=title]");
  const right = nav.querySelector<HTMLElement>("[data-glass=right]");
  if (!back || !title) return null;
  return {
    back: restingFrame(back, dx),
    title: restingFrame(title, dx),
    right: right ? restingFrame(right, dx) : null,
    name: title.querySelector("[data-glass-name]")?.textContent ?? "",
    live: Boolean(right?.querySelector("[data-glass-live]")),
    backLabel: back.getAttribute("aria-label") ?? "",
    titleLabel: title.getAttribute("aria-label") ?? "",
    rightLabel: right?.getAttribute("aria-label") ?? "",
  };
}

function translateY(el: Element): number {
  const matrix = /^matrix(3d)?\((.*)\)$/.exec(getComputedStyle(el).transform);
  if (!matrix) return 0;
  const parts = matrix[2]!.split(",").map(Number);
  return (matrix[1] ? parts[13] : parts[5]) || 0;
}

/** How far the keyboard ride lifts the composer's dock right now (negative is up), mid-transition too. */
export function keyboardRide(shell: Element): number {
  const dock = shell.closest("[data-grok-inset]");
  return dock ? translateY(dock) : 0;
}

function readJump(el: HTMLElement, baseline: number, dx: number): GlassJump {
  const raw = restingFrame(el, dx);
  const frame: GlassFrame = { ...raw, y: round(raw.y - translateY(el)) };
  return {
    frame,
    gap: Math.round(baseline - (frame.y + frame.h - keyboardRide(el))),
    label: el.getAttribute("aria-label") ?? "",
  };
}

/** The empty space between the transcript's last row and the bottom of its scroller, in whole px. */
export function transcriptRoom(chat: Element | null): number {
  const list = chat?.querySelector(".glass-scroller");
  // scrollHeight never drops below clientHeight, so a short transcript is measured by its content's own boxes
  if (!list || list.scrollHeight > list.clientHeight + 1) return 0;
  const top = list.getBoundingClientRect().top;
  let end = 0;
  for (const child of list.children) {
    const position = getComputedStyle(child).position;
    if (position === "absolute" || position === "fixed") continue;
    end = Math.max(end, child.getBoundingClientRect().bottom - top);
  }
  return Math.max(0, Math.round(list.clientHeight - end));
}

function readComposer(
  shell: HTMLElement,
  baseline: number,
  dx: number,
  room: number,
  allowReply: boolean,
  allowAttachments: boolean,
  thumbCache: ThumbCache,
  attachmentCache: Map<string, ThumbCache>,
): { composer: GlassComposer; elements: HTMLElement[]; field: HTMLTextAreaElement | null; pending: boolean } | null {
  if (hasStrips(shell, allowReply, allowAttachments)) return null;
  const field = shell.querySelector<HTMLTextAreaElement>("textarea");
  const actions = composerButtons(shell.querySelector("[data-composer-actions]"));
  if (!actions) return null;
  const voiceStrip = shell.querySelector("[data-composer-voice]");
  const recording = Boolean(voiceStrip) || Boolean(field?.closest(".hidden"));
  if (!field && !recording) return null;
  const frame = restingFrame(shell, dx);
  const plus = shell.querySelector("[data-composer-plus]");
  const reply = allowReply ? readReply(shell, thumbCache) : null;
  const attachments = allowAttachments ? readAttachments(shell, attachmentCache) : null;
  return {
    composer: {
      frame,
      // whole pixels: mid-ride the measured gap wobbles by half a pixel, and each wobble would re-pin the native composer
      gap: Math.round(baseline - (frame.y + frame.h - keyboardRide(shell))),
      plus: Boolean(plus),
      plusLabel: plus?.closest("button")?.getAttribute("aria-label") ?? plus?.getAttribute("aria-label") ?? "",
      placeholder: field?.placeholder ?? "",
      disabled: Boolean(field?.disabled),
      voice: recording ? spoken(voiceStrip) : null,
      voiceHeard: recording && Boolean(voiceStrip?.querySelector("[data-voice-heard]")),
      ...(reply ? { reply: reply.reply } : {}),
      ...(attachments ? { attachments: attachments.attachments } : {}),
      buttons: actions.buttons,
      returnSends: field?.getAttribute("enterkeyhint") === "send",
      fontScale: appliedTextScale(),
      room,
    },
    elements: actions.elements,
    field,
    pending: Boolean(reply?.pending || attachments?.pending),
  };
}

/** Why the page keeps its own composer instead of the native one, for the trace. */
function handoffReason(shell: HTMLElement | null, chat: HTMLElement, allowReply: boolean, allowAttachments: boolean): string {
  if (callHoldsComposer(chat)) return "call";
  if (!shell) return "no composer";
  if (covered(shell, chat)) return "covered";
  if (hasStrips(shell, allowReply, allowAttachments)) return "strip";
  if (!composerButtons(shell.querySelector("[data-composer-actions]"))) return "button without a twin";
  return "no field";
}

/** Epoch ms timestamp passed to native `slide` so the native side accounts for bridge delivery latency. */
export function slideStart(now = performance.timeOrigin + performance.now()): number {
  return Math.round(now);
}

/** The native field keeps the highest sequence it has taken for as long as the app runs, across chats: a count that
 * started again with each chat had every later chat's text (a send clearing the field among it) refused as stale. */
let textSeq = 0;
export function nextTextSeq(): number {
  textSeq += 1;
  return textSeq;
}

/** A send the page took out of the native field: text the native side reports within this long that still begins with
 * what was sent is the field's own text from before the clear (a late keystroke, a committed autocorrection or dictation
 * guess), never new typing, and is not typed back into the emptied composer. */
export const SENT_ECHO_MS = 1500;
/** a tap on Send the page did not take (an upload still running, nothing to send) stops waiting for the field to empty */
const SEND_TAKE_MS = 1000;

/** Watches each native Send for the page taking it: once the page's field empties, the native one is cleared outright
 * (keyed to that send, not left to a text diff), and the old text the native side may still send is refused. */
export function sendClearing() {
  let tapped: { text: string; at: number } | null = null;
  let sent: { id: number; text: string; until: number } | null = null;
  return {
    tapped(text: string, now: number) { tapped = text.trim() ? { text, at: now } : null; },
    /** the send the page just took, once its field shows it emptied */
    taken(value: string, now: number): { id: number; text: string } | null {
      if (!tapped) return null;
      if (value.trim() !== "") {
        if (now - tapped.at > SEND_TAKE_MS) tapped = null;
        return null;
      }
      sent = { id: nextTextSeq(), text: tapped.text, until: now + SENT_ECHO_MS };
      tapped = null;
      return sent;
    },
    /** the native field's text from before a send's clear, arriving after the tap: `taken` once the native field has
     * been told to empty, else the page is still taking it and empties it then */
    echo(text: string, now: number): { taken: boolean } | null {
      const old = (from: string) => {
        const before = from.trimEnd();
        let same = 0;
        while (same < before.length && same < text.length && text[same] === before[same]) same += 1;
        // an autocorrection or a dictation guess settling rewrites the end of what was sent; new typing shares little of it
        return text.trim() !== "" && same >= Math.ceil(before.length * 0.6) && same >= before.length - 32;
      };
      if (tapped && now - tapped.at <= SEND_TAKE_MS && old(tapped.text)) return { taken: false };
      return sent && now <= sent.until && old(sent.text) ? { taken: true } : null;
    },
  };
}

const FRESH_FRAMES = 30;
const IDLE_EVERY = 15;
const AVATAR_MS = 1000;
/** The native side gets the whole state again this often even when nothing changed: chrome it lost (a page reload's
 * reset, a hide it missed) comes back within this long. */
export const REASSERT_MS = 1000;

/** Inside a chat's transcript, whose rows (a reply streaming in) never move the header or the composer. */
function inTranscript(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return Boolean(el?.closest("[role=log]"));
}

/** While a chat is open, the native glass draws its header and composer: the page's own chrome is measured where it rests
 * on its page and anything that changed goes to the native side, which also takes the taps and typing and hands them
 * back here. The page's chrome stays in place, transparent, so its layout, menus and focus all keep working. A slide of
 * the page goes over as one message (the returned function, for NavStack's `onSlide`), so the native chrome plays the
 * page's own path instead of following it frame by frame; only a finger dragging the page is followed. */
export function useNativeGlass(platform: MobilePlatform, rootRef: RefObject<HTMLElement | null>, chatOpen: boolean): (path: SlidePath | null) => void {
  const slideRef = useRef<{ until: number; to: number } | null>(null);
  const onSlide = useCallback((path: SlidePath | null) => {
    const glass = platform.glass;
    if (!glass) return;
    if (!path) {
      if (!slideRef.current) return;
      slideRef.current = null;
      glass.slide(null);
      return;
    }
    if (path.duration <= 0) {
      slideRef.current = null;
      glass.slide(path);
      return;
    }
    slideRef.current = { until: performance.now() + path.duration, to: path.points.at(-1) ?? 0 };
    glass.slide(path, slideStart());
  }, [platform]);

  useEffect(() => {
    const glass = platform.glass;
    const root = rootRef.current;
    if (!glass || !root || !chatOpen) return;
    const html = document.documentElement;
    if (glass.glyphs && html.dataset.nativeGlyphs === undefined) {
      glyphsAsked ??= glass.glyphs();
      void glyphsAsked.then((glyphs) => applyGlassGlyphs(html, glyphs), () => {});
    }
    let frame = 0;
    let last: GlassState | null = null;
    let elements: HTMLElement[] = [];
    let field: HTMLTextAreaElement | null = null;
    // null until the first frame: a chat opening hands the native field its own text (or none), whatever the last one left
    let fromNative: string | null = null;
    let toNative: string | null = null;
    let avatar: string | null | undefined;
    let avatarAt = 0;
    let avatarName: string | null = null;
    let nativeFocused = false;
    let sentAt = 0;
    let composerShown = false;
    const handoff = composerHandoff();
    const sends = sendClearing();
    const thumbCache: ThumbCache = { src: "", data: null };
    const attachmentCache = new Map<string, ThumbCache>();
    const allowReply = glass.reply === true;
    const allowAttachments = glass.attachments === true;
    const liveField = () => (field?.isConnected ? field : shell()?.querySelector("textarea") ?? null);
    let safeBottom = cssPx(root, "var(--m-safe-bottom)");

    const chat = () => root.querySelector<HTMLElement>("[data-mobile-chat]");
    const nav = () => chat()?.querySelector<HTMLElement>("[data-glass-nav]") ?? null;
    const shell = () => chat()?.querySelector<HTMLElement>('[data-tour="composer"]') ?? null;
    const jump = () => chat()?.querySelector<HTMLElement>(".chat-jump") ?? null;

    // the page is measured each frame only while something outside the transcript changed in the last half second or a
    // page slides; otherwise four times a second, so a resting or streaming chat does not restyle every frame for it
    let fresh = FRESH_FRAMES;
    let count = 0;
    const changed = new MutationObserver((records) => {
      if (records.some((record) => !inTranscript(record.target))) fresh = FRESH_FRAMES;
    });
    changed.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const skinChanged = new MutationObserver(() => { fresh = FRESH_FRAMES; });
    const onVisible = () => {
      if (document.hidden) return;
      fresh = FRESH_FRAMES;
      last = null;
      handoff.recheck();
    };
    skinChanged.observe(html, { attributes: true, attributeFilter: ["data-skin", "class", "style"] });
    const flag = (name: "nativeGlassHeader" | "nativeGlassComposer" | "nativeGlassJump", on: boolean) => {
      if (on && html.dataset[name] === undefined) html.dataset[name] = "";
      else if (!on && html.dataset[name] !== undefined) delete html.dataset[name];
    };

    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (document.hidden) return;
      count += 1;
      const took = sends.taken(liveField()?.value ?? "", performance.now());
      if (took) {
        kbTrace("send taken", { id: took.id, length: took.text.length });
        // a draft put back after a failed send differs from both, so it goes to the native field again
        fromNative = null;
        toNative = "";
        glass.setText("", took.id);
        glass.clearText?.(took.id);
      }
      // what the page itself put in its field (a draft, a cleared send, a picked mention) goes to the native field
      if (field && field.value !== fromNative && field.value !== toNative) {
        toNative = field.value;
        glass.setText(field.value, nextTextSeq());
      }
      const now = performance.now();
      // a slide holds its target until the page says it stopped: its compositor may land a frame after this clock
      const pageMoving = root.querySelector(".mobile-page[data-moving]") !== null;
      const slide = slideRef.current && (now < slideRef.current.until || pageMoving) ? slideRef.current : null;
      if (!slide) slideRef.current = null;
      // a page the native side is sliding on its own needs no frames; only a finger dragging it does
      const dragged = !slide && pageMoving;
      if (fresh > 0) fresh -= 1;
      else if (!dragged && count % IDLE_EVERY !== 0) return;
      const chatEl = chat();
      const navEl = nav();
      const shellEl = shell();
      const left = chatEl?.closest(".mobile-page")?.getBoundingClientRect().left ?? 0;
      const title = navEl?.querySelector("[data-glass=title]");
      const header = chatEl && navEl && title && !covered(title, chatEl) ? readHeader(navEl, left) : null;
      const kb = parseFloat(root.style.getPropertyValue("--m-kb")) || 0;
      const baseline = window.innerHeight - Math.max(safeBottom, kb);
      const calling = callHoldsComposer(chatEl);
      const read = chatEl && shellEl && !calling && !covered(shellEl, chatEl) ? readComposer(shellEl, baseline, left, transcriptRoom(chatEl), allowReply, allowAttachments, thumbCache, attachmentCache) : null;
      const jumpEl = glass.jump ? jump() : null;
      const jumpHidden = Boolean(chatEl && jumpEl && jumpCovered(jumpEl, chatEl));
      const nativeJump = chatEl && jumpEl && !jumpHidden ? readJump(jumpEl, baseline, left) : null;
      handoff.want(Boolean(read));
      const nativeComposer = read && (!glass.acks || handoff.native()) ? read.composer : null;
      if ((glass.acks && handoff.pending()) || read?.pending) fresh = Math.max(fresh, 1);
      elements = read?.elements ?? [];
      field = read?.field ?? null;
      const styles = getComputedStyle(root);
      const next: GlassState = {
        dark: darkGround(cssHex(styles.getPropertyValue("--color-app"))) ?? (html.dataset.skin === "grok-dark" || root.dataset.scheme === "dark"),
        // with nothing drawn natively (a sheet over the chat, scaling the page back) the offset has nothing to move
        offset: slide ? slide.to : header || read || nativeJump ? round(left) : last?.offset ?? round(left),
        accent: styles.getPropertyValue("--color-accent").trim(),
        ground: cssHex(styles.getPropertyValue("--color-app")) ?? "",
        header,
        composer: nativeComposer,
        handoff: Boolean(chatEl) && (!header || !nativeComposer),
        ...(glass.jump ? { jump: nativeJump, ...(jumpHidden ? { jumpHandoff: true } : {}) } : {}),
        ...(calling ? { call: true } : {}),
      };
      // the pill's picture goes before the update that shows it: a chat's header never arrives with the last chat's
      // avatar, and a new name brings its avatar along. A drawn one is checked again once a second, never mid-slide;
      // one not drawn yet, soon
      const renamed = Boolean(header) && header!.name !== avatarName;
      const avatarDue = renamed || avatar === undefined || (avatar === null ? now - avatarAt > 100 : !slide && !dragged && now - avatarAt > AVATAR_MS);
      if (header && avatarDue) {
        avatarAt = now;
        avatarName = header.name;
        const drawn = rasterAvatar(navEl!.querySelector("[data-glass-avatar]"));
        if (drawn !== avatar) { avatar = drawn; glass.setAvatar(drawn); }
      }
      flag("nativeGlassHeader", Boolean(header));
      const nativeOwns = glass.acks ? handoff.pageHidden() : Boolean(next.composer);
      flag("nativeGlassComposer", nativeOwns);
      flag("nativeGlassJump", Boolean(nativeJump));
      if (nativeOwns !== composerShown) {
        composerShown = nativeOwns;
        kbTrace(composerShown ? "native composer" : "page composer", { why: composerShown ? "shown" : handoff.refusal() ?? (chatEl ? handoffReason(shellEl, chatEl, allowReply, allowAttachments) : "chat closed") });
        // the page's field kept the keyboard while it had the composer (a reply, a popover): the native one takes it back
        if (composerShown && field && document.activeElement === field) glass.focus();
      }
      if (!sameState(last, next) || (!slide && !dragged && now - sentAt > REASSERT_MS)) {
        last = next;
        sentAt = now;
        glass.update(next);
      }
      if (field && field.value !== fromNative && field.value !== toNative) {
        toNative = field.value;
        glass.setText(field.value, nextTextSeq());
      }
    };

    const click = (el: Element | null | undefined) => (el instanceof HTMLElement ? el : null)?.click();
    const stop = glass.onEvent((event) => {
      switch (event.type) {
        case "tap": {
          if (event.target === "plus") click(shell()?.querySelector("[data-composer-plus]")?.closest("button") ?? shell()?.querySelector("[data-composer-plus]"));
          else if (event.target === "clearReply") click(shell()?.querySelector("[data-composer-reply] button"));
          else if (event.target === "jump") click(jump());
          else click(nav()?.querySelector(`[data-glass=${event.target}]`));
          break;
        }
        case "attachment": {
          const item = shell()?.querySelector(`[data-composer-attachment][data-attachment-id="${CSS.escape(event.id)}"]`);
          click(item?.querySelector(`[data-attachment-action="${event.action}"]`));
          break;
        }
        // the control the native one stood in for, by kind: the page's set may have moved on since that frame
        case "button": {
          if (event.kind === "send" || event.kind === "micSend") {
            kbTrace("send tap", { kind: event.kind, keyboard: root.dataset.keyboard ?? "down" });
            sends.tapped(liveField()?.value ?? "", performance.now());
          }
          click((event.kind && elements.find((el) => buttonKind(el) === event.kind)) || elements[event.index]);
          break;
        }
        case "text": {
          const echo = sends.echo(event.text, performance.now());
          if (echo) {
            kbTrace("stale text dropped", { taken: echo.taken ? 1 : 0, length: event.text.length });
            if (echo.taken) {
              glass.setText("", nextTextSeq());
              glass.clearText?.(nextTextSeq());
            }
            break;
          }
          fromNative = event.text;
          toNative = null;
          const target = liveField();
          if (target) typeInto(target, event.text);
          break;
        }
        case "cleared": kbTrace("native cleared", { id: event.id }); break;
        case "submit": {
          const target = liveField();
          sends.tapped(target?.value ?? "", performance.now());
          const sendButton = elements.find((el) => buttonKind(el) === "send" || buttonKind(el) === "micSend");
          if (sendButton) click(sendButton);
          else target?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
          break;
        }
        case "focus": {
          nativeFocused = event.focused;
          if (event.focused) root.dataset.glassFocused = ""; else delete root.dataset.glassFocused;
          break;
        }
        case "height": shell()?.style.setProperty("--glass-composer-h", `${event.height}px`); break;
        case "composer": {
          handoff.ack(event);
          fresh = FRESH_FRAMES;
          kbTrace("composer ack", { shown: event.shown ? 1 : 0, reason: event.reason ?? "" });
          break;
        }
      }
    });

    // the page focusing its own field (a reply, "answer in the chat below") raises the native one instead
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement) || html.dataset.nativeGlassComposer === undefined || !shell()?.contains(target)) return;
      target.blur();
      glass.focus();
    };
    const onResize = () => { safeBottom = cssPx(root, "var(--m-safe-bottom)"); fresh = FRESH_FRAMES; };
    document.addEventListener("focus", onFocus, true);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("resize", onResize);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      changed.disconnect();
      skinChanged.disconnect();
      stop();
      document.removeEventListener("focus", onFocus, true);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("resize", onResize);
      if (nativeFocused) glass.blur();
      delete root.dataset.glassFocused;
      delete html.dataset.nativeGlassHeader;
      delete html.dataset.nativeGlassComposer;
      delete html.dataset.nativeGlassJump;
      slideRef.current = null;
      glass.clear();
    };
  }, [platform, rootRef, chatOpen]);

  return onSlide;
}
