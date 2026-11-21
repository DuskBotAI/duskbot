// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformContext, webPlatform, type MobileChrome, type MobilePlatform } from "./platform";
import { measureSheetContentHeight, Sheet } from "./Sheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function rect(top: number, height: number, width = 360): DOMRect {
  return { top, bottom: top + height, height, width, left: 0, right: width, x: 0, y: top, toJSON() {} } as DOMRect;
}

describe("measureSheetContentHeight", () => {
  it("uses child geometry when scrollHeight omits bottom padding on an overflowing container", () => {
    const body = document.createElement("div");
    const child = document.createElement("div");
    body.append(child);
    document.body.append(body);
    try {
      Object.defineProperty(body, "scrollHeight", { value: 558, configurable: true });
      vi.spyOn(child, "getBoundingClientRect").mockReturnValue(rect(78, 480));
      vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
        if (el === body) return { paddingTop: "78px", paddingBottom: "34px" } as CSSStyleDeclaration;
        return { marginTop: "0px", marginBottom: "0px" } as CSSStyleDeclaration;
      });
      expect(measureSheetContentHeight(body)).toBe(480);
    } finally {
      body.remove();
      vi.restoreAllMocks();
    }
  });

  it("spans multiple children with margins and skips hidden children", () => {
    const body = document.createElement("div");
    const hidden = document.createElement("div");
    const first = document.createElement("p");
    const last = document.createElement("div");
    body.append(hidden, first, last);
    document.body.append(body);
    try {
      Object.defineProperty(body, "scrollHeight", { value: 0, configurable: true });
      vi.spyOn(hidden, "getBoundingClientRect").mockReturnValue(rect(0, 0, 0));
      vi.spyOn(first, "getBoundingClientRect").mockReturnValue(rect(80, 48));
      vi.spyOn(last, "getBoundingClientRect").mockReturnValue(rect(140, 200));
      vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
        if (el === body) return { paddingTop: "80px", paddingBottom: "34px" } as CSSStyleDeclaration;
        if (el === first) return { marginTop: "4px", marginBottom: "0px" } as CSSStyleDeclaration;
        if (el === last) return { marginTop: "0px", marginBottom: "12px" } as CSSStyleDeclaration;
        return { marginTop: "0px", marginBottom: "0px" } as CSSStyleDeclaration;
      });
      expect(measureSheetContentHeight(body)).toBe(276);
    } finally {
      body.remove();
      vi.restoreAllMocks();
    }
  });
});

describe("SystemSheet fit measurement", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 0) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    host = document.createElement("div");
    host.className = "dusk-mobile";
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await new Promise((r) => setTimeout(r, 0));
    });
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("re-measures after presentation when the sheet narrows and content wraps taller", async () => {
    let presentedHeight: number | null | undefined;
    const resized: number[] = [];
    let currentChildHeight = 460;
    const chrome: MobileChrome = {
      setBar: () => {},
      onBarPress: () => () => {},
      onPictureTaken: () => () => {},
      freeze: async () => {},
      thaw: async () => {},
      presentSheet: async (height) => {
        presentedHeight = height;
        currentChildHeight = 482;
      },
      resizeSheet: (height) => { resized.push(height); },
      dismissSheet: async () => {},
      onSheetDismissed: () => () => {},
    };
    const platform: MobilePlatform = { ...webPlatform(), chrome };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-fit-child")) return rect(78, currentChildHeight);
      return rect(0, 0, 0);
    });
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({ paddingTop: "78px", paddingBottom: "34px", marginTop: "0px", marginBottom: "0px" }) as CSSStyleDeclaration);

    await act(async () => {
      root.render(createElement(
        PlatformContext,
        { value: platform },
        createElement(Sheet, { open: true, onClose: () => {}, title: "Before you chat", children: createElement("div", { "data-fit-child": "" }, "body") }),
      ));
    });
    for (let i = 0; i < 6; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }

    expect(presentedHeight).toBe(460);
    expect(resized).toContain(482);
  });
});
