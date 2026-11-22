// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDialogKeys } from "./GrokDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let opener: HTMLButtonElement;

function Sheet({ field }: { field: "autoFocus" | "data-autofocus" | "none" }) {
  const sheet = useRef<HTMLDivElement>(null);
  useDialogKeys(sheet, () => {});
  return createElement("div", { ref: sheet, role: "dialog", tabIndex: -1 },
    createElement("button", { type: "button" }, "Close"),
    createElement("input", { "aria-label": "Email", autoFocus: field === "autoFocus", "data-autofocus": field === "data-autofocus" ? "" : undefined }));
}

function render(field: "autoFocus" | "data-autofocus" | "none" | null) {
  act(() => root.render(field ? createElement(Sheet, { field }) : null));
}

beforeEach(() => {
  opener = document.createElement("button");
  opener.textContent = "Invite someone";
  document.body.append(opener);
  opener.focus();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("a dialog's first focus", () => {
  it("keeps a field that took focus with autoFocus", () => {
    render("autoFocus");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Email");
  });

  it("moves to a data-autofocus field", () => {
    render("data-autofocus");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Email");
  });

  it("moves to the dialog itself when nothing asks for focus", () => {
    render("none");
    expect(document.activeElement?.getAttribute("role")).toBe("dialog");
  });

  it("returns focus to the opener on close, even after a field took it with autoFocus", () => {
    render("autoFocus");
    render(null);
    expect(document.activeElement).toBe(opener);
  });
});
