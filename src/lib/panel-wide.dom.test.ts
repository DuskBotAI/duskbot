// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { panelRestMax, resizePanel } from "./panel-wide";

function room(px: number) {
  document.body.innerHTML = "<div><main></main><aside data-panel-slot></aside></div>";
  const main = document.querySelector("main")!;
  const slot = document.querySelector<HTMLElement>("[data-panel-slot]")!;
  main.getBoundingClientRect = () => ({ left: 0 }) as DOMRect;
  slot.getBoundingClientRect = () => ({ right: px }) as DOMRect;
}
const panelWidth = () => document.documentElement.style.getPropertyValue("--side-panel-w");

describe("the bot panel's width", () => {
  it("leaves the chat at least 420px, and gives way when the window shrinks, coming back when it grows", () => {
    room(1200);
    expect(panelRestMax()).toBe(780);
    resizePanel(5000, true);
    expect(panelWidth()).toBe("780px");
    room(900);
    window.dispatchEvent(new Event("resize"));
    expect(panelWidth()).toBe("480px");
    room(1200);
    window.dispatchEvent(new Event("resize"));
    expect(panelWidth()).toBe("780px");
  });
});
