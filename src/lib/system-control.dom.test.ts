// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSystemControls, installSystemControls, useSystemControl, type ControlPlace, type SystemControl, type SystemControls } from "./system-control";
import { SlidingPills } from "@/components/ui/SlidingPills";
import { phoneControlCover } from "@/mobile/control-cover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let places: ControlPlace[];
let placedControls: Array<{ id: string; control: SystemControl; place: ControlPlace }>;
let changeListeners: Set<(id: string, value: number | boolean | string) => void>;
let hitTarget: (x: number, y: number) => Element | null;

function SegmentedHarness({ overlay }: { overlay: "none" | "avatar" | "edge" | "scrim" }) {
  const ref = useRef<HTMLDivElement>(null);
  useSystemControl(ref, { kind: "segmented", items: ["Details", "Computer", "Advanced"], selected: 0 }, () => {});
  return createElement(
    "div",
    { className: "scroller", style: { overflowY: "auto" } },
    createElement("div", { className: "tabs" }, createElement("div", { ref, "data-segmented-room": "" })),
    overlay === "avatar" && createElement("div", { role: "dialog", "data-panel-avatar-editor": "" }, createElement("button", { type: "button" }, "cat")),
    overlay === "edge" && createElement("div", { role: "menu", className: "popover-surface" }, createElement("button", { type: "button" }, "copy")),
    overlay === "scrim" && createElement("div", { "data-panel-scrim": "" }),
  );
}

