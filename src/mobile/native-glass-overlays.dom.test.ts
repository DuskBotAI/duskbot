// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toast } from "@/components/ui/Toast";
import type { PhoneBridge } from "@/lib/phone-bridge";
import { ConnectionPill } from "./connection/ConnectionProblem";
import type { GlassBridge, GlassEvent } from "./native-glass";
import { PlatformContext, webPlatform, type MobilePlatform } from "./platform";
import { ImageViewer } from "./viewers/ImageViewer";
import { ViewerNote } from "./viewers/ViewerNote";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => { root!.unmount(); });
    root = null;
  }
  document.body.innerHTML = "";
  delete document.documentElement.dataset.skin;
  vi.restoreAllMocks();
});

function makeGlass() {
  const listeners = new Set<(event: GlassEvent) => void>();
  const viewer = vi.fn();
  const pill = vi.fn();
  const pullRefresh = vi.fn();
  const bridge: GlassBridge = {
    update: vi.fn(),
    setText: vi.fn(),
    setAvatar: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    clear: vi.fn(),
    slide: vi.fn(),
    viewer,
    pill,
    pullRefresh,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  const emit = (event: GlassEvent) => {
    for (const listener of listeners) listener(event);
  };
  const platform: MobilePlatform = { ...webPlatform(), kind: "ios", native: true, glass: bridge };
  return { platform, viewer, pill, pullRefresh, emit };
}

function mount(node: ReactNode, platform: MobilePlatform) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(createElement(PlatformContext.Provider, { value: platform }, node));
  });
  return host;
}

describe("native Liquid Glass overlays", () => {
  it("routes ViewerNote to the bottom Liquid Glass pill and clears by clearId", () => {
    document.documentElement.dataset.skin = "grok-dark";
    const { platform, pill } = makeGlass();
    mount(createElement(ViewerNote, { show: true, text: "Copied" }), platform);

    expect(pill).toHaveBeenCalledWith("bottom", expect.objectContaining({
      slot: "bottom",
      id: "viewer-note",
      text: "Copied",
      tone: "success",
      symbol: "checkmark",
      dark: true,
    }));

    act(() => {
      root!.render(createElement(PlatformContext.Provider, { value: platform }, createElement(ViewerNote, { show: false, text: "Copied" })));
    });
    expect(pill).toHaveBeenLastCalledWith("bottom", null, "viewer-note");
  });

  it("routes Toast with Undo action and dismiss events through the native Liquid Glass pill", () => {
    const { platform, pill, emit } = makeGlass();
    const onUndo = vi.fn();
    const onDone = vi.fn();
    mount(createElement(Toast, { text: "Message deleted", action: { label: "Undo", onClick: onUndo }, onDone }), platform);

    const lastCall = pill.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("bottom");
    const spec = lastCall?.[1] as { id: string; text: string; actionLabel?: string; dismissible?: boolean };
    expect(spec.text).toBe("Message deleted");
    expect(spec.actionLabel).toBe("Undo");
    expect(spec.dismissible).toBe(true);

    act(() => { emit({ type: "pillTap", slot: "bottom", id: spec.id, kind: "action" }); });
    expect(onUndo).toHaveBeenCalledTimes(1);

    act(() => { emit({ type: "pillTap", slot: "bottom", id: spec.id, kind: "dismiss" }); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("routes ConnectionPill states and retry taps through the top Liquid Glass pill", () => {
    const { platform, pill, emit } = makeGlass();
    const onRetry = vi.fn();
    mount(createElement(ConnectionPill, { notice: "stuck", trying: false, onRetry, testId: "mobile-chat-cloud-status" }), platform);

    expect(pill).toHaveBeenLastCalledWith("top", expect.objectContaining({
      slot: "top",
      id: "mobile-chat-cloud-status",
      symbol: "arrow.counterclockwise",
      tappable: true,
      spinner: false,
    }));

    act(() => { emit({ type: "pillTap", slot: "top", id: "mobile-chat-cloud-status", kind: "pill" }); });
    expect(onRetry).toHaveBeenCalledTimes(1);

    act(() => {
      root!.render(
        createElement(
          PlatformContext.Provider,
          { value: platform },
          createElement(ConnectionPill, { notice: "offline", trying: false, onRetry, testId: "mobile-chat-cloud-status" }),
        ),
      );
    });
    expect(pill).toHaveBeenLastCalledWith("top", expect.objectContaining({
      symbol: "wifi.slash",
      tappable: false,
      spinner: false,
    }));
  });

  it("drives ImageViewer native Liquid Glass controls and handles close/share taps", () => {
    const { platform, viewer, emit } = makeGlass();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.matches(".viewer-key")) {
        return { x: 16, y: 60, left: 16, top: 60, width: 44, height: 44, right: 60, bottom: 104, toJSON: () => ({}) } as DOMRect;
      }
      return { x: 0, y: 0, left: 0, top: 0, width: 390, height: 844, right: 390, bottom: 844, toJSON: () => ({}) } as DOMRect;
    });
    const onClose = vi.fn();
    const share = vi.fn(async () => {});
    const bridge: PhoneBridge = { haptic: vi.fn(), openLink: vi.fn(), share, view: vi.fn() };
    mount(
      createElement(ImageViewer, {
        images: [
          { src: "data:image/png;base64,iVBORw0KGgo=", name: "one.png", openUrl: "https://example.com/1.png" },
          { src: "data:image/png;base64,iVBORw0KGgo=", name: "two.png", openUrl: "https://example.com/2.png" },
        ],
        initialIndex: 0,
        bridge,
        onClose,
      }),
      platform,
    );

    expect(viewer).toHaveBeenCalledWith(expect.objectContaining({
      visible: true,
      close: { x: 16, y: 60, w: 44, h: 44 },
      share: { x: 16, y: 60, w: 44, h: 44 },
      countText: "1 of 2",
    }));

    act(() => { emit({ type: "viewerTap", target: "share" }); });
    expect(share).toHaveBeenCalledWith({ url: "https://example.com/1.png" });

    act(() => { root!.unmount(); root = null; });
    expect(viewer).toHaveBeenLastCalledWith(null);
  });
});
