// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfirmDialog, type ConfirmTone } from "./ConfirmDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

function render(tone: ConfirmTone | undefined, pending = false) {
  act(() => root.render(createElement(ConfirmDialog, {
    open: true, title: "Delete Nova?", body: "This can't be undone.", confirmLabel: "Delete", tone, pending, onCancel: () => {}, onConfirm: () => {},
  })));
}
const focused = () => document.activeElement?.textContent;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("a confirm's first focus", () => {
  it("lands on Cancel for a danger confirm, so Enter cannot delete", () => {
    render("danger");
    expect(focused()).toBe("Cancel");
  });

  it("treats a confirm without a tone as danger", () => {
    render(undefined);
    expect(focused()).toBe("Cancel");
  });

  it("lands on the confirm button for a neutral confirm", () => {
    render("neutral");
    expect(focused()).toBe("Delete");
  });

  it("goes back to Cancel when a danger confirm stops pending", () => {
    render("danger", true);
    expect(document.activeElement?.getAttribute("role")).toBe("alertdialog");
    render("danger", false);
    expect(focused()).toBe("Cancel");
  });
});