beforeEach(() => {
  places = [];
  placedControls = [];
  changeListeners = new Set();
  hitTarget = () => null;
  const bridge: SystemControls = {
    place: async (id, control, place) => {
      places.push(place);
      placedControls.push({ id, control, place });
      return true;
    },
    remove: () => {},
    onChange: (listener) => {
      changeListeners.add(listener);
      return () => { changeListeners.delete(listener); };
    },
  };
  installSystemControls(bridge, phoneControlCover);
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", 844);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-segmented-room")) return new DOMRect(16, 220, 358, 36);
    return new DOMRect(0, 0, 390, 844);
  });
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: (x: number, y: number) => hitTarget(x, y),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  installSystemControls(null, phoneControlCover);
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("system-control occlusion detection", () => {
  it("hides immediately when a same-scroller popover or scrim covers the control and restores on close", async () => {
    hitTarget = () => host.querySelector("[data-segmented-room]");
    act(() => root.render(createElement(SegmentedHarness, { overlay: "none" })));
    expect(places.at(-1)?.hidden).toBe(false);

    hitTarget = () => host.querySelector("[data-panel-avatar-editor] button");
    await act(async () => {
      root.render(createElement(SegmentedHarness, { overlay: "avatar" }));
      await Promise.resolve();
    });
    expect(places.at(-1)?.hidden).toBe(true);

    hitTarget = () => host.querySelector("[data-panel-scrim]");
    await act(async () => {
      root.render(createElement(SegmentedHarness, { overlay: "scrim" }));
      await Promise.resolve();
    });
    expect(places.at(-1)?.hidden).toBe(true);

    hitTarget = () => host.querySelector("[data-segmented-room]");
    await act(async () => {
      root.render(createElement(SegmentedHarness, { overlay: "none" }));
      await Promise.resolve();
    });
    expect(places.at(-1)?.hidden).toBe(false);
  });

  it("hides when a floating menu overlaps only one edge of a wide control", async () => {
    hitTarget = (x) => (x > 250 ? host.querySelector('[role="menu"] button') : host.querySelector("[data-segmented-room]"));
    await act(async () => {
      root.render(createElement(SegmentedHarness, { overlay: "edge" }));
      await Promise.resolve();
    });
    expect(places.at(-1)?.hidden).toBe(true);
  });

  it("mounts SlidingPills as a native segmented control and handles native selection changes", () => {
    const onPick = vi.fn();
    hitTarget = () => host.querySelector("[data-segmented-room]");
    act(() => {
      root.render(createElement(SlidingPills<"bot" | "all">, {
        label: "Use this model for",
        value: "bot",
        onPick,
        options: [
          { value: "bot", label: "This bot" },
          { value: "all", label: "All bots" },
        ],
      }));
    });
    expect(host.querySelector("[data-segmented-room]")).not.toBeNull();
    expect(host.querySelector("button")).toBeNull();
    const placed = placedControls.at(-1)!;
    expect(placed.control).toEqual({
      kind: "segmented",
      items: ["This bot", "All bots"],
      selected: 0,
      label: "Use this model for",
    });
    act(() => {
      for (const listener of changeListeners) listener(placed.id, 1);
    });
    expect(onPick).toHaveBeenCalledWith("all");

    act(() => {
      root.render(createElement(SlidingPills<"low" | "high">, {
        label: "Thinking",
        value: undefined,
        onPick,
        options: [
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ],
      }));
    });
    expect(placedControls.at(-1)?.control).toEqual({
      kind: "segmented",
      items: ["Low", "High"],
      selected: -1,
      label: "Thinking",
    });
  });

  it("keeps controls visible inside a deeper pushed page above a shallower pushed page", async () => {
    function SwitchInPage({ label }: { label: string }) {
      const ref = useRef<HTMLDivElement>(null);
      useSystemControl(ref, { kind: "switch", on: true, label }, () => {});
      return createElement("div", { ref, "data-segmented-room": "", "data-switch-label": label });
    }
    hitTarget = () => host.querySelector('[data-switch-label="Inner"]');
    await act(async () => {
      root.render(createElement(
        "div",
        null,
        createElement("div", { "data-phone-pushed-page": "outer", style: { position: "fixed", zIndex: 62 } }, createElement(SwitchInPage, { label: "Outer" })),
        createElement("div", { "data-phone-pushed-page": "inner", style: { position: "fixed", zIndex: 64 } }, createElement(SwitchInPage, { label: "Inner" })),
      ));
      await Promise.resolve();
    });
    const outerPlace = placedControls.find((entry) => entry.control.label === "Outer")?.place;
    const innerPlace = placedControls.find((entry) => entry.control.label === "Inner")?.place;
    expect(outerPlace?.hidden).toBe(true);
    expect(innerPlace?.hidden).toBe(false);
  });

  it("keeps controls visible inside an inert NavStack base once the leaving page slides past them", async () => {
    let pageLeft = 220;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-segmented-room")) return new DOMRect(16, 220, 358, 36);
      if (this.classList.contains("mobile-page")) return new DOMRect(pageLeft, 0, 390, 844);
      return new DOMRect(0, 0, 390, 844);
    });
    function NavBaseControl() {
      const ref = useRef<HTMLDivElement>(null);
      useSystemControl(ref, { kind: "segmented", items: ["System", "Light", "Dark"], selected: 0, label: "Appearance" }, () => {});
      return createElement("div", { className: "mobile-nav" },
        createElement("div", { inert: true },
          createElement("div", { className: "scroller", style: { overflowY: "auto" } },
            createElement("div", { ref, "data-segmented-room": "" }),
          ),
        ),
        createElement("div", { className: "mobile-page", "data-leaving": "" }, "Language"),
      );
    }
    // WebKit skips inert subtrees in elementFromPoint, returning document.body once the sliding page uncovers the control
    hitTarget = () => document.body;
    await act(async () => {
      root.render(createElement(NavBaseControl));
      await Promise.resolve();
    });
    expect(places.at(-1)?.hidden).toBe(false);
    expect(places.at(-1)?.maskRight).toBe(220);

    // While the foreign mobile-page still covers the probe point, the control stays hidden
    pageLeft = 0;
    hitTarget = () => host.querySelector(".mobile-page");
    await act(async () => {
      await flushSystemControls();
    });
    expect(places.at(-1)?.hidden).toBe(true);
  });

  it("keeps BotRoutines switches visible when the sibling open button catches hit testing", () => {
    function RoutineRowSwitch() {
      const ref = useRef<HTMLButtonElement>(null);
      useSystemControl(ref, { kind: "switch", on: true, label: "Morning digest" }, () => {});
      return createElement("div", { "data-panel-routine": "r1" },
        createElement("button", { type: "button", className: "routine-open" }, "Morning digest"),
        createElement("button", { ref, type: "button", role: "switch", "data-segmented-room": "" }),
      );
    }
    hitTarget = () => host.querySelector(".routine-open");
    act(() => root.render(createElement(RoutineRowSwitch)));
    expect(places.at(-1)?.hidden).toBe(false);
  });

  it("flushSystemControls waits for async native place promises before resolving", async () => {
    let resolvePlace!: (tracked: boolean) => void;
    let settled = false;
    installSystemControls({
      place: () => new Promise<boolean>((resolve) => { resolvePlace = resolve; }),
      remove: () => {},
      onChange: () => () => {},
    }, phoneControlCover);
    hitTarget = () => host.querySelector("[data-segmented-room]");
    act(() => root.render(createElement(SegmentedHarness, { overlay: "none" })));
    const flushed = flushSystemControls(500).then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    resolvePlace(true);
    await flushed;
    expect(settled).toBe(true);
  });
});
