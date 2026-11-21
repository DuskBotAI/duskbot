// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/locales/en.json";
import { loadLocale } from "@/lib/i18n";
import { SETTINGS_PANES } from "@/lib/open-settings";
import "@/testing/quiet-canceled-animations";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, api: fixture.api, useStore: () => ({ state: { ...original.initialState, bots: [], groups: [] }, dispatch: fixture.dispatch }) };
});

import { CommandPalette, openCommandPalette } from "./CommandPalette";
import { settingsCommands } from "./palette-commands";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.api.mockResolvedValue({ hits: [] });
});
afterEach(async () => {
  flushSync(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  await loadLocale("en");
});

function search(value: string): string[] {
  flushSync(() => root.render(createElement(CommandPalette)));
  flushSync(() => openCommandPalette());
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent ?? "");
}

describe("Command palette and Settings", () => {
  it.each([
    ["language", "Language"],
    ["vault", "Settings: Vault"],
    ["voice", "Settings: Voice"],
    ["invite", "People"],
    ["people", "People"],
    ["backup", "Backups"],
    ["skills", "Skills"],
    ["archive", "Archived bots"],
    ["phone", "Settings: Phone"],
    ["password", "Settings: Vault"],
  ])("finds %s", (query, name) => {
    expect(search(query).some((row) => row.startsWith(name))).toBe(true);
  });

  it("names every pane as the Settings rail does, with no Texting", () => {
    const rows = search("settings");
    for (const pane of SETTINGS_PANES.filter((entry) => entry.rail !== false)) {
      expect(rows.some((row) => row.startsWith(`Settings: ${en[pane.labelKey]}`)), pane.id).toBe(true);
    }
    expect(rows.some((row) => row.includes("Texting"))).toBe(false);
  });

  it("opens the setting it finds", () => {
    search("backup");
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "backups" });
  });

  it("gives every pane and setting synonyms in English", () => {
    for (const command of settingsCommands()) expect(command.also, command.id).toBeTruthy();
  });

  it("speaks the active language, placeholder included", async () => {
    await loadLocale("es");
    const rows = search("idioma");
    expect(rows.some((row) => row.startsWith("Idioma"))).toBe(true);
    expect(search("contraseñas").some((row) => row.startsWith("Ajustes: "))).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')!.placeholder).toBe("Buscar");
  });

  it("still finds a setting by its English name and words in another language", async () => {
    await loadLocale("es");
    expect(search("vault").some((row) => row.startsWith("Ajustes: "))).toBe(true);
    expect(search("language").some((row) => row.startsWith("Idioma"))).toBe(true);
    expect(search("settings").filter((row) => row.startsWith("Ajustes: ")).length).toBeGreaterThan(5);
  });
});
