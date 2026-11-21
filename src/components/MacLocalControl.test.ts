import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  localComputer: { available: false, message: "Accessibility required; grant access in System Settings" } as DesktopCapabilities["localComputer"],
}));
vi.stubGlobal("window", {
  duskDesktop: { platform: "darwin", permOpenSettings: vi.fn(), relaunch: vi.fn() },
});
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { host: { platform: "darwin" }, localComputer: fixture.localComputer }, ready: true }),
}));

const { MacLocalControl } = await import("./MacLocalControl");
afterAll(() => { vi.unstubAllGlobals(); setLocale("en"); });

describe("Mac local computer status", () => {
  it("shows the recorded Accessibility failure and its matching recovery actions", () => {
    const markup = renderToStaticMarkup(createElement(MacLocalControl));
    expect(markup).toContain("Accessibility is required for dusk bot");
    expect(markup).toContain("Open Accessibility settings");
    expect(markup).toContain("relaunch dusk bot");
    expect(markup).not.toContain("Open Screen Recording settings");
    expect(markup, "the driver detail shows inline, not folded").not.toContain("<details");
  });

  it("does not turn a missing reason into a claimed permission diagnosis", () => {
    fixture.localComputer = { available: false, status: "unavailable" } as DesktopCapabilities["localComputer"];
    const markup = renderToStaticMarkup(createElement(MacLocalControl));
    expect(markup).toContain("To use this Mac, turn on Accessibility and Screen Recording for dusk bot in System Settings, then retry.");
    expect(markup).not.toContain("Accessibility is required");
    expect(markup).not.toContain("relaunch dusk bot</button>");
  });

  it("speaks the app's language on the card's own title and buttons", () => {
    fixture.localComputer = { available: false, status: "unavailable" } as DesktopCapabilities["localComputer"];
    setLocale("de");
    const markup = renderToStaticMarkup(createElement(MacLocalControl));
    setLocale("en");
    expect(markup).toContain("Steuerung dieses Computers erlauben");
    expect(markup).toContain("Systemeinstellungen öffnen");
    expect(markup).toContain("Erneut versuchen");
    for (const english of ["Allow control of this computer", "Open System Settings", ">Retry<"]) expect(markup).not.toContain(english);
  });

  it("does not offer host repair actions to a remote renderer", () => {
    fixture.localComputer = { available: false, status: "unavailable", reasonCode: "remote-server" } as DesktopCapabilities["localComputer"];
    expect(renderToStaticMarkup(createElement(MacLocalControl))).toBe("");
  });
});
