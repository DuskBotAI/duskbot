// @vitest-environment happy-dom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewStreamControl, PreviewStreamInput } from "@/lib/browser-stream-client";
import { START_PAGE } from "@/components/bot-panel/LocalBrowser";
import { opensBrowserTakeoverDirectly, PhoneBrowserTakeover } from "./PhoneBrowserTakeover";
import { PlatformContext, type MobilePlatform } from "./platform";

const sent: PreviewStreamInput[] = [];
let surfaceProps: {
  onClient?: (client: unknown) => void;
  onControl?: (control: PreviewStreamControl | null) => void;
  onMessage?: (message: Readonly<Record<string, unknown>>) => void;
  onConnectedChange?: (connected: boolean) => void;
} = {};

vi.mock("@/state/store", () => ({
  api: vi.fn(),
  useStore: () => ({ state: { config: { browserEngine: { engine: "chrome" } }, computerControl: {} } }),
}));

vi.mock("@/components/browser/StreamSurface", () => ({
  StreamSurface: (props: typeof surfaceProps) => {
    surfaceProps = props;
    return createElement("div", { "data-testid": "stub-stream-surface" });
  },
}));

vi.mock("./ScreenTrackpad", () => ({
  ScreenTrackpad: () => null,
}));

let shellProps: { onExit?: () => void } = {};
vi.mock("./PhoneTakeoverViewer", () => ({
  PhoneTakeoverShell: (props: { onExit?: () => void; frame?: unknown }) => {
    shellProps = props;
    return createElement("div", { "data-testid": "stub-takeover-shell" }, props.frame as never);
  },
}));

afterEach(() => {
  sent.length = 0;
  surfaceProps = {};
  shellProps = {};
  document.body.innerHTML = "";
});

const stubPlatform = {
  kind: "ios",
  native: true,
  appVersion: "1.5",
  deviceName: () => "iPhone",
  haptic: () => {},
  openExternal: async () => {},
  prefs: { get: async () => null, set: async () => {} },
} as unknown as MobilePlatform;

const stubBot = {
  id: "b1",
  name: "Micro",
  threadId: "t1",
} as never;

describe("opensBrowserTakeoverDirectly", () => {
  it("opens directly for local Mac/PC bots using auto (undefined), local, or browser computer modes", () => {
    expect(opensBrowserTakeoverDirectly({ id: "b1" }, {})).toBe(true);
    expect(opensBrowserTakeoverDirectly({ id: "b1", computer: undefined }, { config: { cloudHome: false } })).toBe(true);
    expect(opensBrowserTakeoverDirectly({ id: "b1", computer: "local" }, { config: { cloudHome: false } })).toBe(true);
    expect(opensBrowserTakeoverDirectly({ id: "b1", computer: "browser" }, { config: { cloudHome: false } })).toBe(true);
  });

  it("falls back to the computer sheet for disabled, off, VM, or cloud desktop bots unless browser help is active", () => {
    expect(opensBrowserTakeoverDirectly({ id: "b1", browser: false }, {})).toBe(false);
    expect(opensBrowserTakeoverDirectly({ id: "b1", computer: "off" }, {})).toBe(false);
    expect(opensBrowserTakeoverDirectly({ id: "b1", computer: "vm" }, {})).toBe(false);
    expect(opensBrowserTakeoverDirectly({ id: "b1", computer: "cloud" }, { config: { cloudHome: true } })).toBe(false);
    expect(opensBrowserTakeoverDirectly({ id: "b1", computer: undefined }, { config: { cloudHome: true } })).toBe(false);
    expect(opensBrowserTakeoverDirectly({ id: "b1", computer: "browser" }, { config: { cloudHome: true } })).toBe(true);
    expect(opensBrowserTakeoverDirectly(
      { id: "b1", computer: "cloud" },
      { config: { cloudHome: true }, computerControl: { b1: { help: { place: "browser" } } } },
    )).toBe(true);
  });
});

describe("PhoneBrowserTakeover direct launch", () => {
  it("takes control, opens the start page when the browser starts blank, and releases control on exit", () => {
    const onClose = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      flushSync(() => root.render(createElement(
        PlatformContext.Provider,
        { value: stubPlatform },
        createElement(PhoneBrowserTakeover, { bot: stubBot, signIn: null, onClose }),
      )));

      const client = {
        send: (input: PreviewStreamInput) => { sent.push(input); return true; },
      };
      flushSync(() => {
        surfaceProps.onClient?.(client);
        surfaceProps.onControl?.({ canOperate: true, controller: "unclaimed", owned: false } as PreviewStreamControl);
        surfaceProps.onConnectedChange?.(true);
      });
      expect(sent).toContainEqual({ type: "takeControl" });

      flushSync(() => {
        surfaceProps.onMessage?.({ type: "tabs", tabs: [{ tabId: "tab-1", url: "about:blank", title: "", active: true }] });
      });
      expect(sent).toContainEqual({ type: "navigate", url: START_PAGE });

      flushSync(() => shellProps.onExit?.());
      expect(sent).toContainEqual({ type: "releaseControl" });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      root.unmount();
    }
  });

  it("keeps the existing page when the browser already has a real tab open", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      flushSync(() => root.render(createElement(
        PlatformContext.Provider,
        { value: stubPlatform },
        createElement(PhoneBrowserTakeover, { bot: stubBot, signIn: null, onClose: () => {} }),
      )));

      const client = {
        send: (input: PreviewStreamInput) => { sent.push(input); return true; },
      };
      flushSync(() => {
        surfaceProps.onClient?.(client);
        surfaceProps.onConnectedChange?.(true);
        surfaceProps.onMessage?.({ type: "tabs", tabs: [{ tabId: "tab-1", url: "https://example.com", title: "Example", active: true }] });
      });
      expect(sent.some((input) => input.type === "navigate")).toBe(false);
    } finally {
      root.unmount();
    }
  });
});
