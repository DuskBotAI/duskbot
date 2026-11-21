import type { CSSProperties } from "react";
import { contrastRatio, fromOklch, mixSrgb, toneForSurface, toOklch } from "./color-contrast";
import { MASCOT_INK, MAUS_COLOR_NAMES, MAUS_COLORS, type MausColor } from "./mascot";

const WHITE = "#ffffff";
const BLACK = "#000000";
const INK = "#101410";
const DARK_INK = "#f5f5f5";
const GROK_LIGHT_APP = "#fdfdfd";
const GROK_DARK_APP = "#121212";
const HOVER_LIGHTNESS_STEP = 0.05;

export const BUBBLE_TOKEN_MIN = 3;

export const MENTION_CHIP_MIX = 0.22;
export const SELECTION_BLACK_MIX = 0.35;

export type Scheme = "light" | "dark";

export type GrokFill = { bubble: string; button: string; hover: string; ink: string; buttonInk: string };

const NEUTRAL_FILL: Record<Scheme, GrokFill> = {
  light: { bubble: "#1c1c1c", button: "#1c1c1c", hover: "#363636", ink: WHITE, buttonInk: "#fcfcfc" },
  dark: { bubble: "#3b3b3b", button: "#f5f5f5", hover: "#dbdbdb", ink: DARK_INK, buttonInk: "#121212" },
};

const isNeutral = (color: MausColor): boolean => color === "silver" || color === "chrome";

function fillForInk(hex: string, ink: string, min: number): string {
  if (contrastRatio(ink, hex) >= min) return hex;
  const { l, c, h } = toOklch(hex);
  let lo = 0;
  let hi = l;
  let best = hex;
  for (let step = 0; step < 30; step += 1) {
    const mid = (lo + hi) / 2;
    const candidate = fromOklch({ l: mid, c, h });
    if (contrastRatio(ink, candidate) >= min) {
      best = candidate;
      lo = mid;
    } else hi = mid;
  }
  return best;
}

function shiftLightness(hex: string, delta: number): string {
  const { l, c, h } = toOklch(hex);
  return fromOklch({ l: Math.max(0, Math.min(1, l + delta)), c, h });
}

function chromaticFill(color: MausColor, scheme: Scheme): GrokFill {
  const ink = scheme === "light" ? WHITE : DARK_INK;
  const bubble = fillForInk(MASCOT_INK[color], ink, BUBBLE_TOKEN_MIN);
  const hover = shiftLightness(bubble, scheme === "light" ? -HOVER_LIGHTNESS_STEP : HOVER_LIGHTNESS_STEP);
  return { bubble, button: bubble, hover, ink, buttonInk: ink };
}

const BOT_FILLS = Object.fromEntries(
  MAUS_COLOR_NAMES.map((color) => [
    color,
    isNeutral(color)
      ? NEUTRAL_FILL
      : { light: chromaticFill(color, "light"), dark: chromaticFill(color, "dark") },
  ]),
) as Record<MausColor, Record<Scheme, GrokFill>>;

export function grokFill(color: MausColor, scheme: Scheme): GrokFill {
  return BOT_FILLS[color][scheme];
}

export function bothSchemes(light: string, dark: string): string {
  return light === dark ? light : `light-dark(${light}, ${dark})`;
}

const BOT_ACCENT_TEXT = Object.fromEntries(
  MAUS_COLOR_NAMES.map((color) => [
    color,
    isNeutral(color)
      ? "var(--color-ink)"
      : bothSchemes(
          toneForSurface(MASCOT_INK[color], GROK_LIGHT_APP, 4.5),
          toneForSurface(MASCOT_INK[color], GROK_DARK_APP, 4.5),
        ),
  ]),
) as Record<MausColor, string>;

export function grokAccentText(color: MausColor): string {
  return BOT_ACCENT_TEXT[color];
}

export function grokFills(color: MausColor): GrokFill {
  const light = grokFill(color, "light");
  const dark = grokFill(color, "dark");
  return Object.fromEntries(Object.entries(light).map(([key, value]) => [key, bothSchemes(value, dark[key as keyof GrokFill])])) as GrokFill;
}

export type UserBubbleTone = {
  background: string;
  gradient: string;
  ink: string;
  secondary: string;
  tertiary: string;
  panel: string;
  inset: string;
  raised: string;
  raisedHover: string;
  control: string;
  hairline: string;
  accent: string;
  accentText: string;
  accentInk: string;
  focus: string;
  danger: string;
  dangerInk: string;
  success: string;
  successInk: string;
  selection: string;
  selectionInk: string;
};

/** Grok's faint top gloss over the fill. */
export const BUBBLE_GLOSS = "linear-gradient(rgb(255 255 255 / 0.06), transparent)";

/** `hue` eased toward white until it holds `min` on `on`. */
function lightEnough(hue: string, on: string, min: number): string {
  if (contrastRatio(hue, on) >= min) return hue;
  let lo = 0;
  let hi = 1;
  let best = WHITE;
  for (let step = 0; step < 22; step += 1) {
    const mid = (lo + hi) / 2;
    const candidate = mixSrgb(WHITE, hue, mid);
    if (contrastRatio(candidate, on) >= min) {
      best = candidate;
      hi = mid;
    } else lo = mid;
  }
  return best;
}

