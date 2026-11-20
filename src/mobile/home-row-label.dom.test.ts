// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { unreadRowLabel } from "./HomeScreen";

describe("a home row read by a screen reader", () => {
  it("says an unread chat is unread and still reads its newest line", () => {
    expect(unreadRowLabel("Nova", { unread: true, at: 0, preview: "the lease is signed" })).toBe("Nova, unread, the lease is signed");
  });

  it("leaves a read row to read its own text", () => {
    expect(unreadRowLabel("Nova", { unread: false, at: 0, preview: "hi" })).toBeUndefined();
  });
});
