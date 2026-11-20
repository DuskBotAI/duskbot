import type { CSSProperties } from "react";
import { botButtonTone } from "./bot-button";
import { contrastRatio, toneForSurface } from "./color-contrast";
import { MAUS_COLORS, type MausColor } from "./mascot";
import { bothSchemes, type Scheme } from "./user-bubble-tone";

/** The phone's grouped sheet: its page and the rows on it, in each scheme. */
export const SHEET_SURFACES: Record<Scheme, { page: string; row: string }> = {
  light: { page: "#f0f0f1", row: "#ffffff" },
  dark: { page: "#1e1e1e", row: "#2a2a2d" },
};

/** A bot's accent inside its own sheet: `fill` for a switch that is on, `ink` for words on that fill, `text` for words
 * in the bot's colour. Words keep AA (4.5:1) on what they sit on, and
 * the fill keeps 3:1 against the rows and page, so a very light colour (yellow, silver) comes out a darker shade. */
export type BotAccent = { fill: string; ink: string; text: string };

const INKS = ["#fafafa", "#141414"] as const;

export function botAccent(color: MausColor, scheme: Scheme): BotAccent {
  const { page, row } = SHEET_SURFACES[scheme];
  let fill = toneForSurface(toneForSurface(botButtonTone(color, scheme).fill, row, 3), page, 3);
  const ink = INKS.reduce((best, candidate) => (contrastRatio(candidate, fill) > contrastRatio(best, fill) ? candidate : best));
  if (contrastRatio(ink, fill) < 4.5) fill = toneForSurface(fill, ink, 4.5);
  const text = toneForSurface(toneForSurface(fill, row, 4.5), page, 4.5);
  return { fill, ink, text };
}

export function botAccentStyle(color: MausColor): CSSProperties {
  const light = botAccent(color, "light");
  const dark = botAccent(color, "dark");
  return {
    "--bot-accent": bothSchemes(light.fill, dark.fill),
    "--bot-accent-ink": bothSchemes(light.ink, dark.ink),
    "--bot-accent-text": bothSchemes(light.text, dark.text),
  } as CSSProperties;
}

/** What a bot's own sheet wears to take its accent: the mark the phone's css keys on and the colours; nothing for a colour
 * the app does not know, which keeps ink. */
export function botAccentScope(color: string | undefined): { "data-bot-accent"?: ""; style?: CSSProperties } {
  return color && color in MAUS_COLORS ? { "data-bot-accent": "", style: botAccentStyle(color as MausColor) } : {};
}
