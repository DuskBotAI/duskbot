// @vitest-environment happy-dom
import { createElement, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLongPress, type NativePress } from "./ContextMenu";

let root: Root | null = null;
afterEach(() => { if (root) flushSync(() => root!.unmount()); root = null; document.body.innerHTML = ""; });

function mountRow(native: NativePress, onOpen: () => void) {
  function Row() {
    const ref = useRef<HTMLButtonElement>(null);
    useLongPress(ref, () => {}, true, native);
    return createElement("button", { ref, type: "button", onClick: onOpen }, "Nova");
  }
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  flushSync(() => root!.render(createElement(Row)));
  return host.querySelector("button")!;
}

const touch = (el: Element, type: string) => {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { touches: Array<{ clientX: number; clientY: number }> };
  event.touches = type === "touchend" || type === "touchcancel" ? [] : [{ clientX: 10, clientY: 10 }];
  el.dispatchEvent(event);
};

describe("a hold handed to the system menu", () => {
  it("does not also open the chat with the tap that ends it", () => {
    let opened: (() => void) | null = null;
    const native: NativePress = { press: (_el, done) => { opened = done; }, cancel: vi.fn() };
    const open = vi.fn();
    const row = mountRow(native, open);
    touch(row, "touchstart");
    opened!();
    touch(row, "touchcancel");
    row.click();
    expect(open).not.toHaveBeenCalled();
  });

  it("still opens the chat on a plain tap when no menu showed", () => {
    const native: NativePress = { press: () => {}, cancel: vi.fn() };
    const open = vi.fn();
    const row = mountRow(native, open);
    touch(row, "touchstart");
    touch(row, "touchend");
    row.click();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