/** The ink eased toward the fill until it holds just `min`; the ink itself when it cannot. */
function quiet(ink: string, background: string, min: number): string {
  let lo = 0;
  let hi = 1;
  let best = ink;
  for (let step = 0; step < 22; step += 1) {
    const mid = (lo + hi) / 2;
    const candidate = mixSrgb(ink, background, mid);
    if (contrastRatio(candidate, background) >= min) {
      best = candidate;
      hi = mid;
    } else lo = mid;
  }
  return best;
}

function darkInkOn(fill: string): string {
  return contrastRatio(INK, fill) >= contrastRatio(WHITE, fill) ? INK : WHITE;
}

function toneOn(color: MausColor, { bubble: background, ink }: GrokFill): UserBubbleTone {
  const body = contrastRatio(ink, background);
  const secondary = quiet(ink, background, Math.min(6.2, Math.max(BUBBLE_TOKEN_MIN, body * 0.82)));
  let tertiary = quiet(ink, background, Math.min(4.5, Math.max(BUBBLE_TOKEN_MIN, body * 0.68)));
  if (contrastRatio(tertiary, background) > contrastRatio(secondary, background)) tertiary = secondary;
  // surfaces inside the bubble step darker on a vivid fill and lighter on grok's near-black grey, so the ink only gains
  const dim = toOklch(background).l < 0.4;
  const step = dim ? WHITE : BLACK;
  const inset = mixSrgb(BLACK, background, 0.2);
  const raised = mixSrgb(step, background, 0.1);
  const accent = lightEnough(MAUS_COLORS[color], background, BUBBLE_TOKEN_MIN);
  const danger = lightEnough("#ff6d80", background, BUBBLE_TOKEN_MIN);
  const success = lightEnough("#7ddead", background, BUBBLE_TOKEN_MIN);
  return {
    background,
    gradient: BUBBLE_GLOSS,
    ink,
    secondary,
    tertiary,
    panel: mixSrgb(inset, background, 0.45),
    inset,
    raised,
    raisedHover: mixSrgb(step, background, 0.16),
    control: raised,
    hairline: lightEnough(mixSrgb(WHITE, background, 0.45), background, BUBBLE_TOKEN_MIN),
    accent,
    accentText: accent,
    accentInk: darkInkOn(accent),
    focus: ink,
    danger,
    dangerInk: darkInkOn(danger),
    success,
    successInk: darkInkOn(success),
    selection: dim ? mixSrgb(WHITE, background, 0.25) : selectionBackground(background),
    selectionInk: ink,
  };
}

/** The bubble's tokens in one scheme as plain hex, or, with no scheme, as css values that follow the color-scheme. */
export function userBubbleTone(color: MausColor, scheme?: Scheme): UserBubbleTone {
  if (scheme) return toneOn(color, grokFill(color, scheme));
  const light = toneOn(color, grokFill(color, "light"));
  const dark = toneOn(color, grokFill(color, "dark"));
  return Object.fromEntries(
    Object.entries(light).map(([key, value]) => [key, bothSchemes(value, dark[key as keyof UserBubbleTone])]),
  ) as UserBubbleTone;
}

export function mentionChipBackground(mention: string, inset: string): string {
  return mixSrgb(mention, inset, MENTION_CHIP_MIX);
}

export function selectionBackground(background: string): string {
  return mixSrgb(BLACK, background, SELECTION_BLACK_MIX);
}

export function quoteSurface(inset: string, background: string): string {
  return mixSrgb(inset, background, 0.7);
}

/** `flat`: Simple mode's one even fill, the tone's background with no gloss over it. */
export function userBubbleStyle(color: MausColor, { flat = false }: { flat?: boolean } = {}): CSSProperties {
  const tone = userBubbleTone(color);
  return {
    backgroundColor: tone.background,
    backgroundImage: flat ? "none" : tone.gradient,
    "--color-bubble-user": tone.background,
    "--color-bubble-user-ink": tone.ink,
    "--color-ink": tone.ink,
    "--color-ink-secondary": tone.secondary,
    "--color-ink-tertiary": tone.tertiary,
    "--color-panel": tone.panel,
    "--color-inset": tone.inset,
    "--color-raised": tone.raised,
    "--color-raised-hover": tone.raisedHover,
    "--color-control": tone.control,
    "--color-hairline": tone.hairline,
    "--color-accent": tone.accent,
    "--color-accent-text": tone.accentText,
    "--color-accent-ink": tone.accentInk,
    "--color-focus": tone.focus,
    "--color-danger": tone.danger,
    "--color-danger-ink": tone.dangerInk,
    "--color-success": tone.success,
    "--color-success-ink": tone.successInk,
    "--bubble-selection": tone.selection,
    "--bubble-selection-ink": tone.selectionInk,
  } as CSSProperties;
}

/** Grok's per-colour fills, as css values that follow the color-scheme. Here rather than in chat-bubble, so the home
 * page's composer can read them without pulling the chat (and the store) into its bundle. */
export const GROK_BOT_FILLS: Partial<Record<MausColor, GrokFill>> = Object.fromEntries(
  MAUS_COLOR_NAMES.map((color) => [color, grokFills(color)]),
);
