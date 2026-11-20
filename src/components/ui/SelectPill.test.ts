import { describe, expect, it } from "vitest";

import { placeMenu } from "./SelectPill";

const viewport = { width: 1280, height: 577 };
const pill = (top: number) => ({ top, bottom: top + 24, right: 1256 });

describe("placeMenu", () => {
  it("opens a short menu below its pill", () => {
    expect(placeMenu(pill(100), 200, viewport)).toEqual({ right: 24, up: false, maxHeight: 200, top: 128 });
  });

  it("opens a long menu near the bottom of the window upward, inside the window", () => {
    const place = placeMenu(pill(426), 938, viewport);
    expect(place.up).toBe(true);
    expect(place.maxHeight).toBe(360);
    expect(viewport.height - place.bottom! - place.maxHeight).toBeGreaterThanOrEqual(8);
  });

  it("shrinks a menu that fits on neither side to the larger side, never past the window's edge", () => {
    const place = placeMenu(pill(200), 938, { width: 1280, height: 520 });
    expect(place.up).toBe(false);
    expect(place.top! + place.maxHeight).toBeLessThanOrEqual(520 - 8);
  });
});
