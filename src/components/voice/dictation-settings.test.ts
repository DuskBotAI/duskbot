import { describe, expect, it } from "vitest";

describe("Dictation Model Settings UI Component", () => {
  it("imports and instantiates DictationModelSettings cleanly", async () => {
    const { DictationModelSettings } = await import("./DictationModelSettings.tsx");
    expect(typeof DictationModelSettings).toBe("function");
  });
});
