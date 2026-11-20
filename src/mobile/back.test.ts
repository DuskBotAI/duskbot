import { describe, expect, it, vi } from "vitest";
import { handleBack } from "./platform";
import { backLayerCount, closesOnBack, subscribeBackLayers } from "./Sheet";

describe("Android's back", () => {
  it("goes to the newest layer only, and to an older one only when it declines", () => {
    const app = vi.fn(() => true);
    const fullScreen = vi.fn(() => true);
    expect(handleBack([app, fullScreen])).toBe(true);
    expect(fullScreen).toHaveBeenCalledOnce();
    expect(app).not.toHaveBeenCalled();

    const firstStep = vi.fn(() => false);
    expect(handleBack([app, firstStep])).toBe(true);
    expect(app).toHaveBeenCalledOnce();
  });

  it("hears when a layer that closes on back opens and goes, so the first screen can hand back to the system", () => {
    const heard = vi.fn();
    const stop = subscribeBackLayers(heard);
    const close = closesOnBack(() => {});
    expect(backLayerCount()).toBe(1);
    close();
    expect(backLayerCount()).toBe(0);
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });

  it("is taken by nobody on the first screen, so the app goes to the background", () => {
    expect(handleBack([() => false])).toBe(false);
    expect(handleBack([])).toBe(false);
  });
});
