import { describe, expect, it } from "vitest";
import { system } from "./motion";
import { PHONE_FEEL, PHONE_FEELS } from "./phone-feel";

const settleMs = ({ stiffness, damping, mass = 1 }: { stiffness: number; damping: number; mass?: number }) => {
  let x = 1, v = 0, t = 0;
  while (t < 5000 && (Math.abs(x) > 0.001 || Math.abs(v) > 0.01)) {
    v += ((-stiffness * x - damping * v) / mass) / 1000;
    x += v / 1000;
    t += 1;
  }
  return t;
};

describe("the phone's feel", () => {
  it("ships b, the phone as it moves now", () => {
    expect(PHONE_FEEL.pick).toBe("b");
    expect(PHONE_FEEL.nav.push).toBe(system);
    expect(PHONE_FEEL.haptic).toBe("press");
  });

  it("leaves faster than it arrives in b+ and b++", () => {
    for (const feel of [PHONE_FEELS["b+"], PHONE_FEELS["b++"]]) {
      expect(settleMs(feel.nav.pop)).toBeLessThan(settleMs(feel.nav.push));
      expect(settleMs(feel.sheet.close)).toBeLessThan(settleMs(feel.sheet.open));
      expect(feel.viewer.closeMs).toBeLessThan(PHONE_FEELS.b.viewer.closeMs);
    }
  });
});
