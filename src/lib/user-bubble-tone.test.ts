import { describe, expect, it } from "vitest";
import { contrastRatio, toOklch } from "./color-contrast";
import { MASCOT_INK, MAUS_COLORS, MAUS_COLOR_NAMES, type MausColor } from "./mascot";
import {
  BUBBLE_TOKEN_MIN,
  bothSchemes,
  grokFill,
  grokFills,
  mentionChipBackground,
  quoteSurface,
  userBubbleStyle,
  userBubbleTone,
  type Scheme,
} from "./user-bubble-tone";

const EXPECTED_BUBBLE: Record<MausColor, { light: string; dark: string }> = {
  green: { light: "#10a760", dark: "#03a35d" },
  blue: { light: "#286ef9", dark: "#286ef9" },
  red: { light: "#ef3a3f", dark: "#ef3a3f" },
  orange: { light: "#eb7300", dark: "#e06e00" },
  purple: { light: "#894ef0", dark: "#894ef0" },
  cyan: { light: "#009de7", dark: "#0096dd" },
  pink: { light: "#f12b93", dark: "#f12b93" },
  yellow: { light: "#c08c00", dark: "#b78500" },
  teal: { light: "#00a97b", dark: "#00a175" },
  coral: { light: "#f75e51", dark: "#f35b4e" },
  brown: { light: "#a8672f", dark: "#a8672f" },
  silver: { light: "#1c1c1c", dark: "#3b3b3b" },
  chrome: { light: "#1c1c1c", dark: "#3b3b3b" },
};

const SCHEMES: Scheme[] = ["light", "dark"];
const BUBBLE_INK: Record<Scheme, string> = { light: "#ffffff", dark: "#f5f5f5" };
const cases = MAUS_COLOR_NAMES.flatMap((color) => SCHEMES.map((scheme) => [color, scheme] as const));

