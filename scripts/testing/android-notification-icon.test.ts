import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-js";
// @ts-expect-error plain Node ESM script with no .d.ts
import { KIT_GLYPH, glyphPath, svg } from "../../build/logo.mjs";

const ROOT = new URL("../../", import.meta.url);

describe("Android notification monochrome icon", () => {
  it("traces KIT_GLYPH into an exact seam-free contour with transparent cutout eyes", () => {
    const pathData = glyphPath(KIT_GLYPH);
    const w = KIT_GLYPH[0]!.length;
    const h = KIT_GLYPH.length;
    const scale = 4;
    const rendered = new Resvg(svg(w, h, `<path fill="#ffffff" fill-rule="evenodd" d="${pathData}"/>`), {
      fitTo: { mode: "width", value: w * scale },
    }).render();

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Sample the center of each glyph cell.
        const px = x * scale + 2;
        const py = y * scale + 2;
        const alpha = rendered.pixels[(py * rendered.width + px) * 4 + 3];
        const expected = KIT_GLYPH[y]![x] === "#" ? 255 : 0;
        expect(alpha, `cell (${x},${y})`).toBe(expected);
      }
    }
  });

  it("ships a white monochrome vector drawable wired in AndroidManifest.xml", () => {
    const manifest = readFileSync(new URL("apps/mobile/android/app/src/main/AndroidManifest.xml", ROOT), "utf8");
    expect(manifest).toMatch(
      /android:name="com\.google\.firebase\.messaging\.default_notification_icon"\s+android:resource="@drawable\/ic_stat_duskbot"/,
    );

    const drawable = readFileSync(new URL("apps/mobile/android/app/src/main/res/drawable/ic_stat_duskbot.xml", ROOT), "utf8");
    expect(drawable).toContain('android:width="24dp"');
    expect(drawable).toContain('android:height="24dp"');
    expect(drawable).toContain('android:fillColor="#FFFFFFFF"');
    expect(drawable).toContain(`android:pathData="${glyphPath(KIT_GLYPH, { x: 1, y: 0.5 })}"`);
  });
});
