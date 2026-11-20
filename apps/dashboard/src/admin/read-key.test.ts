import { describe, expect, it } from "vitest";
import { readKeyOf } from "./api";

describe("admin read keys", () => {
  it("treats a range ending about now as one read, whenever it was asked", () => {
    const now = Date.parse("2026-11-19T10:00:00Z");
    expect(readKeyOf(`/product?from=1&to=${now - 2_000}`, now)).toBe(readKeyOf(`/product?from=1&to=${now}`, now));
    expect(readKeyOf(`/product?from=1&to=${now - 3_600_000}`, now)).not.toBe(readKeyOf(`/product?from=1&to=${now}`, now));
    expect(readKeyOf("/product?from=1&to=5", now)).not.toBe(readKeyOf("/product?from=2&to=5", now));
  });
});
