// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MobileConnectionRecord } from "../../../shared/mobile-link";
import { PlatformContext, webPlatform, type MobilePlatform } from "../platform";
import { useConnections } from "./connections";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const record: MobileConnectionRecord = {
  id: "cloud", environmentId: "env-cloud", label: "my cloud", transport: "https", origin: "https://d1.dusk.bot", sessionRef: "token.cloud", deviceId: "device",
  capabilities: {} as MobileConnectionRecord["capabilities"], addedAt: 1, lastUsedAt: 1,
};

let host: HTMLDivElement, root: Root, prefs: Map<string, string>, reads: number, platform: MobilePlatform;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  prefs = new Map([["dusk.mobile.connections.v1", JSON.stringify([record])], ["dusk.mobile.active.v1", "cloud"]]);
  reads = 0;
  const slow = async <T,>(value: T) => { reads += 1; await new Promise((done) => setTimeout(done, 15)); return value; };
  platform = { ...webPlatform(), native: true, kind: "ios",
    prefs: { get: (key) => slow(prefs.get(key) ?? null), set: async (key, value) => { prefs.set(key, value); }, remove: async (key) => { prefs.delete(key); }, keys: async () => [...prefs.keys()] } };
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("the saved places, shared by every screen", () => {
  it("a screen opened after the app read them (Settings) draws them in its first frame and redraws for nothing", async () => {
    const app = () => { useConnections(); return null; };
    const frames: string[] = [];
    const settings = () => { const { connections, activeId, loaded } = useConnections(); frames.push(`${loaded} ${activeId} ${connections.length}`); return null; };
    await act(async () => { root.render(createElement(PlatformContext, { value: platform }, createElement(app))); });
    await act(async () => { await new Promise((done) => setTimeout(done, 60)); });
    const readsAtOpen = reads;
    await act(async () => { root.render(createElement(PlatformContext, { value: platform }, createElement(app), createElement(settings))); });
    await act(async () => { await new Promise((done) => setTimeout(done, 60)); });
    expect(frames[0]).toBe("true cloud 1");
    expect(new Set(frames)).toEqual(new Set(["true cloud 1"]));
    expect(frames.length).toBe(1);
    expect(reads - readsAtOpen).toBe(2);
  });

  it("a refresh after a write reads the list again", async () => {
    let latest: ReturnType<typeof useConnections> | null = null;
    const probe = () => { latest = useConnections(); return null; };
    await act(async () => { root.render(createElement(PlatformContext, { value: platform }, createElement(probe))); });
    await act(async () => { await new Promise((done) => setTimeout(done, 60)); });
    prefs.set("dusk.mobile.connections.v1", JSON.stringify([record, { ...record, id: "two", sessionRef: "token.two", environmentId: "env-two" }]));
    await act(async () => { await latest!.refresh(); });
    expect(latest!.connections.map((one) => one.id)).toEqual(["cloud", "two"]);
  });
});
