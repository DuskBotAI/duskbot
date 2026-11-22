// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/state/store", async (original) => {
  const store = await original<typeof import("@/state/store")>();
  return { ...store, useStore: () => ({ state: { ...store.initialState, config: { ...store.initialState.config, features: {} } }, dispatch: vi.fn() }) };
});
vi.mock("../../bot-settings/BotEditorContext", () => ({ useBotEditor: () => ({ request: fixture.request }) }));
vi.mock("../../bot-settings/OrgSkillsCard", () => ({ OrgSkillsCard: () => null }));

const { SkillsModal } = await import("./SkillsModal");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pepper = { id: "pepper", name: "Pepper" } as Bot;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
let root: Root;
let host: HTMLElement;
const text = () => host.textContent ?? "";
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === name);

beforeEach(() => {
  fixture.request.mockReset();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("a bot's skills that did not load", () => {
  it("says they could not be loaded, never No skills yet, and Try again loads them", async () => {
    fixture.request.mockRejectedValue(new Error("Injected failure"));
    await act(async () => { root.render(createElement(SkillsModal, { bot: pepper, onClose: () => {} })); });
    await flush();
    expect(text()).not.toContain("No skills yet");
    expect(host.querySelector('[data-sheet-row="installed"]')?.textContent).toContain("Couldn't load");
    expect(text()).toContain("Couldn't load this bot's skills.");

    fixture.request.mockResolvedValue({ skills: [{ name: "invoice-chaser", description: "Chase unpaid invoices", source: "local", enabled: true, warnings: [] }] });
    await act(async () => { button("Try again")!.click(); });
    await flush();
    expect(text()).not.toContain("Couldn't load");
    expect(host.querySelector('[data-sheet-row="installed"]')?.textContent).toContain("1 on");
  });

  it("still says No skills yet when the list loaded empty", async () => {
    fixture.request.mockResolvedValue({ skills: [] });
    await act(async () => { root.render(createElement(SkillsModal, { bot: pepper, onClose: () => {} })); });
    await flush();
    expect(host.querySelector('[data-sheet-row="installed"]')?.textContent).toContain("No skills yet");
    expect(text()).not.toContain("Couldn't load");
  });
});
