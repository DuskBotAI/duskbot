import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BOT_BUTTON, botButton, botButtonStyle, botButtonTone } from "./bot-button";
import { contrastRatio, mixSrgb } from "./color-contrast";
import { MAUS_COLOR_NAMES, type MausColor } from "./mascot";
import { SKIN_IDS, THEME_SKINS } from "./skins";
import { grokFill, type Scheme } from "./user-bubble-tone";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");

function declarations(body: string): Record<string, string> {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

const theme = declarations(css.match(/@theme\s*\{([^}]*)\}/)?.[1] ?? "");
const skin = (id: string) => ({
  ...theme,
  ...declarations(css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? ""),
});

/** A token with alpha, as the eye sees it over `background`. */
function over(color: string, background: string): string {
  const alpha = /^#[0-9a-f]{8}$/i.test(color) ? parseInt(color.slice(7), 16) / 255 : 1;
  return mixSrgb(color.slice(0, 7), background, alpha);
}

/** A focus ring against what it sits on: WCAG 1.4.11. */
const RING_MIN = 3;

/** Grok Bot's send button for the hue each colour maps to: light /1 resting and /2 on hover, dark /1 and /2. */
const GROK_BUTTON: Record<MausColor, Record<Scheme, { fill: string; hover: string }>> = {
  green: { light: { fill: "#10ab61", hover: "#0d9655" }, dark: { fill: "#0e9f5a", hover: "#13bb6b" } },
  blue: { light: { fill: "#1680f3", hover: "#126fd4" }, dark: { fill: "#116dd2", hover: "#1784fb" } },
  red: { light: { fill: "#e72e3b", hover: "#c82532" }, dark: { fill: "#cf2b35", hover: "#f73643" } },
  orange: { light: { fill: "#ee620d", hover: "#d2550a" }, dark: { fill: "#cd5309", hover: "#f4650e" } },
  purple: { light: { fill: "#8351e4", hover: "#7442d1" }, dark: { fill: "#7845d7", hover: "#8e59f8" } },
  cyan: { light: { fill: "#10a693", hover: "#0d9381" }, dark: { fill: "#0e9886", hover: "#12b39f" } },
  pink: { light: { fill: "#e52f8b", hover: "#c82779" }, dark: { fill: "#cf297e", hover: "#f63397" } },
  yellow: { light: { fill: "#da830e", hover: "#c2730b" }, dark: { fill: "#c8770c", hover: "#ea8c10" } },
  teal: { light: { fill: "#10a693", hover: "#0d9381" }, dark: { fill: "#0e9886", hover: "#12b39f" } },
  coral: { light: { fill: "#ee620d", hover: "#d2550a" }, dark: { fill: "#cd5309", hover: "#f4650e" } },
  brown: { light: { fill: "#9d6937", hover: "#86592e" }, dark: { fill: "#8c5d31", hover: "#aa723d" } },
  silver: { light: { fill: "#1c1c1c", hover: "#363636" }, dark: { fill: "#f5f5f5", hover: "#dbdbdb" } },
  chrome: { light: { fill: "#1c1c1c", hover: "#363636" }, dark: { fill: "#f5f5f5", hover: "#dbdbdb" } },
};
/** Its icon: white in light and #f5f5f5 in dark, except the grey bot's #fcfcfc, and dark #121212 on its inverted dark button. */
const grokIcon = (color: MausColor, scheme: Scheme) =>
  color === "silver" || color === "chrome" ? { light: "#fcfcfc", dark: "#121212" }[scheme] : { light: "#ffffff", dark: "#f5f5f5" }[scheme];

const SCHEMES: Scheme[] = ["light", "dark"];

