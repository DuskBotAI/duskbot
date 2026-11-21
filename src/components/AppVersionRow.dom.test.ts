// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { AppUpdateState } from "../../electron/app-update.mjs";
import { AppVersionRow } from "./AppVersionRow";
import { SidebarSpot } from "./SidebarSpot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let tell: (state: AppUpdateState) => void = () => {};
let now: AppUpdateState;
let found: string | null;
const bridge = {
  state: vi.fn(async () => now),
  restart: vi.fn(async () => true),
  download: vi.fn(async () => found),
  seen: vi.fn(async () => {}),
  onState: vi.fn((cb: (state: AppUpdateState) => void) => { tell = cb; return () => {}; }),
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  now = { ready: null, available: null, progress: null, mode: "self" };
  found = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); });

const row = () => host.querySelector<HTMLButtonElement>("[data-settings-open='app-update']");
const mount = async () => { await act(async () => { root.render(createElement(AppVersionRow, { bridge, fallback: createElement("p", { "data-fallback": "" }) })); }); };
const hear = async (state: AppUpdateState) => { await act(async () => { tell(state); }); };

it("a check always answers: checking, then the latest", async () => {
  await mount();
  expect(row()?.textContent).toContain("Check for updates");
  let finish: (v: string | null) => void = () => {};
  bridge.download.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => { row()?.click(); });
  expect(row()?.textContent).toContain("Checking…");
  expect(row()?.disabled).toBe(true);
  await hear({ ...now, checking: false, failed: false });
  await act(async () => { finish(null); });
  expect(row()?.textContent).toContain("You're on the latest version");
});

it("a failed check says so", async () => {
  await mount();
  await act(async () => { row()?.click(); });
  await hear({ ...now, checking: false, failed: true });
  expect(row()?.textContent).toContain("Couldn't check for updates");
});

it("a found update downloads, then offers the restart", async () => {
  await mount();
  await hear({ ...now, available: "0.2.13", progress: 0.4, checking: true });
  expect(row()?.textContent).toContain("Downloading 0.2.13 · 40%");
  await hear({ ...now, ready: "0.2.13", available: "0.2.13", progress: null });
  expect(row()?.textContent).toContain("Restart to update");
  await act(async () => { row()?.click(); });
  expect(bridge.restart).toHaveBeenCalledOnce();
});

it("a source checkout says it's a dev build, with nothing to check", async () => {
  now = { ready: null, mode: "dev" };
  await mount();
  expect(row()).toBeNull();
  expect(host.textContent).toContain("dev build");
  expect(host.textContent).toContain("updates when the checkout does");
});

it("Windows and Linux keep the server's row", async () => {
  now = { ready: null, mode: "notice" };
  await mount();
  expect(host.querySelector("[data-fallback]")).not.toBeNull();
});

it("the sidebar says once that the app updated, and a click puts it away", async () => {
  now = { ready: null, mode: "self", updated: "0.2.13" };
  await act(async () => { root.render(createElement(SidebarSpot, { bridge })); });
  const note = host.querySelector<HTMLButtonElement>("[data-app-updated]");
  expect(note?.textContent).toBe("Updated to 0.2.13");
  await act(async () => { note?.click(); });
  expect(bridge.seen).toHaveBeenCalled();
  await hear({ ready: null, mode: "self", updated: null });
  expect(host.querySelector("[data-app-updated]")).toBeNull();
});

it("uses the linked workspace even when an older Mac bridge also offers app updates", async () => {
  vi.stubGlobal("duskDesktop", { app: { ownPage: false }, appUpdate: bridge });
  try {
    await act(async () => { root.render(createElement(AppVersionRow, { fallback: createElement("p", { "data-fallback": "" }) })); });
    expect(host.querySelector("[data-fallback]")).not.toBeNull();
    expect(bridge.state).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
