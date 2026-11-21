// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { CloudScreenPreview } from "./CloudScreenPreview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const props = {
  src: "data:image/png;base64,bm90IGFuIGltYWdl", name: "Test bot", error: null, starting: false, opening: false,
  disabled: false, onOpen: vi.fn(), onRetry: vi.fn(),
};

/** A cached picture that can't be decoded fails as soon as it is in the page, before the preview's effects run. */
function FailsOnMount() {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { box.current!.querySelector("img")!.dispatchEvent(new Event("error")); }, []);
  return createElement("div", { ref: box }, createElement(CloudScreenPreview, props));
}

describe("a preview mounted on a picture that can't be shown", () => {
  it("shows the image error with Retry instead of connecting forever", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(FailsOnMount)));
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Retry preview");
    expect(host.querySelector("[role=status]")).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});
