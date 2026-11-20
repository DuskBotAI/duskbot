import { describe, expect, it } from "vitest";

import { forecastLine } from "./spend";

const forecast = (runsPerWeek: number | null) => ({ runsPerWeek, perRunUsd: null, weekUsd: null, shareOfWeek: null, warnings: [], runCosts: {}, spentUsd: 0 });

describe("forecastLine", () => {
  it("says one run a week as once, and counts the rest", () => {
    expect(forecastLine(forecast(1))).toBe("About once a week · Cost shows after its first run");
    expect(forecastLine(forecast(5))).toBe("About 5 runs a week · Cost shows after its first run");
  });
});
