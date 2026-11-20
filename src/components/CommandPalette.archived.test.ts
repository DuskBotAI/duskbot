// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import "@/testing/quiet-canceled-animations";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    api: fixture.api,
    useStore: () => ({ state: { ...original.initialState, bots: [shown, hidden], groups: [] }, dispatch: fixture.dispatch }),
  };
});

import { CommandPalette, openCommandPalette } from "./CommandPalette";

const base = { title: "", description: "", color: "blue", notifications: false, unread: false, busy: false, messages: [], section: "", modelSelection: { instanceId: "claude", model: "fake" } };
const shown = { ...base, id: "nova", threadId: "nova-thread", name: "Nova" } as Bot;
const hidden = { ...base, id: "basil", threadId: "basil-thread", name: "Basil", hidden: true } as Bot;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.api.mockImplementation(async (path: string) => (path.startsWith("/api/bots/") ? { bot: { ...hidden, hidden: false } } : { hits: [] }));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

function search(value: string) {
  flushSync(() => root.render(createElement(CommandPalette)));
  flushSync(() => openCommandPalette());
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

describe("Command palette and archived bots", () => {
  it("finds a hidden bot by name and brings it back with one pick", async () => {
    const input = search("bas");
    const row = [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent?.includes("Basil"));
    expect(row?.textContent).toContain("Archived. Pick it to bring it back.");
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "botPatched", bot: { ...hidden, hidden: false } }));
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/basil", { method: "PATCH", body: JSON.stringify({ hidden: false }) });
  });

  it("lists no hidden bots before anything is typed", () => {
    flushSync(() => root.render(createElement(CommandPalette)));
    flushSync(() => openCommandPalette());
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Basil");
  });
});
