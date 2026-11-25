import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-js";
// @ts-expect-error plain Node ESM script with no .d.ts
import { KIT_GLYPH, glyphPath, svg } from "../../build/logo.mjs";

const ROOT = new URL("../../", import.meta.url);

describe("Android Material You monochrome launcher icon", () => {
  it("keeps the monochrome adaptive layer centered inside Android's 66dp safe zone", () => {
    const pathData = glyphPath(KIT_GLYPH, { x: 26, y: 24.25, scale: 3.5 });
    const drawable = readFileSync(new URL("apps/mobile/android/app/src/main/res/drawable/ic_launcher_monochrome.xml", ROOT), "utf8");
    expect(drawable).toContain('android:width="108dp"');
    expect(drawable).toContain('android:height="108dp"');
    expect(drawable).toContain('android:viewportWidth="108"');
    expect(drawable).toContain('android:viewportHeight="108"');
    expect(drawable).toContain('android:fillColor="#FFFFFFFF"');
    expect(drawable).toContain(`android:pathData="${pathData}"`);

    const rendered = new Resvg(svg(108, 108, `<path fill="#ffffff" fill-rule="evenodd" d="${pathData}"/>`)).render();
    let minX = 108, maxX = -1, minY = 108, maxY = -1;
    for (let y = 0; y < 108; y++) {
      for (let x = 0; x < 108; x++) {
        if (rendered.pixels[(y * 108 + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    // 66dp safe zone in a 108dp adaptive icon spans [21, 87].
    expect(minX).toBeGreaterThanOrEqual(21);
    expect(maxX).toBeLessThanOrEqual(87);
    expect(minY).toBeGreaterThanOrEqual(21);
    expect(maxY).toBeLessThanOrEqual(87);
  });

  it("wires <monochrome> in both adaptive launcher icon XMLs", () => {
    for (const file of [
      "apps/mobile/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml",
      "apps/mobile/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml",
    ]) {
      const xml = readFileSync(new URL(file, ROOT), "utf8");
      expect(xml, file).toContain('<monochrome android:drawable="@drawable/ic_launcher_monochrome"/>');
    }
  });
});
