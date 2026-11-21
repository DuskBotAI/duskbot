import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BOT_BUTTON, botButton, botButtonStyle, botButtonTone } from "./bot-button";
import { contrastRatio, mixSrgb } from "./color-contrast";
import { MAUS_COLOR_NAMES, type MausColor } from "./mascot";
import { SKIN_IDS, THEME_SKINS } from "./skins";
import { bothSchemes, grokFill, type Scheme } from "./user-bubble-tone";

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

const EXPECTED_BUTTON: Record<MausColor, Record<Scheme, { fill: string; hover: string }>> = {
  green: { light: { fill: "#10a760", hover: "#009654" }, dark: { fill: "#03a35d", hover: "#2ab36c" } },
  blue: { light: { fill: "#286ef9", hover: "#175de7" }, dark: { fill: "#286ef9", hover: "#4181ff" } },
  red: { light: { fill: "#ef3a3f", hover: "#dd2330" }, dark: { fill: "#ef3a3f", hover: "#ff5151" } },
  orange: { light: { fill: "#eb7300", hover: "#d56700" }, dark: { fill: "#e06e00", hover: "#f17e24" } },
  purple: { light: { fill: "#894ef0", hover: "#7b3cdf" }, dark: { fill: "#894ef0", hover: "#9761ff" } },
  cyan: { light: { fill: "#009de7", hover: "#008dd0" }, dark: { fill: "#0096dd", hover: "#28a6ee" } },
  pink: { light: { fill: "#f12b93", hover: "#df0684" }, dark: { fill: "#f12b93", hover: "#ff4aa2" } },
  yellow: { light: { fill: "#c08c00", hover: "#ad7e00" }, dark: { fill: "#b78500", hover: "#c79424" } },
  teal: { light: { fill: "#00a97b", hover: "#00986e" }, dark: { fill: "#00a175", hover: "#29b184" } },
  coral: { light: { fill: "#f75e51", hover: "#e54d42" }, dark: { fill: "#f35b4e", hover: "#ff7263" } },
  brown: { light: { fill: "#a8672f", hover: "#98581e" }, dark: { fill: "#a8672f", hover: "#b8763f" } },
  silver: { light: { fill: "#1c1c1c", hover: "#363636" }, dark: { fill: "#f5f5f5", hover: "#dbdbdb" } },
  chrome: { light: { fill: "#1c1c1c", hover: "#363636" }, dark: { fill: "#f5f5f5", hover: "#dbdbdb" } },
};
const buttonIcon = (color: MausColor, scheme: Scheme) =>
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
    "paints %s in %s with its unified fill, hover and icon colour",
    (color, scheme) => {
      const tone = botButtonTone(color, scheme);
      expect({ fill: tone.fill, hover: tone.hover }).toEqual(EXPECTED_BUTTON[color][scheme]);
      expect(tone.fill).toBe(grokFill(color, scheme).button);
      expect(tone.ink).toBe(buttonIcon(color, scheme));
      expect(tone.pressed).not.toBe(tone.hover);
      expect(contrastRatio(tone.ink, tone.pressed)).toBeGreaterThan(Math.max(contrastRatio(tone.ink, tone.hover), contrastRatio(tone.ink, tone.fill)));
      expect(contrastRatio(tone.ink, tone.pressed), "pressed label").toBeGreaterThanOrEqual(RING_MIN);
    },
  );

  it.each(MAUS_COLOR_NAMES)("follows the color-scheme for %s", (color) => {
    const light = botButtonTone(color, "light");
    const dark = botButtonTone(color, "dark");
    expect(botButtonTone(color)).toEqual({
      fill: bothSchemes(light.fill, dark.fill),
      ink: bothSchemes(light.ink, dark.ink),
      hover: bothSchemes(light.hover, dark.hover),
      pressed: bothSchemes(light.pressed, dark.pressed),
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
