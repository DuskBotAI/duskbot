// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSystemControls, useSystemControl, type ControlPlace, type SystemControl, type SystemControls } from "./system-control";
import { SlidingPills } from "@/components/ui/SlidingPills";

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
  installSystemControls(bridge);
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
  installSystemControls(null);
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
});
