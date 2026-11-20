// @vitest-environment happy-dom
import { motionValue } from "motion/react";
import { expect, it, vi } from "vitest";
import { recedeStyle, riseOnCompositor } from "./Sheet";

function layer() {
  const el = document.createElement("div");
  const runs: Array<{ frames: Keyframe[]; run: { onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn> } }> = [];
  el.animate = ((frames: Keyframe[]) => {
    const run = { onfinish: null as (() => void) | null, cancel: vi.fn() };
    runs.push({ frames, run });
    return run as unknown as Animation;
  }) as HTMLElement["animate"];
  return { el, runs };
}

it("plays the sheet, its scrim and the page behind as one compositor rise, then hands the position to y", () => {
  const sheet = layer(), scrim = layer(), page = layer();
  const y = motionValue(800);
  const done = vi.fn();
  riseOnCompositor({ sheet: sheet.el, scrim: scrim.el, page: page.el }, y, 800, done);
  const frames = sheet.runs[0]!.frames;
  expect(frames[0]).toEqual({ transform: "translateY(800px)" });
  expect(frames.at(-1)).toEqual({ transform: "translateY(0px)" });
  // it leaves at full speed: the first frame covers more ground than any later one
  const at = (i: number) => Number(/translateY\((.+)px\)/.exec(String(frames[i]!.transform))![1]);
  expect(at(0) - at(1)).toBeGreaterThan(at(1) - at(2));
  expect(scrim.runs[0]!.frames.at(-1)).toEqual({ opacity: 1 });
  expect(page.runs[0]!.frames.at(-1)).toEqual({ transform: recedeStyle(1)!.transform });
  expect(page.el.style.borderRadius, "the page rounds its corners as it starts to step back").toBe("14px");
  sheet.runs[0]!.run.onfinish!();
  expect(y.get()).toBe(0);
  expect(done).toHaveBeenCalledOnce();
  for (const { runs } of [sheet, scrim, page]) expect(runs[0]!.run.cancel).toHaveBeenCalled();
});
