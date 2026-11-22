// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScreenControl } from "@/components/ComputerFullscreen";
import type { GlassBridge, GlassEvent, TakeoverGlassState } from "./native-glass";
import { PlatformContext, type MobilePlatform, type SystemMenuAction } from "./platform";
import { PhoneTakeoverShell } from "./PhoneTakeoverViewer";
import { ScreenTrackpad, type RemoteInput } from "./ScreenTrackpad";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  delete document.documentElement.dataset.nativeGlassTakeover;
  document.body.innerHTML = "";
});

function makePlatform(overrides: Partial<MobilePlatform> = {}): MobilePlatform {
  return {
    kind: "ios",
    native: true,
    appVersion: "test",
    deviceName: () => "iPhone",
    haptic: vi.fn(),
    openExternal: vi.fn(async () => {}),
    prefs: { get: async () => null, set: async () => {}, remove: async () => {} },
    secrets: { get: async () => null, set: async () => {}, remove: async () => {} },
    setStatusBar: vi.fn(),
    setAppearance: vi.fn(),
    orientation: { allowLandscape: vi.fn(), rotate: vi.fn() },
    ...overrides,
  };
}

describe("PhoneTakeoverShell", () => {
  it("renders Grok-style pure-black top bar, connecting spinner, bottom bar, and dark status/appearance", async () => {
    const platform = makePlatform();
    const onDone = vi.fn();
    const onExit = vi.fn();
    const onKeyboard = vi.fn();
    const control: ScreenControl = { held: true, asked: true, onDone };

    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(PhoneTakeoverShell, {
        label: "Micro's browser",
        bot: { id: "b1", name: "Micro", color: "orange" },
        name: "Micro",
        platform,
        landscape: false,
        onExit,
        frame: createElement("div", { "data-test-frame": "" }),
        connecting: true,
        control,
        watchHint: { count: 0, shown: false },
        onKeyboard,
        trackpadMode: false,
        onToggleTrackpad: vi.fn(),
        onRecenterPointer: vi.fn(),
        onPasteFromPhone: vi.fn(),
        onCopyToPhone: vi.fn(),
      }));
    });

    expect(platform.setStatusBar).toHaveBeenCalledWith("light");
    expect(platform.setAppearance).toHaveBeenCalledWith("dark");
    expect(document.querySelector("[data-takeover-identity]")?.textContent).toContain("Micro");
    expect(document.querySelector("[data-takeover-connecting]")?.textContent).toContain("Connecting…");
    expect(document.querySelector("[data-computer-control='held']")?.textContent).toContain("I'm done");

    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-computer-control] button")!.click();
    });
    expect(onDone).toHaveBeenCalledTimes(1);

    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-computer-exit]")!.click();
    });
    expect(onExit).toHaveBeenCalledTimes(1);

    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-computer-keyboard]")!.click();
    });
    expect(onKeyboard).toHaveBeenCalledTimes(1);
  });

  it("opens the native UIMenu for more options and clipboard when platform.showMenu is provided", async () => {
    const shown: Array<{ items: SystemMenuAction[] }> = [];
    const showMenu = vi.fn(async (_anchor, items: SystemMenuAction[]) => {
      shown.push({ items });
      return items[0]?.key ?? null;
    });
    const platform = makePlatform({ showMenu });
    const onToggleTrackpad = vi.fn();
    const onPasteFromPhone = vi.fn();

    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(PhoneTakeoverShell, {
        label: "Micro's computer",
        name: "Micro",
        platform,
        landscape: false,
        onExit: vi.fn(),
        frame: createElement("div"),
        control: { held: true, asked: true, onDone: vi.fn() },
        watchHint: { count: 0, shown: false },
        trackpadMode: true,
        onToggleTrackpad,
        onRecenterPointer: vi.fn(),
        onPasteFromPhone,
        onCopyToPhone: vi.fn(),
      }));
    });

    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-takeover-more]")!.click();
    });
    expect(shown[0]?.items.map((i) => i.label)).toEqual(["Trackpad mode", "Recenter pointer"]);
    expect(shown[0]?.items[0]?.checked).toBe(true);
    expect(onToggleTrackpad).toHaveBeenCalledTimes(1);

    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-takeover-clipboard]")!.click();
    });
    expect(shown[1]?.items.map((i) => i.label)).toEqual(["Paste from phone", "Copy to phone"]);
    expect(onPasteFromPhone).toHaveBeenCalledTimes(1);
  });

  it("opens and closes the Settings-styled Using the computer help sheet with all four sections", async () => {
    const platform = makePlatform();
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(PhoneTakeoverShell, {
        label: "Micro's computer",
        name: "Micro",
        platform,
        landscape: false,
        onExit: vi.fn(),
        frame: createElement("div"),
        control: { held: true, asked: true, onDone: vi.fn() },
        watchHint: { count: 0, shown: false },
      }));
    });

    expect(document.querySelector("[data-takeover-help-sheet]")).toBeNull();
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-takeover-help]")!.click();
    });
    const sheet = document.querySelector("[data-takeover-help-sheet]")!;
    expect(sheet).not.toBeNull();
    expect(sheet.querySelectorAll("[data-settings-card]").length).toBe(4);
    expect(sheet.querySelectorAll("[data-settings-row]").length).toBe(9);
    expect(sheet.textContent).toContain("Moving around");
    expect(sheet.textContent).toContain("Typing and the clipboard");
    expect(sheet.textContent).toContain("When a pointer is easier");
    expect(sheet.textContent).toContain("Handing it back");

    await act(async () => {
      document.querySelector<HTMLButtonElement>('.mobile-sheet-layer [aria-label="Close"]')!.click();
    });
    expect(platform.setAppearance).toHaveBeenLastCalledWith("dark");
  });

  it("raises the bottom bar above the software keyboard", async () => {
    let kbListener: ((frame: { height: number; phase: "will" | "did" }) => void) | null = null;
    const platform = makePlatform({
      onKeyboard: (listener) => {
        kbListener = listener;
        return () => { kbListener = null; };
      },
    });
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(PhoneTakeoverShell, {
        label: "Micro's computer",
        name: "Micro",
        platform,
        landscape: false,
        onExit: vi.fn(),
        frame: createElement("div"),
        control: { held: true, asked: true, onDone: vi.fn() },
        watchHint: { count: 0, shown: false },
      }));
    });

    await act(async () => {
      kbListener?.({ height: 336, phase: "did" });
    });
    const viewer = document.querySelector<HTMLElement>("[data-phone-takeover]")!;
    expect(viewer.style.paddingBottom).toBe("336px");
  });

  it("supports direct touch mode in ScreenTrackpad clicking where tapped and two-finger right-click", async () => {
    const sent: Array<[number, number, number]> = [];
    const input: RemoteInput = {
      size: () => ({ width: 1000, height: 500 }),
      pointer: (x, y, mask) => sent.push([Math.round(x), Math.round(y), mask]),
      key() {},
      text() {},
    };
    const screen = createRef<HTMLDivElement>();
    const keyboard = createRef<HTMLInputElement>();
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(PlatformContext.Provider, { value: makePlatform() },
        createElement("div", { "data-computer-fullscreen": "" },
          createElement("div", { className: "relative" },
            createElement("div", { ref: screen }, createElement("canvas")),
            createElement(ScreenTrackpad, { screen, input, keyboard, label: "screen", mode: "direct" }),
          ),
        ),
      ));
    });

    const pad = document.querySelector<HTMLElement>("[data-screen-trackpad]")!;
    const canvas = document.querySelector("canvas")!;
    pad.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 250, width: 500, height: 250, x: 0, y: 0, toJSON() {} });
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 250, width: 500, height: 250, x: 0, y: 0, toJSON() {} });

    await act(async () => {
      pad.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "touch", clientX: 250, clientY: 125, timeStamp: 10 } as PointerEventInit));
      pad.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "touch", clientX: 250, clientY: 125, timeStamp: 50 } as PointerEventInit));
    });
    expect(sent).toEqual([[500, 250, 0], [500, 250, 1], [500, 250, 0]]);

    // Taps outside the desktop frame (in the black margins) do not spuriously click the webpage edge in direct mode.
    sent.length = 0;
    await act(async () => {
      pad.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, pointerType: "touch", clientX: 250, clientY: 320, timeStamp: 100 } as PointerEventInit));
      pad.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2, pointerType: "touch", clientX: 250, clientY: 320, timeStamp: 140 } as PointerEventInit));
    });
    expect(sent).toEqual([]);
  });

  it("moves cursor relatively in trackpad mode, clicks at cursor, and recenters on recenterNonce", async () => {
    const sent: Array<[number, number, number]> = [];
    const input: RemoteInput = {
      size: () => ({ width: 1280, height: 800 }),
      pointer: (x, y, mask) => sent.push([Math.round(x), Math.round(y), mask]),
      key() {},
      text() {},
    };
    const screen = createRef<HTMLDivElement>();
    const keyboard = createRef<HTMLInputElement>();
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const renderTrackpad = (mode: "trackpad" | "direct", recenterNonce = 0) =>
      createElement(PlatformContext.Provider, { value: makePlatform() },
        createElement("div", { "data-computer-fullscreen": "" },
          createElement("div", { className: "relative" },
            createElement("div", { ref: screen }, createElement("canvas")),
            createElement(ScreenTrackpad, { screen, input, keyboard, label: "screen", mode, recenterNonce }),
          ),
        ),
      );
    await act(async () => { root!.render(renderTrackpad("trackpad", 0)); });

    const pad = document.querySelector<HTMLElement>("[data-screen-trackpad]")!;
    const canvas = document.querySelector("canvas")!;
    pad.getBoundingClientRect = () => ({ left: 0, top: 200, right: 400, bottom: 450, width: 400, height: 250, x: 0, y: 200, toJSON() {} });
    canvas.getBoundingClientRect = () => ({ left: 0, top: 200, right: 400, bottom: 450, width: 400, height: 250, x: 0, y: 200, toJSON() {} });

    // Drag in the black margin below the 16:10 frame (y=600) moves the cursor relatively from center (640, 400), then tap clicks there.
    await act(async () => {
      pad.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "touch", clientX: 100, clientY: 600, timeStamp: 10 } as PointerEventInit));
      pad.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, pointerType: "touch", clientX: 140, clientY: 620, timeStamp: 60 } as PointerEventInit));
      pad.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "touch", clientX: 140, clientY: 620, timeStamp: 80 } as PointerEventInit));
      pad.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, pointerType: "touch", clientX: 20, clientY: 700, timeStamp: 200 } as PointerEventInit));
      pad.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2, pointerType: "touch", clientX: 20, clientY: 700, timeStamp: 230 } as PointerEventInit));
    });
    const clickDown = sent.find(([, , mask]) => mask === 1);
    expect(clickDown).toBeDefined();
    expect(clickDown![0]).toBeGreaterThan(640);
    expect(clickDown![1]).toBeGreaterThan(400);

    // Recenter moves cursor back to center (640, 400).
    sent.length = 0;
    await act(async () => { root!.render(renderTrackpad("trackpad", 1)); });
    await act(async () => {
      pad.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 3, pointerType: "touch", clientX: 20, clientY: 700, timeStamp: 400 } as PointerEventInit));
      pad.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 3, pointerType: "touch", clientX: 20, clientY: 700, timeStamp: 430 } as PointerEventInit));
    });
    expect(sent.find(([, , mask]) => mask === 1)).toEqual([640, 400, 1]);
  });

  it("syncs floating buttons to native Liquid Glass, dispatches native taps and menu picks, hides for help sheet, and cleans up on unmount", async () => {
    const states: Array<TakeoverGlassState | null> = [];
    const listeners = new Set<(event: GlassEvent) => void>();
    const glass: GlassBridge = {
      update: vi.fn(),
      setText: vi.fn(),
      setAvatar: vi.fn(),
      focus: vi.fn(),
      blur: vi.fn(),
      clear: vi.fn(),
      slide: vi.fn(),
      takeover: (state) => { states.push(state); },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    };
    const origRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.hasAttribute("data-takeover-glass")) {
        return { left: 16, top: 60, right: 60, bottom: 104, width: 44, height: 44, x: 16, y: 60, toJSON() {} } as DOMRect;
      }
      return origRect.call(this);
    };

    const onExit = vi.fn();
    const onDone = vi.fn();
    const onKeyboard = vi.fn();
    const onToggleTrackpad = vi.fn();
    const onPasteFromPhone = vi.fn();

    try {
      const host = document.body.appendChild(document.createElement("div"));
      root = createRoot(host);
      await act(async () => {
        root!.render(createElement(PhoneTakeoverShell, {
          label: "Micro's browser",
          name: "Micro",
          platform: makePlatform({ glass }),
          landscape: false,
          onExit,
          frame: createElement("div"),
          control: { held: true, asked: true, onDone },
          watchHint: { count: 0, shown: false },
          onKeyboard,
          trackpadMode: false,
          onToggleTrackpad,
          onRecenterPointer: vi.fn(),
          onPasteFromPhone,
          onCopyToPhone: vi.fn(),
        }));
      });

      expect(document.documentElement.dataset.nativeGlassTakeover).toBe("");
      const latest = states.at(-1);
      expect(latest?.buttons.map((b) => b.id)).toEqual(["back", "help", "more", "clipboard", "control", "keyboard"]);
      expect(latest?.buttons.find((b) => b.id === "more")?.menu?.map((m) => m.key)).toEqual(["trackpad", "recenter"]);
      expect(latest?.buttons.find((b) => b.id === "clipboard")?.menu?.map((m) => m.key)).toEqual(["paste", "copy"]);
      expect(latest?.buttons.find((b) => b.id === "control")?.title).toBe("I'm done");

      const emit = (event: GlassEvent) => { for (const l of listeners) l(event); };
      await act(async () => {
        emit({ type: "takeoverTap", target: "control" });
        emit({ type: "takeoverTap", target: "keyboard" });
        emit({ type: "takeoverMenu", target: "more", key: "trackpad" });
        emit({ type: "takeoverMenu", target: "clipboard", key: "paste" });
        emit({ type: "takeoverTap", target: "help" });
      });

      expect(document.querySelector("[data-takeover-help-sheet]")).not.toBeNull();
      expect(states.at(-1)).toBeNull();
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(onKeyboard).toHaveBeenCalledTimes(1);
      expect(onToggleTrackpad).toHaveBeenCalledTimes(1);
      expect(onPasteFromPhone).toHaveBeenCalledTimes(1);

      await act(async () => { emit({ type: "takeoverTap", target: "back" }); });
      expect(onExit).toHaveBeenCalledTimes(1);

      await act(async () => { root!.unmount(); root = null; });
      expect(document.documentElement.dataset.nativeGlassTakeover).toBeUndefined();
      expect(states.at(-1)).toBeNull();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = origRect;
    }
  });
});
