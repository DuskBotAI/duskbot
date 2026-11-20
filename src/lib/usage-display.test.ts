import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

let local: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  vi.resetModules();
  local = memoryStorage();
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usage shown as used or remaining", () => {
  it("reads as used until the person picks remaining", async () => {
    const preference = await import("./usage-display");
    expect(preference.readUsageDisplay()).toBe("used");
    expect(preference.useUsageDisplay()).toBe("used");
    local.setItem(preference.USAGE_DISPLAY_KEY, "left");
    expect(preference.readUsageDisplay()).toBe("left");
    local.setItem(preference.USAGE_DISPLAY_KEY, "something else");
    expect(preference.readUsageDisplay()).toBe("used");
  });

  it("reads as used when this device's storage cannot be read", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => {} });
    const preference = await import("./usage-display");
    expect(preference.readUsageDisplay()).toBe("used");
  });

  it("remembers the choice on this device", async () => {
    let preference = await import("./usage-display");
    preference.setUsageDisplay("left");
    expect(local.getItem(preference.USAGE_DISPLAY_KEY)).toBe("left");
    vi.resetModules();
    preference = await import("./usage-display");
    expect(preference.readUsageDisplay()).toBe("left");
    preference.setUsageDisplay("used");
    expect(local.getItem(preference.USAGE_DISPLAY_KEY)).toBe("used");
    expect(preference.readUsageDisplay()).toBe("used");
  });

  it("turns a share used into the whole percent on screen", async () => {
    const { shownShare } = await import("./usage-display");
    expect([0, 31.6, 99.4, 100, 140].map((used) => shownShare(used, "used"))).toEqual([0, 32, 99, 100, 100]);
    expect([0, 31.6, 99.4, 100, 140].map((used) => shownShare(used, "left"))).toEqual([100, 68, 1, 0, 0]);
  });
});
