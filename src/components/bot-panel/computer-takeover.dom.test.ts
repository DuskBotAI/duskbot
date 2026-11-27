// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  signInFocus: null as null | { botId: string; messageId: string; url: string; site: string; place: "browser" | "cloud" | "vm" | "local"; requestId: number; consumed: boolean },
  computerControl: {} as Record<string, { held: boolean; helpReason: string | null; help?: { botId: string; threadId: string; messageId: string; site: string; place: "browser" | "cloud" | "vm" | "local" } | null }>,
  cloudHome: true,
}));

vi.mock("@/state/store", () => ({
  useStore: () => ({
    state: {
      config: { cloudHome: f.cloudHome, browserEngine: { engine: "chrome" } },
      signInFocus: f.signInFocus,
      computerControl: f.computerControl,
    },
    dispatch: vi.fn(),
  }),
  api: vi.fn(),
}));
vi.mock("../DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { platform: "linux" } } }),
}));
vi.mock("../PlaceChip", () => ({
  usePlaceViews: () => ({
    local: { policy: false, reachable: false, view: { line: "" } },
    browser: { policy: true, reachable: true, view: { line: "" } },
    cloud: { policy: true, reachable: true, view: { line: "" } },
    vm: { policy: false, reachable: false, view: { line: "" } },
  }),
}));
vi.mock("@/lib/other-server", () => ({
  desktopShowsOtherServer: () => false,
  useOtherServerName: () => null,
}));
vi.mock("./CloudDesktop", () => ({
  CloudDesktopListRow: () => null,
  useCloudDesktop: () => null,
}));
vi.mock("./LocalBrowser", () => ({
  LocalBrowserSection: () => createElement("div", { "data-stub-local-browser": "true" }),
}));
vi.mock("../ComputerPanel", () => ({
  ComputerPanel: () => createElement("div", { "data-stub-computer-panel": "true" }),
}));

import { ComputerTab } from "./ComputerTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOT = { id: "micro", name: "Micro", threadId: "t1", browser: true, computer: "auto" } as never;
const DERIVED = { patch: vi.fn(), approvalMode: "ask" } as never;

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  f.signInFocus = null;
  f.computerControl = {};
  f.cloudHome = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const render = () => act(async () => {
  root.render(createElement(ComputerTab, { bot: BOT, derived: DERIVED, onOpen: vi.fn() }));
});

describe("ComputerTab browser sign-in takeover on server/cloud bots", () => {
  it("shows the computer screen normally when a cloud bot is on auto", async () => {
    await render();
    expect(host.querySelector("[data-stub-local-browser]")).toBeNull();
    expect(host.querySelector("[data-panel-screen-of]")).not.toBeNull();
  });

  it("shows the live built-in browser when a browser sign-in takeover is requested for a cloud bot", async () => {
    f.signInFocus = { botId: "micro", messageId: "m1", url: "https://youtube.com/", site: "youtube.com", place: "browser", requestId: 1, consumed: false };
    await render();
    expect(host.querySelector("[data-stub-local-browser]")).not.toBeNull();
    // Stays on the browser even after LocalBrowserSection marks signInFocus consumed
    f.signInFocus = { ...f.signInFocus, consumed: true };
    await render();
    expect(host.querySelector("[data-stub-local-browser]")).not.toBeNull();
  });

  it("shows the live built-in browser whenever computerControl reports an active browser help request", async () => {
    f.computerControl = { micro: { held: false, helpReason: "sign in to youtube.com", help: { botId: "micro", threadId: "t1", messageId: "m1", site: "youtube.com", place: "browser" } } };
    await render();
    expect(host.querySelector("[data-stub-local-browser]")).not.toBeNull();
  });
});
