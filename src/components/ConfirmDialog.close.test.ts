// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askConfirm, ConfirmDialog } from "./ConfirmDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let closed: number;

function render(open: boolean) {
  act(() => root.render(createElement(ConfirmDialog, {
    open, title: "Delete Nova?", body: "This removes it.", confirmLabel: "Delete", onCancel: () => {}, onConfirm: () => {}, onClosed: () => { closed += 1; },
  })));
}
const dialog = () => document.querySelector<HTMLElement>("[role=alertdialog]");
const layer = () => dialog()?.parentElement ?? null;
const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 400)); });

beforeEach(() => {
  closed = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("closing a confirm", () => {
  it("stays drawn and inert while it plays its way out, then goes", async () => {
    render(true);
    await settle();
    render(false);
    expect(dialog(), "still drawn on its way out").not.toBeNull();
    expect(layer()!.hasAttribute("inert")).toBe(true);
    await settle();
    expect(dialog()).toBeNull();
    expect(closed).toBe(1);
  });

  it("comes back when opened again while it leaves", async () => {
    render(true);
    await settle();
    render(false);
    render(true);
    await settle();
    expect(dialog()).not.toBeNull();
    expect(layer()!.hasAttribute("inert")).toBe(false);
    expect(closed).toBe(0);
  });

  it("answers at once from askConfirm and removes its root once it has left", async () => {
    let answer: Promise<boolean> | null = null;
    act(() => { answer = askConfirm({ title: "Sign out?", body: "", confirmLabel: "Sign out" }); });
    await settle();
    act(() => (document.querySelector("[role=alertdialog] button:last-child") as HTMLButtonElement).click());
    await expect(answer!).resolves.toBe(true);
    expect(dialog(), "still leaving").not.toBeNull();
    await settle();
    expect(dialog()).toBeNull();
    expect([...document.body.children], "only this test's own host is left").toEqual([host]);
  });
});
