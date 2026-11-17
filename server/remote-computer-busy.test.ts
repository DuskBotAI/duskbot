import { describe, expect, it } from "vitest";

import { createRemoteComputerBusyTracker } from "./remote-computer-busy.ts";

describe("createRemoteComputerBusyTracker", () => {
  it("tracks busy owner within its TTL window", () => {
    let now = 1_000;
    const tracker = createRemoteComputerBusyTracker({ ttlMs: 5_000, now: () => now });
    expect(tracker.has("owner-1")).toBe(false);
    expect(tracker.size).toBe(0);

    tracker.add("owner-1");
    expect(tracker.has("owner-1")).toBe(true);
    expect(tracker.size).toBe(1);

    now += 4_000;
    expect(tracker.has("owner-1")).toBe(true);
    expect(tracker.size).toBe(1);
  });

  it("expires busy owner after TTL without requiring manual delete", () => {
    let now = 1_000;
    const tracker = createRemoteComputerBusyTracker({ ttlMs: 5_000, now: () => now });
    tracker.add("owner-1");

    now += 5_000;
    expect(tracker.has("owner-1")).toBe(false);
    expect(tracker.size).toBe(0);
  });

  it("supports explicit deletion before TTL expiration", () => {
    let now = 1_000;
    const tracker = createRemoteComputerBusyTracker({ ttlMs: 10_000, now: () => now });
    tracker.add("owner-1");
    expect(tracker.has("owner-1")).toBe(true);

    expect(tracker.delete("owner-1")).toBe(true);
    expect(tracker.has("owner-1")).toBe(false);
    expect(tracker.size).toBe(0);
  });

  it("sweeps expired owners when measuring size", () => {
    let now = 1_000;
    const tracker = createRemoteComputerBusyTracker({ ttlMs: 5_000, now: () => now });
    tracker.add("owner-1");
    tracker.add("owner-2", 10_000);
    expect(tracker.size).toBe(2);

    now += 6_000;
    expect(tracker.size).toBe(1);
    expect(tracker.has("owner-1")).toBe(false);
    expect(tracker.has("owner-2")).toBe(true);

    now += 5_000;
    expect(tracker.size).toBe(0);
  });
});
