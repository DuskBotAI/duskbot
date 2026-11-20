// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), pending: false }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, botCreationPending: fixture.pending }, dispatch: fixture.dispatch }) };
});
vi.mock("./Avatar", () => ({ MausAvatar: () => null }));

import { CreateBotDialog, openCreateBot } from "./CreateBotDialog";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(CreateBotDialog)));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  fixture.pending = false;
});

/** the open dialog: one on its way out (inert, still drawn) is closed */
const dialog = () => [...document.querySelectorAll<HTMLElement>("[data-create-bot-dialog]")].find((el) => !el.closest("[data-leaving]")) ?? null;
const button = (name: string) => [...dialog()!.querySelectorAll("button")].find((b) => b.textContent === name || b.getAttribute("aria-label") === name)!;
function type(value: string) {
  const input = dialog()!.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

it("is Create New Bot: a name, the twenty pixel bodies, the colours, and Create only once named", () => {
  flushSync(() => openCreateBot("GOATS"));
  expect(dialog()!.querySelector("h2")!.textContent).toBe("Create new bot");
  expect(dialog()!.querySelector("input")!.placeholder).toBe("Name your bot");
  expect(dialog()!.querySelectorAll('button[aria-label$="character shape"]')).toHaveLength(20);
  expect(dialog()!.querySelectorAll('button[aria-label$="character shape"][aria-pressed="true"]')).toHaveLength(1);
  expect(dialog()!.querySelectorAll('button[aria-label$="character color"][aria-pressed="true"]')).toHaveLength(1);
  expect(button("Create").disabled).toBe(true);
  type("   ");
  expect(button("Create").disabled, "a blank name is no name").toBe(true);
  type("Rex");
  flushSync(() => button("Hearty character shape").click());
  flushSync(() => button("Blue character color").click());
  flushSync(() => button("Create").click());
  expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "newBot", section: "GOATS", look: { name: "Rex", color: "blue", mascotBody: "hearty" } }));
  expect(dialog(), "it stays until the bot exists").not.toBeNull();
  expect(button("Creating…").disabled).toBe(true);
  flushSync(() => fixture.dispatch.mock.calls[0]![0].onCreated({ id: "rex" }));
  expect(dialog(), "it closes once the bot is made").toBeNull();
});

it("keeps the name, shape and colour and says why when the bot could not be made", () => {
  flushSync(() => openCreateBot());
  type("Rex");
  flushSync(() => button("Hearty character shape").click());
  flushSync(() => button("Create").click());
  flushSync(() => fixture.dispatch.mock.calls[0]![0].onError("couldn't make a new bot: offline"));
  expect(dialog()).not.toBeNull();
  expect(dialog()!.querySelector("[data-create-bot-error]")!.textContent).toBe("couldn't make a new bot: offline");
  expect(dialog()!.querySelector("input")!.value).toBe("Rex");
  expect(button("Hearty character shape").getAttribute("aria-pressed")).toBe("true");
  expect(button("Create").disabled, "it can be tried again").toBe(false);
});

it("closes on Cancel, the close button and Escape without making anything", () => {
  for (const close of [() => button("Cancel").click(), () => button("Close").click(),
    () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))]) {
    flushSync(() => openCreateBot());
    expect(dialog()).not.toBeNull();
    flushSync(close);
    expect(dialog()).toBeNull();
  }
  expect(fixture.dispatch).not.toHaveBeenCalled();
});

it("waits while another bot is still being made", () => {
  fixture.pending = true;
  flushSync(() => root.render(createElement(CreateBotDialog)));
  flushSync(() => openCreateBot());
  type("Rex");
  expect(button("Create").disabled).toBe(true);
});
