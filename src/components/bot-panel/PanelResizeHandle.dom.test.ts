// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PANEL_MIN_WIDTH, PANEL_NARROW, maxPanelWidth, setPanelWidth } from "@/lib/panel-wide";

import { PanelResizeHandle } from "./PanelResizeHandle";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const separator = () => host.querySelector<HTMLElement>('[role="separator"]')!;
const panelWidth = () => document.documentElement.style.getPropertyValue("--side-panel-w");
const savedWidth = () => localStorage.getItem("duskbot.panelWidth");
const press = (key: string) => act(() => {
  separator().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
});

beforeEach(() => {
  localStorage.clear();
  setPanelWidth(PANEL_NARROW);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(PanelResizeHandle)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setPanelWidth(PANEL_NARROW);
});

describe("the bot panel's resize edge", () => {
  it("is a keyboard-resizable separator labelled for the panel", () => {
    expect(separator().getAttribute("aria-label")).toBe("Resize panel");
    expect(separator().getAttribute("aria-orientation")).toBe("vertical");
    expect(separator().getAttribute("aria-valuemin")).toBe(String(PANEL_MIN_WIDTH));
    expect(separator().getAttribute("aria-valuemax")).toBe(String(maxPanelWidth()));
    expect(separator().getAttribute("aria-valuenow")).toBe(String(PANEL_NARROW));
  });

  it("widens with the left arrow and narrows with the right, keeping the width", () => {
    press("ArrowLeft");
    expect(panelWidth()).toBe("344px");
    expect(separator().getAttribute("aria-valuenow")).toBe("344");
    expect(savedWidth()).toBe("344");
    press("ArrowRight");
    expect(panelWidth()).toBe("320px");
    expect(savedWidth()).toBe("320");
  });

  it("stops at the narrowest width and at the room the chat leaves", () => {
    for (let i = 0; i < 10; i++) press("ArrowRight");
    expect(panelWidth()).toBe(`${PANEL_MIN_WIDTH}px`);
    for (let i = 0; i < 40; i++) press("ArrowLeft");
    expect(panelWidth()).toBe(`${maxPanelWidth()}px`);
  });
});
