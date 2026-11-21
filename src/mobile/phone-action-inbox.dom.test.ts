// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { MobileConnectionRecord } from "../../shared/mobile-link";
import type { AppState } from "@/state/store";
import type { NativeAction } from "./phone-actions";
import type { MobilePlatform } from "./platform";
import { createConnectionStore } from "./connection/connections";
import { PhoneActionDelivery, usePhoneActionInbox, usePhoneActions } from "./use-phone-actions";

it("waits for the originating workspace to hydrate and delivers a reply only once", async () => {
  const records = ["a", "b"].map((id) => ({
    id, environmentId: "env-" + id, deviceId: "device-" + id, sessionRef: "token." + id,
  })) as MobileConnectionRecord[];
  const prefs = new Map([["dusk.mobile.connections.v1", JSON.stringify(records)], ["dusk.mobile.active.v1", "b"]]);
  let press: ((action: NativeAction) => void) | undefined;
  const platform = {
    prefs: { get: async (key: string) => prefs.get(key), set: async (key: string, value: string) => prefs.set(key, value) },
    secrets: { get: async () => "fixture-token" },
    onPhoneAction(listener: typeof press) { press = listener; return () => { press = undefined; }; },
  } as unknown as MobilePlatform;
  const store = createConnectionStore(platform), retry = vi.fn(), dispatch = vi.fn(), open = vi.fn();
  function Shell({ ready }: { ready: boolean }) {
    usePhoneActions({ hydrated: ready, connected: ready } as AppState, dispatch, open);
    return null;
  }
  function Gate({ id, ready }: { id: string; ready: boolean }) {
    const delivery = usePhoneActionInbox(platform, store, id, retry);
    return createElement(PhoneActionDelivery.Provider, { value: delivery }, createElement(Shell, { key: id, ready }));
  }
  const root = createRoot(document.createElement("div"));
  const render = (id: string, ready: boolean) => act(async () => root.render(createElement(StrictMode, null, createElement(Gate, { id, ready }))));
  try {
    await render("b", true);
    const data = { environmentId: "env-a", deviceId: "device-a", botId: "same", threadId: "same-thread", messageId: "m" };
    await act(async () => press!({ actionId: "dusk.reply", inputValue: "first", data }));
    expect(retry).toHaveBeenCalledOnce();
    expect(prefs.get("dusk.mobile.active.v1")).toBe("a");
    expect(dispatch).not.toHaveBeenCalled();
    await render("a", false);
    expect(dispatch).not.toHaveBeenCalled();
    await render("a", true);
    expect(dispatch.mock.calls).toEqual([[{ type: "send", botId: "same", threadId: "same-thread", text: "first" }]]);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m" }));
    await act(async () => press!({ actionId: "dusk.approve", data: { botId: "same", threadId: "same-thread", requestId: "r" } }));
    expect(open).toHaveBeenLastCalledWith({ view: "notifications" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); }
});
