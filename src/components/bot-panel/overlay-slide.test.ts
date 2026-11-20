import { describe, expect, it } from "vitest";
import { overlaySlide } from "./overlay-slide";

type Target = { transform?: string; opacity?: number; transition?: { duration?: number } };
const out = (variants: { out: (swapped: boolean) => Target }, swapped: boolean) => variants.out(swapped);

describe("the bot panel over the chat", () => {
  it("slides in from the right edge and back out the same way, on the docked column's 260 ms", () => {
    const { panel, scrim } = overlaySlide(false, true);
    expect(panel.initial).toBe("out");
    expect(out(panel.variants, false)).toMatchObject({ transform: "translateX(100%)", transition: { duration: 0.26 } });
    expect(panel.variants.rest).toMatchObject({ transform: "translateX(0%)", transition: { duration: 0.26 } });
    expect(out(scrim.variants, false)).toMatchObject({ opacity: 0, transition: { duration: 0.26 } });
  });

  it("hands over to another bot's panel in place: the old one goes at once and the new one is already there", () => {
    const { panel, scrim } = overlaySlide(false, false);
    expect(panel.initial).toBe(false);
    expect(scrim.initial).toBe(false);
    expect(out(panel.variants, true).transition).toEqual({ duration: 0 });
    expect(out(scrim.variants, true).transition).toEqual({ duration: 0 });
  });

  it("fades without moving under reduced motion", () => {
    const { panel } = overlaySlide(true, true);
    expect(out(panel.variants, false)).not.toHaveProperty("transform");
    expect(out(panel.variants, false)).toMatchObject({ opacity: 0 });
    expect(panel.variants.rest).toMatchObject({ opacity: 1 });
  });
});