describe("user bubble tone", () => {
  it.each(cases)("fills %s in %s from the mascot palette under white text", (color, scheme) => {
    const tone = userBubbleTone(color, scheme);
    expect(tone.background).toBe(EXPECTED_BUBBLE[color][scheme]);
    expect(grokFill(color, scheme).bubble).toBe(EXPECTED_BUBBLE[color][scheme]);
    expect(tone.ink).toBe(BUBBLE_INK[scheme]);
    expect(tone.focus).toBe(BUBBLE_INK[scheme]);
    expect(tone.selectionInk).toBe(BUBBLE_INK[scheme]);
    expect(tone.gradient).toBe("linear-gradient(rgb(255 255 255 / 0.06), transparent)");
  });

  it("uses the exact mascot hex when white text already holds 3:1 and preserves hue when deepening light fills", () => {
    for (const color of ["blue", "red", "purple", "pink", "brown"] as const) {
      expect(userBubbleTone(color, "light").background).toBe(MASCOT_INK[color]);
      expect(userBubbleTone(color, "dark").background).toBe(MASCOT_INK[color]);
    }
    expect(userBubbleTone("green", "light").background).toBe(MASCOT_INK.green);
    expect(userBubbleTone("coral", "light").background).toBe(MASCOT_INK.coral);
    for (const color of ["orange", "cyan", "yellow", "teal"] as const) {
      const baseHue = toOklch(MASCOT_INK[color]).h;
      for (const scheme of SCHEMES) {
        const bubble = userBubbleTone(color, scheme).background;
        const delta = Math.abs(toOklch(bubble).h - baseHue);
        expect(Math.min(delta, 360 - delta), `${color} ${scheme} hue drift`).toBeLessThan(1);
      }
    }
    expect(MAUS_COLOR_NAMES.filter((color) => userBubbleTone(color).ink !== "light-dark(#ffffff, #f5f5f5)")).toEqual([]);
  });

  it("gives every chromatic bot its own fill while keeping silver and chrome neutral", () => {
    expect(grokFills("coral").bubble).not.toBe(grokFills("orange").bubble);
    expect(grokFills("teal").bubble).not.toBe(grokFills("cyan").bubble);
    expect(grokFills("chrome")).toEqual(grokFills("silver"));
  });

  it.each(MAUS_COLOR_NAMES)("paints %s with css that follows the color-scheme, flat for Simple mode", (color) => {
    const light = userBubbleTone(color, "light");
    const dark = userBubbleTone(color, "dark");
    const tone = userBubbleTone(color);
    expect(tone.background).toBe(bothSchemes(light.background, dark.background));
    for (const key of Object.keys(tone) as (keyof typeof tone)[]) expect(tone[key], key).toBe(bothSchemes(light[key], dark[key]));
    expect(tone.ink).toBe("light-dark(#ffffff, #f5f5f5)");
    const flat = userBubbleStyle(color, { flat: true }) as Record<string, unknown>;
    expect(flat.backgroundColor).toBe(tone.background);
    expect(flat.backgroundImage).toBe("none");
    expect(flat["--color-ink"]).toBe(tone.ink);
    expect(flat["--color-bubble-user-ink"]).toBe(tone.ink);
    expect((userBubbleStyle(color) as Record<string, unknown>).backgroundImage).toBe(tone.gradient);
  });

  it.each(cases)("keeps everything derived for %s in %s readable at 3:1 on grok's fill", (color, scheme) => {
    const tone = userBubbleTone(color, scheme);
    const fill = tone.background;
    const min = BUBBLE_TOKEN_MIN;
    expect(min).toBe(3);
    expect(contrastRatio(tone.ink, fill), "body").toBeGreaterThanOrEqual(min);
    expect(contrastRatio(tone.secondary, fill), "secondary").toBeGreaterThanOrEqual(min);
    expect(contrastRatio(tone.tertiary, fill), "tertiary").toBeGreaterThanOrEqual(min);
    expect(contrastRatio(tone.tertiary, fill)).toBeLessThanOrEqual(contrastRatio(tone.secondary, fill));
    expect(contrastRatio(tone.secondary, fill)).toBeLessThanOrEqual(contrastRatio(tone.ink, fill));
    expect(contrastRatio(tone.accent, fill), "link").toBeGreaterThanOrEqual(min);
    expect(contrastRatio(tone.danger, fill), "danger").toBeGreaterThanOrEqual(min);
    expect(contrastRatio(tone.success, fill), "success").toBeGreaterThanOrEqual(min);
    expect(contrastRatio(tone.hairline, fill), "hairline").toBeGreaterThanOrEqual(min);
    expect(contrastRatio(tone.focus, fill), "focus").toBeGreaterThanOrEqual(min);
    const quote = quoteSurface(tone.inset, fill);
    expect(contrastRatio(tone.accent, quote), "quote name").toBeGreaterThanOrEqual(min);
    expect(contrastRatio(tone.secondary, quote), "quote snippet").toBeGreaterThanOrEqual(min);
    expect(contrastRatio(tone.ink, tone.inset), "code").toBeGreaterThanOrEqual(contrastRatio(tone.ink, fill));
    expect(contrastRatio(tone.secondary, tone.inset), "code secondary").toBeGreaterThanOrEqual(min);
    expect(contrastRatio(tone.ink, tone.raised), "hover").toBeGreaterThanOrEqual(min);
    expect(contrastRatio(tone.ink, tone.raisedHover), "hover stronger").toBeGreaterThanOrEqual(min);
    expect(new Set([fill, tone.raised, tone.raisedHover]).size, "hover steps show").toBe(3);
    expect(contrastRatio(tone.accent, tone.raised), "link on hover").toBeGreaterThanOrEqual(min);
    expect(contrastRatio(tone.accentInk, tone.accent), "send").toBeGreaterThanOrEqual(min);
    expect(contrastRatio(tone.dangerInk, tone.danger), "danger fill").toBeGreaterThanOrEqual(min);
    expect(contrastRatio(tone.successInk, tone.success), "success fill").toBeGreaterThanOrEqual(min);
    expect(tone.selection).not.toBe(fill);
    expect(contrastRatio(tone.selectionInk, tone.selection), "selection").toBeGreaterThanOrEqual(min);
    for (const mention of MAUS_COLOR_NAMES) {
      const chip = mentionChipBackground(MAUS_COLORS[mention], tone.inset);
      expect(contrastRatio(tone.ink, chip), `mention ${mention}`).toBeGreaterThanOrEqual(min);
    }
  });
});
