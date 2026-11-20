// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePhoneLayout } from "./use-media-query";

function layoutAt(width: number): boolean {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width: 767.98px") && width < 768, addEventListener() {}, removeEventListener() {} }));
  let seen = false;
  const Probe = () => { seen = usePhoneLayout(); return null; };
  const root = createRoot(document.createElement("div"));
  flushSync(() => root.render(createElement(Probe)));
  root.unmount();
  return seen;
}

afterEach(() => { delete document.documentElement.dataset.mobileApp; vi.unstubAllGlobals(); });

describe("the phone layout", () => {
  it("follows the window's width in a browser", () => {
    expect(layoutAt(390)).toBe(true);
    expect(layoutAt(1024)).toBe(false);
  });

  it("holds in the phone app at any width, an iPhone on its side included", () => {
    document.documentElement.dataset.mobileApp = "ios";
    expect(layoutAt(852)).toBe(true);
  });
});
