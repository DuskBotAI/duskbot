import { describe, expect, it } from "vitest";
import { botAccent, botAccentScope, botAccentStyle, SHEET_SURFACES } from "./bot-accent";
import { contrastRatio } from "./color-contrast";
import { MAUS_COLORS, type MausColor } from "./mascot";

const COLORS = Object.keys(MAUS_COLORS) as MausColor[];

describe("a bot's accent in its own sheet", () => {
  for (const scheme of ["light", "dark"] as const) {
    const { page, row } = SHEET_SURFACES[scheme];
    for (const color of COLORS) {
      it(`${color} in ${scheme} reads at AA and stands off the page`, () => {
        const accent = botAccent(color, scheme);
        expect(contrastRatio(accent.ink, accent.fill)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(accent.text, row)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(accent.text, page)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(accent.fill, row)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(accent.fill, page)).toBeGreaterThanOrEqual(3);
      });
    }
  }

  it("follows the bot's own colour, so two bots never share an accent", () => {
    expect(botAccent("purple", "light").fill).not.toBe(botAccent("green", "light").fill);
    expect(botAccent("yellow", "dark").fill).not.toBe(botAccent("purple", "dark").fill);
  });

  it("darkens a light colour in light mode rather than keep it unreadable", () => {
    const yellow = botAccent("yellow", "light");
    expect(contrastRatio(yellow.text, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("hands both schemes to css", () => {
    const style = botAccentStyle("purple") as Record<string, string>;
    expect(style["--bot-accent"]).toMatch(/^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/i);
    expect(style["--bot-accent-text"]).toBeTruthy();
  });

  it("leaves a colour it does not know on ink", () => {
    expect(botAccentScope(undefined)).toEqual({});
    expect(botAccentScope("plaid")).toEqual({});
    expect(botAccentScope("green")["data-bot-accent"]).toBe("");
  });
});
