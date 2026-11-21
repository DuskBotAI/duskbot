import { describe, expect, it } from "vitest";
import { isRemoteScreenshotContention, isRemoteScreenshotUnconfigured } from "./remote-desktop";

describe("screenshot answers that need a person", () => {
  it.each([
    ["VPS is not configured", 409, true],
    ["VPS is not configured: add an SSH config alias in Settings → API keys", 409, true],
    ["VPS is not configured", 503, false],
    ["the VPS is being prepared: try again shortly", 409, false],
  ] as const)("reads %j (%i) as unconfigured: %s", (message, status, expected) => {
    expect(isRemoteScreenshotUnconfigured({ message, status })).toBe(expected);
  });

  it("never reads an unconfigured VPS as contention to wait out", () => {
    expect(isRemoteScreenshotContention({ message: "VPS is not configured", status: 409 })).toBe(false);
  });
});
