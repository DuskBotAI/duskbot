// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askForCall, takeCallAsk } from "@/lib/call";
import { initialState, type AppState, type Bot } from "@/state/store";
import type { MobileConnectionRecord } from "../../shared/mobile-link";
import type { MobilePlatform } from "./platform";
import { shortcutAction, useShortcuts, type ShortcutAction, type ShortcutsBridge } from "./shortcuts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const record = (id: string, environmentId: string, label: string) => ({ id, environmentId, label } as MobileConnectionRecord);
const linked = [record("home", "env-home", "Home Mac"), record("cloud", "env-cloud", "my cloud")];
const kiln = { id: "kiln", name: "Kiln", threadId: "t-kiln", messages: [] } as unknown as Bot;

let root: Root, host: HTMLDivElement, fire: (action: ShortcutAction) => void, setBots: ReturnType<typeof vi.fn<ShortcutsBridge["setBots"]>>, forget: ReturnType<typeof vi.fn<ShortcutsBridge["forget"]>>, bridge: ShortcutsBridge;
beforeEach(() => {
  host = document.createElement("div"); root = createRoot(host); sessionStorage.clear();
  fire = () => {};
  setBots = vi.fn<ShortcutsBridge["setBots"]>(); forget = vi.fn<ShortcutsBridge["forget"]>();
  bridge = { setBots, forget, onAction: (listener) => { fire = listener; return () => {}; } };
});
afterEach(() => { act(() => root.unmount()); });

function mount(state: Partial<AppState>, connections = linked) {
  const dispatch = vi.fn(), switchTo = vi.fn(async () => {}), openChat = vi.fn();
  const full = { ...initialState, hydrated: true, connected: true, bots: [kiln], ...state } as AppState;
  const Probe = () => { useShortcuts({ platform: { shortcuts: bridge } as unknown as MobilePlatform, state: full, dispatch, place: "home", connections, loaded: true, switchTo, openChat }); return null; };
  act(() => root.render(createElement(Probe)));
  return { dispatch, switchTo, openChat };
}

describe("Siri and Shortcuts runs", () => {
  it("reads only well formed runs", () => {
    expect(shortcutAction({ kind: "send", place: "env-home", botId: "kiln", text: "  hi  " })).toEqual({ kind: "send", place: "env-home", botId: "kiln", text: "hi" });
    expect(shortcutAction({ kind: "send", place: "env-home", botId: "kiln", text: "   " })).toBeNull();
    expect(shortcutAction({ kind: "call", place: "env-home", botId: "../x" })).toBeNull();
    expect(shortcutAction({ kind: "delete", place: "env-home", botId: "kiln" })).toBeNull();
  });

  it("lists the place's bots by name and forgets them once no place is left", () => {
    mount({});
    expect(setBots).toHaveBeenCalledWith({ place: "env-home", placeName: "Home Mac", bots: [{ id: "kiln", name: "Kiln" }], places: ["env-home", "env-cloud"] });
    act(() => root.unmount()); root = createRoot(host);
    mount({}, []);
    expect(forget).toHaveBeenCalledOnce();
  });

  it("sends the message from the bot's chat, as a notification's reply does", () => {
    const app = mount({});
    act(() => fire({ kind: "send", place: "env-home", botId: "kiln", text: "Ship it" }));
    expect(app.openChat).toHaveBeenCalledWith("kiln");
    expect(app.dispatch).toHaveBeenCalledWith({ type: "send", botId: "kiln", text: "Ship it", threadId: "t-kiln" });
  });

  it("waits for the place to connect before sending", () => {
    const app = mount({ connected: false });
    act(() => fire({ kind: "send", place: "env-home", botId: "kiln", text: "Later" }));
    expect(app.dispatch).not.toHaveBeenCalled();
  });

  it("a call opens the chat and asks its call button to start", () => {
    const app = mount({});
    act(() => fire({ kind: "call", place: "env-home", botId: "kiln" }));
    expect(app.openChat).toHaveBeenCalledWith("kiln");
    expect(takeCallAsk("kiln")).toBe(true);
    expect(takeCallAsk("kiln")).toBe(false);
  });

  it("a bot on another linked place switches to it and keeps the run for after the reload", () => {
    const app = mount({});
    act(() => fire({ kind: "send", place: "env-cloud", botId: "nova", text: "Hi" }));
    expect(app.switchTo).toHaveBeenCalledWith("cloud");
    expect(JSON.parse(sessionStorage.getItem("dusk.mobile.shortcut.held")!)).toEqual({ kind: "send", place: "env-cloud", botId: "nova", text: "Hi" });
    expect(app.dispatch).not.toHaveBeenCalled();
  });
});

describe("an asked call", () => {
  it("lapses when no call button takes it soon", () => {
    askForCall("kiln", 1_000);
    expect(takeCallAsk("kiln", 20_000)).toBe(false);
  });
});
