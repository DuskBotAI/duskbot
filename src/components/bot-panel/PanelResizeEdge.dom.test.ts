// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let wide: typeof import("@/lib/panel-wide");

const edge = () => host.querySelector<HTMLElement>('[role="separator"]')!;
const cssWidth = () => document.documentElement.style.getPropertyValue("--side-panel-w");
const press = (key: string) => act(() => { edge().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

async function mount() {
  vi.resetModules();
  wide = await import("@/lib/panel-wide");
  const { PanelResizeEdge } = await import("./PanelResizeEdge");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(PanelResizeEdge)));
}

const stored = new Map<string, string>();
const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } };

beforeEach(() => {
  vi.stubGlobal("localStorage", storage);
  stored.clear();
  document.documentElement.style.removeProperty("--side-panel-w");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the bot panel's edge", () => {
  it("is a named separator that keeps the panel's hairline", async () => {
    await mount();
    expect(edge().getAttribute("aria-label")).toBe("Resize panel");
    expect(edge().getAttribute("aria-valuenow")).toBe("320");
    expect(edge().getAttribute("tabindex")).toBe("0");
    expect(host.querySelector("[data-panel-edge]")).not.toBeNull();
  });

  it("widens with the left arrow and narrows with the right, and the next open starts at that width", async () => {
    await mount();
    press("ArrowLeft");
    press("ArrowLeft");
    expect(cssWidth()).toBe("352px");
    expect(edge().getAttribute("aria-valuenow")).toBe("352");
    press("ArrowRight");
    expect(cssWidth()).toBe("336px");
    act(() => root.unmount());
    host.remove();
    document.documentElement.style.removeProperty("--side-panel-w");
    await mount();
    expect(wide.panelRest()).toBe(336);
    expect(cssWidth()).toBe("336px");
  });

  it("follows a drag of its edge, and keeps the width only once the drag ends", async () => {
    await mount();
    const at = (type: string, clientX: number) => act(() => { edge().dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX })); });
    edge().setPointerCapture = () => {};
    edge().hasPointerCapture = () => true;
    at("pointerdown", 1000);
    at("pointermove", 900);
    await act(() => new Promise((done) => requestAnimationFrame(() => done(undefined))));
    expect(cssWidth()).toBe("420px");
    expect(stored.get("dusk-bot-panel-width") ?? null).toBeNull();
    at("pointerup", 900);
    expect(stored.get("dusk-bot-panel-width") ?? null).toBe("420");
  });

  it("stops at its narrowest, and never squeezes the chat beside it", async () => {
    await mount();
    for (let i = 0; i < 10; i++) press("ArrowRight");
    expect(wide.panelRest()).toBe(wide.PANEL_MIN);
    for (let i = 0; i < 80; i++) press("ArrowLeft");
    expect(wide.panelRest()).toBe(wide.panelRestMax());
    expect(wide.panelRestMax()).toBeLessThanOrEqual(1400 - 48 - 400);
  });

  it("drags a panel the browser widened from the width it shows, not the narrower one it rests at", async () => {
    await mount();
    act(() => wide.setPanelWide(true));
    const shown = wide.panelWidthNow();
    expect(shown).toBeGreaterThan(wide.panelRest());
    expect(edge().getAttribute("aria-valuenow")).toBe(String(shown));
    const at = (type: string, clientX: number) => act(() => { edge().dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX })); });
    edge().setPointerCapture = () => {};
    edge().hasPointerCapture = () => true;
    at("pointerdown", 600);
    at("pointermove", 610);
    await act(() => new Promise((done) => requestAnimationFrame(() => done(undefined))));
    expect(cssWidth()).toBe(`${shown - 10}px`);
    at("pointerup", 610);
    expect(stored.get("dusk-bot-panel-width")).toBe(String(shown - 10));
  });

  it("steps a widened panel from the width it shows", async () => {
    await mount();
    act(() => wide.setPanelWide(true));
    const shown = wide.panelWidthNow();
    press("ArrowRight");
    expect(cssWidth()).toBe(`${shown - 16}px`);
  });

  it("goes back to its usual width on a double-click, and keeps that", async () => {
    await mount();
    press("ArrowLeft");
    press("ArrowLeft");
    act(() => { edge().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(cssWidth()).toBe("320px");
    expect(edge().getAttribute("aria-valuenow")).toBe("320");
    expect(stored.get("dusk-bot-panel-width")).toBe("320");
  });

  it("forgets a stored width it could never have been dragged to", async () => {
    stored.set("dusk-bot-panel-width", "12");
    await mount();
    expect(wide.panelRest()).toBe(320);
    stored.set("dusk-bot-panel-width", "nonsense");
    await mount();
    expect(wide.panelRest()).toBe(320);
  });

  it("comes back to the dragged width after the browser in it widens the panel", async () => {
    await mount();
    press("ArrowLeft");
    wide.setPanelWide(true);
    expect(wide.panelWide()).toBe(true);
    wide.setPanelWide(false);
    expect(wide.panelWide()).toBe(false);
    expect(cssWidth()).toBe("336px");
  });
});
