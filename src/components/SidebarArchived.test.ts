// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { BotEditorStore, initialState, reducer, type Action, type AppState, type Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ density: "comfortable" as SidebarDensity }));
vi.mock("@/lib/sidebar-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sidebar-preferences")>(),
  useSidebarDensity: () => fixture.density,
}));

import { Sidebar } from "./Sidebar";
import { ARCHIVED_OPEN_KEY, SidebarArchivedSection } from "./SidebarArchived";

const bot = (id: string, name: string, hidden: boolean): Bot => ({ id, threadId: `${id}-thread`, name, title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], hidden, modelSelection: { instanceId: "fake", model: "test" } });
const bots: Bot[] = [bot("kept", "Kept", false), bot("old", "Oldie", true), bot("gone", "Gone", true), { ...bot("moved", "Moved", true), movedTo: { team: { id: "team", name: "Team" }, state: "moved" as const, at: 1 } }];

let root: Root, container: HTMLDivElement, state: AppState;
const dispatch = (action: Action) => { state = reducer(state, action); draw(); };
const store = (children: ReturnType<typeof createElement>) => createElement(BotEditorStore, {
  value: { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
  children,
});
const draw = () => flushSync(() => root.render(store(createElement(SidebarArchivedSection, { bots: state.bots }))));
const header = () => document.querySelector<HTMLButtonElement>('[data-section="Archived"] button')!;

beforeEach(() => {
  setLocale("en");
  fixture.density = "comfortable";
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value), removeItem: (key: string) => void saved.delete(key) });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  state = { ...initialState, bots: structuredClone(bots) };
});
afterEach(() => { flushSync(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); setLocale("en"); });

describe("the sidebar's Archived section", () => {
  it("starts folded with the count of archived bots, a moved bot not among them, and opens to rows that open the chat", () => {
    draw();
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expect(header().textContent).toContain("2");
    expect(document.querySelector("[data-sidebar-archived-row]")).toBeNull();
    flushSync(() => header().click());
    expect(localStorage.getItem(ARCHIVED_OPEN_KEY)).toBe("1");
    const rows = [...document.querySelectorAll<HTMLElement>('[data-sidebar-archived-row] [role="button"]')];
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["Oldie, archived", "Gone, archived"]);
    flushSync(() => rows[0]!.click());
    expect(state.selectedId).toBe("old");
  });

  it("unarchives from the row's button and from its right-click menu", async () => {
    localStorage.setItem(ARCHIVED_OPEN_KEY, "1");
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const id = String(url).split("/").pop()!;
      expect(JSON.parse(String(init?.body))).toEqual({ hidden: false });
      return new Response(JSON.stringify({ bot: { ...state.bots.find((entry) => entry.id === id), hidden: false } }), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    draw();
    flushSync(() => document.querySelector<HTMLButtonElement>('[aria-label="Unarchive Oldie"]')!.click());
    await expect.poll(() => state.bots.find((entry) => entry.id === "old")!.hidden).toBe(false);
    expect(String(fetch.mock.calls[0]![0])).toContain("/api/bots/old");
    const row = document.querySelector('[data-sidebar-archived-row="gone"] [role="button"]')!;
    flushSync(() => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })));
    const item = document.querySelector<HTMLButtonElement>("[data-sidebar-unarchive-item]")!;
    expect(item.textContent).toContain("Unarchive");
    flushSync(() => item.click());
    await expect.poll(() => state.bots.find((entry) => entry.id === "gone")!.hidden).toBe(false);
  });

  it("is not drawn without archived bots, nor in the column of avatars", () => {
    state = { ...state, bots: [bot("kept", "Kept", false)] };
    draw();
    expect(header()).toBeNull();
    state = { ...state, bots: structuredClone(bots) };
    const sidebar = (density: SidebarDensity) => {
      fixture.density = density;
      return renderToStaticMarkup(store(createElement(Sidebar, { open: true, onClose: () => {} })));
    };
    expect(sidebar("comfortable")).toContain('data-section="Archived"');
    expect(sidebar("icons")).not.toContain('data-section="Archived"');
  });
});
