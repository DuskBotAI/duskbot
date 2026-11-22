import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SETTING_GLYPHS, SettingGlyph } from "./SettingGlyph";

describe("setting glyphs", () => {
  it("draws every glyph in its own brand colour, a deep line with its soft tint inside", () => {
    for (const name of SETTING_GLYPHS) {
      const html = renderToStaticMarkup(createElement(SettingGlyph, { name }));
      expect(html, name).toMatch(/data-glyph-hue="(sky|pink|lilac|lemon|lime|peach)"/);
      expect(html, name).not.toContain("currentColor");
      expect(html, name).toMatch(/<rect [^>]*fill="#/);
    }
  });

  it("fills a closed outline and leaves an open one empty", () => {
    const person = renderToStaticMarkup(createElement(SettingGlyph, { name: "person" }));
    const megaphone = renderToStaticMarkup(createElement(SettingGlyph, { name: "megaphone" }));
    const sliders = renderToStaticMarkup(createElement(SettingGlyph, { name: "sliders" }));
    expect(person).toContain('fill="#fbd3e4"');
    expect(megaphone).toContain('fill="#fbd3e4"');
    expect(megaphone).toContain('fill="#d0679a"');
    expect(sliders).not.toContain('fill="#e2d6fb"');
  });
});
