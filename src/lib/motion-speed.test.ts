import { describe, expect, it } from "vitest";
import { MOTION, MOTION_SPEEDS, motionCssVars, pacedInOut, pacedMs, pacedOut, pacedSeconds, pacedSpring } from "./motion-speed";

const peak = ({ stiffness, damping }: { stiffness: number; damping: number }) => {
  let x = 0, v = 0, top = 0;
  for (let i = 0; i < 4000; i++) {
    v += (stiffness * (1 - x) - damping * v) / 1000;
    x += v / 1000;
    top = Math.max(top, x);
  }
  return top;
};

describe("motion speed", () => {
  it("ships the owner's pick, B", () => {
    expect(MOTION.pick).toBe("b");
    expect(motionCssVars()).toEqual({ "--motion-scale": "1.4", "--motion-ease-out": "cubic-bezier(0.25, 0.85, 0.3, 1)", "--motion-ease-in-out": "cubic-bezier(0.45, 0.05, 0.25, 1)" });
  });

  it("leaves every value its own at A", () => {
    const a = MOTION_SPEEDS.a;
    const spring = { stiffness: 600, damping: 54 };
    expect(pacedSpring(spring, a)).toBe(spring);
    expect(pacedMs(140, a)).toBe(140);
    expect(pacedSeconds(0.12, a)).toBe(0.12);
    expect(pacedOut([0.22, 1, 0.36, 1], a)).toEqual([0.22, 1, 0.36, 1]);
    expect(pacedInOut([0.645, 0.045, 0.355, 1], a)).toEqual([0.645, 0.045, 0.355, 1]);
    expect(motionCssVars(a)).toEqual({ "--motion-scale": "1" });
  });

  it("plays B and C slower, with no spring going past its rest", () => {
    for (const speed of [MOTION_SPEEDS.b, MOTION_SPEEDS.c]) {
      expect(pacedMs(200, speed)).toBe(Math.round(200 * speed.scale));
      for (const spring of [{ stiffness: 600, damping: 54 }, { stiffness: 420, damping: 32 }]) {
        const slow = pacedSpring(spring, speed);
        expect(slow.stiffness).toBeLessThan(spring.stiffness);
        expect(peak(slow)).toBeLessThanOrEqual(1.0005);
      }
    }
  });
});