function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`) + 1;
  expect(at, selector).toBeGreaterThan(0);
  const before = css.slice(0, at).replace(/\/\*[\s\S]*?\*\//g, "");
  expect(before.split("{").length - before.split("}").length, `${selector} sits outside any @layer`).toBe(0);
  return css.slice(at, css.indexOf("}", at));
}

describe("a bot's own button", () => {
  it.each(MAUS_COLOR_NAMES.flatMap((color) => SCHEMES.map((scheme) => [color, scheme] as const)))(
    "paints %s in %s with grok's send button fill, hover and icon colour",
    (color, scheme) => {
      const tone = botButtonTone(color, scheme);
      expect({ fill: tone.fill, hover: tone.hover }).toEqual(GROK_BUTTON[color][scheme]);
      expect(tone.fill).toBe(grokFill(color, scheme).button);
      expect(tone.ink).toBe(grokIcon(color, scheme));
      expect(tone.pressed).not.toBe(tone.hover);
      expect(contrastRatio(tone.ink, tone.pressed)).toBeGreaterThan(Math.max(contrastRatio(tone.ink, tone.hover), contrastRatio(tone.ink, tone.fill)));
      expect(contrastRatio(tone.ink, tone.pressed), "pressed label").toBeGreaterThanOrEqual(RING_MIN);
    },
  );

  it.each(MAUS_COLOR_NAMES)("follows the color-scheme for %s", (color) => {
    const light = botButtonTone(color, "light");
    const dark = botButtonTone(color, "dark");
    expect(botButtonTone(color)).toEqual({
      fill: `light-dark(${light.fill}, ${dark.fill})`,
      ink: `light-dark(${light.ink}, ${dark.ink})`,
      hover: `light-dark(${light.hover}, ${dark.hover})`,
      pressed: `light-dark(${light.pressed}, ${dark.pressed})`,
    });
  });

  it("darkens to the bubble's colour on hover in light and brightens in dark, as grok does", () => {
    for (const color of MAUS_COLOR_NAMES.filter((one) => one !== "silver" && one !== "chrome")) {
      expect(contrastRatio("#ffffff", botButtonTone(color, "light").hover)).toBeGreaterThan(contrastRatio("#ffffff", botButtonTone(color, "light").fill));
      expect(contrastRatio("#ffffff", botButtonTone(color, "dark").hover)).toBeLessThan(contrastRatio("#ffffff", botButtonTone(color, "dark").fill));
    }
  });

  it("is a light and a dark theme by default, and every skin is checked below", () => {
    expect(SKIN_IDS).toEqual(expect.arrayContaining([THEME_SKINS.light, THEME_SKINS.dark]));
  });

  it.each(SKIN_IDS)("keeps the focus ring and disabled look readable on %s", (id) => {
    const tokens = skin(id);
    for (const surface of ["--color-app", "--color-card", "--color-composer", "--color-panel"]) {
      expect(tokens[surface], `${id} ${surface}`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrastRatio(tokens["--color-focus"]!, tokens[surface]!), `focus ring on ${surface}`).toBeGreaterThanOrEqual(RING_MIN);
    }
    const disabled = tokens["--color-raised-hover"]!;
    expect(contrastRatio(over(tokens["--color-ink-secondary"]!, disabled), disabled), "disabled label").toBeGreaterThanOrEqual(RING_MIN);
    expect(disabled).not.toBe(tokens["--color-composer"]);
  });

  it("is painted by an unlayered rule from the four properties botButtonStyle sets", () => {
    expect(rule(".bot-button")).toMatch(/background-color:\s*var\(--bot-button\);[\s\S]*color:\s*var\(--bot-button-ink\);/);
    expect(rule(".bot-button:enabled:hover:where(:not(html[data-mobile-app] *))")).toContain("background-color: var(--bot-button-hover);");
    expect(rule(".bot-button:enabled:active:where(:not(html[data-mobile-app] *))")).toContain("background-color: var(--bot-button-pressed);");
    expect(css).toMatch(/\[data-focus-nav\] :focus-visible[^{]*\{[^}]*background-image:[^}]*var\(--color-ink\) 10%/);
    expect(css).not.toMatch(/\.bot-button[^{]*:focus-visible/);
    expect(rule(".bot-button:disabled")).toMatch(/background-color:\s*var\(--color-raised-hover\);[\s\S]*color:\s*var\(--color-ink-secondary\);/);
    const tone = botButtonTone("blue");
    expect(botButtonStyle("blue")).toEqual({
      "--bot-button": tone.fill, "--bot-button-ink": tone.ink, "--bot-button-hover": tone.hover, "--bot-button-pressed": tone.pressed,
    });
  });

  it("keeps the plain look when no single bot owns the button", () => {
    expect(botButton(undefined, "h-7 rounded-full", "bg-accent text-accent-ink")).toEqual({ className: "h-7 rounded-full bg-accent text-accent-ink" });
    const own = botButton("purple", "h-7 rounded-full", "bg-accent text-accent-ink");
    expect(own.className).toBe(`h-7 rounded-full ${BOT_BUTTON}`);
    expect(own.className).not.toContain("ui-button-primary");
    expect(own.style).toEqual(botButtonStyle("purple"));
  });
});
