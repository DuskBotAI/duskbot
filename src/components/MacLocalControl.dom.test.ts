// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: { host: { platform: "darwin" }, localComputer: { available: false, status: "unavailable" } },
    ready: true,
  }),
}));

const { MacLocalControl } = await import("./MacLocalControl");

function install(status: { supported: true; accessibility: string; screen: string }) {
  const desktop = {
    platform: "darwin",
    permOpenSettings: vi.fn(async () => {}),
    localControl: { retry: vi.fn(async () => {}) },
    macPermissions: { status: vi.fn(async () => status), request: vi.fn() },
  };
  (window as unknown as { duskDesktop: unknown }).duskDesktop = desktop;
  return desktop;
}

async function clickOpenSettings() {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(MacLocalControl)));
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent?.includes("Open System Settings"));
  await act(async () => button!.click());
  return root;
}

afterEach(() => {
  delete (window as unknown as { duskDesktop?: unknown }).duskDesktop;
  document.body.innerHTML = "";
});

describe("Open System Settings on the This Mac card", () => {
  it("opens only the first missing permission's pane", async () => {
    const desktop = install({ supported: true, accessibility: "missing", screen: "missing" });
    const root = await clickOpenSettings();
    expect(desktop.permOpenSettings.mock.calls).toEqual([["accessibility"]]);
    act(() => root.unmount());
  });

  it("opens Screen Recording once Accessibility is granted", async () => {
    const desktop = install({ supported: true, accessibility: "granted", screen: "asked" });
    const root = await clickOpenSettings();
    expect(desktop.permOpenSettings.mock.calls).toEqual([["screen"]]);
    act(() => root.unmount());
  });

  it("checks again only when the person comes back from System Settings", async () => {
    const desktop = install({ supported: true, accessibility: "missing", screen: "missing" });
    const root = await clickOpenSettings();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(desktop.localControl.retry).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new Event("blur")));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(desktop.localControl.retry).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
    expect(desktop.localControl.retry).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
