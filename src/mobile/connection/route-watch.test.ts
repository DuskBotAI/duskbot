import { describe, expect, it, vi } from "vitest";
import { ROUTE_CHECK_MS, ROUTE_STUCK_MS, sameRoute, watchRoute } from "./route-watch";
import type { RelayChannel } from "../transport/relay";

function rig(options: { heardAt?: number | null; online?: boolean; visible?: boolean } = {}) {
  let now = 0;
  let tick: () => void = () => {};
  const state = { heardAt: options.heardAt ?? null, online: options.online ?? true, visible: options.visible ?? true };
  let finish: () => void = () => {};
  let moved: () => void = () => {};
  const rewalk = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const stop = watchRoute({
    heardAt: () => state.heardAt, online: () => state.online, visible: () => state.visible, rewalk,
    onNetworkChange: (listener) => { moved = listener; return () => { moved = () => {}; }; },
    now: () => now, every: (run) => { tick = run; return () => { tick = () => {}; }; },
  });
  return {
    state, rewalk, stop, moved: () => moved(),
    advance(ms: number) { for (let at = 0; at < ms; at += ROUTE_CHECK_MS) { now += ROUTE_CHECK_MS; tick(); } },
    finish: async () => { finish(); await Promise.resolve(); await Promise.resolve(); },
  };
}

describe("a phone stuck on a route that went away", () => {
  it("walks the routes again once the place has been silent for the stuck time", () => {
    const watch = rig({ heardAt: 0 });
    watch.advance(ROUTE_STUCK_MS - ROUTE_CHECK_MS);
    expect(watch.rewalk).not.toHaveBeenCalled();
    watch.advance(ROUTE_CHECK_MS);
    expect(watch.rewalk).toHaveBeenCalledOnce();
  });

  it("leaves a place that keeps answering alone", () => {
    const watch = rig({ heardAt: 0 });
    for (let i = 0; i < 10; i++) { watch.advance(ROUTE_CHECK_MS); watch.state.heardAt = (i + 1) * ROUTE_CHECK_MS; }
    expect(watch.rewalk).not.toHaveBeenCalled();
  });

  it("never walks while the phone is offline or in the background, nor twice at once or twice in a stuck time", async () => {
    const watch = rig({ online: false });
    watch.advance(ROUTE_STUCK_MS * 2);
    watch.state.online = true;
    watch.state.visible = false;
    watch.advance(ROUTE_STUCK_MS);
    expect(watch.rewalk).not.toHaveBeenCalled();
    watch.state.visible = true;
    watch.advance(ROUTE_CHECK_MS);
    expect(watch.rewalk).toHaveBeenCalledOnce();
    watch.advance(ROUTE_STUCK_MS * 2);
    expect(watch.rewalk).toHaveBeenCalledOnce();
    await watch.finish();
    watch.advance(ROUTE_CHECK_MS);
    expect(watch.rewalk).toHaveBeenCalledTimes(2);
    watch.advance(ROUTE_STUCK_MS - ROUTE_CHECK_MS);
    expect(watch.rewalk).toHaveBeenCalledTimes(2);
    watch.stop();
    watch.advance(ROUTE_STUCK_MS * 2);
    expect(watch.rewalk).toHaveBeenCalledTimes(2);
  });

  it("walks at once when the phone changes networks, not waiting for the silence", async () => {
    const watch = rig({ heardAt: 0 });
    watch.moved();
    expect(watch.rewalk).toHaveBeenCalledOnce();
    watch.moved();
    expect(watch.rewalk).toHaveBeenCalledOnce();
    await watch.finish();
    watch.state.online = false;
    watch.moved();
    expect(watch.rewalk).toHaveBeenCalledOnce();
    watch.state.online = true;
    watch.moved();
    expect(watch.rewalk).toHaveBeenCalledTimes(2);
    watch.stop();
    watch.moved();
    expect(watch.rewalk).toHaveBeenCalledTimes(2);
  });

  it("tells the same way to the place from another one", () => {
    const channel = {} as RelayChannel;
    expect(sameRoute({ kind: "bearer", origin: "http://192.168.1.20:8810", token: "t" }, { kind: "bearer", origin: "http://192.168.1.20:8810", token: "t" })).toBe(true);
    expect(sameRoute({ kind: "bearer", origin: "http://192.168.1.20:8810", token: "t" }, { kind: "bearer", origin: "http://macbook.local:8810", token: "t" })).toBe(false);
    expect(sameRoute({ kind: "relay", channel, token: "t" }, { kind: "bearer", origin: "https://vps.example", token: "t" })).toBe(false);
    expect(sameRoute({ kind: "relay", channel, token: "t" }, { kind: "relay", channel, token: "t" })).toBe(true);
  });
});
