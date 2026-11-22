// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileConnectionRecord } from "../../../shared/mobile-link";
import { installSystemDialogs, type SystemDialogs } from "@/lib/system-dialog";
import { installSystemMenu } from "@/lib/system-menu";
import { PlatformContext, webPlatform, type MobilePlatform } from "../platform";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const accountState = vi.hoisted(() => ({
  current: null as null | {
    account: { id: string; email: string };
    accounts: { id: string; email: string }[];
    origin: string;
    offered: boolean;
    signIns: number;
    places: ReturnType<typeof vi.fn>;
    renameComputer: ReturnType<typeof vi.fn>;
    removeComputer: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("@/state/store", () => ({
  useStore: () => ({
    state: { connected: true, notifications: [], bots: [], config: { profile: { name: "Karol" } } },
    dispatch: vi.fn(),
  }),
}));

vi.mock("../account/AccountGate", () => ({
  useMobileAccount: () => accountState.current,
}));

vi.mock("../consent/AiConsent", () => ({
  useAiConsent: () => null,
}));

import { SettingsSheet } from "./SettingsSheet";

const record = (id: string, label: string, extra: Partial<MobileConnectionRecord> = {}): MobileConnectionRecord => ({
  id, environmentId: `env-${id}`, label, transport: "https", origin: `https://${id}.example.test`,
  sessionRef: `token.${id}`, deviceId: `dev-${id}`,
  capabilities: {} as MobileConnectionRecord["capabilities"], addedAt: 1, lastUsedAt: 1, ...extra,
});

let host: HTMLDivElement;
let root: Root;
let prefs: Map<string, string>;
let secrets: Map<string, string>;
let platform: MobilePlatform;
let fetchSpy: ReturnType<typeof vi.spyOn>;

function makePlatform(records: MobileConnectionRecord[], activeId: string) {
  prefs = new Map([
    ["dusk.mobile.connections.v1", JSON.stringify(records)],
    ["dusk.mobile.active.v1", activeId],
  ]);
  secrets = new Map(records.map((entry) => [entry.sessionRef, `secret-${entry.id}`]));
  platform = {
    ...webPlatform(),
    native: false,
    kind: "web",
    prefs: {
      get: async (key) => prefs.get(key) ?? null,
      set: async (key, value) => { prefs.set(key, value); },
      remove: async (key) => { prefs.delete(key); },
    },
    secrets: {
      get: async (key) => secrets.get(key) ?? null,
      set: async (key, value) => { secrets.set(key, value); },
      remove: async (key) => { secrets.delete(key); },
    },
  };
}

async function mountSettings() {
  await act(async () => {
    root.render(
      createElement(
        PlatformContext,
        { value: platform },
        createElement(
          "div",
          { className: "dusk-mobile" },
          createElement(SettingsSheet, {
            sheet: { kind: "settings" },
            open: true,
            onClose: vi.fn(),
            onOpenSheet: vi.fn(),
            onOpenChat: vi.fn(),
          }),
        ),
      ),
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  accountState.current = null;
  installSystemMenu(null);
  installSystemDialogs(null);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
});

afterEach(() => {
  fetchSpy.mockRestore();
  installSystemMenu(null);
  installSystemDialogs(null);
  act(() => root.unmount());
  host.remove();
});

describe("Settings Computers row 3-dots menu", () => {
  it("opens the popover menu, renames a linked + account-synced computer, and syncs both locally and to the account", async () => {
    const mac = record("mac", "MacBook-Pro-Karol-3.local");
    makePlatform([mac], "mac");
    const renameComputer = vi.fn(async () => ({ outcome: "ok" as const }));
    const removeComputer = vi.fn(async () => ({ outcome: "ok" as const }));
    accountState.current = {
      account: { id: "acct-rename", email: "karol@example.test" },
      accounts: [{ id: "acct-rename", email: "karol@example.test" }],
      origin: "https://dusk.bot",
      offered: true,
      signIns: 1,
      places: vi.fn(async () => ({
        clouds: [],
        teams: [],
        computers: [{ id: "ws_mac", name: "MacBook-Pro-Karol-3.local", kind: "mac", presence: "online", environmentId: "env-mac" }],
      })),
      renameComputer,
      removeComputer,
    };

    await mountSettings();
    expect(host.querySelector("[data-testid='mobile-place']")?.textContent).toContain("MacBook-Pro-Karol-3.local");

    const trigger = host.querySelector<HTMLButtonElement>("[data-place-menu]")!;
    expect(trigger).not.toBeNull();
    expect(trigger.getAttribute("aria-label")).toBe("More options for MacBook-Pro-Karol-3.local");

    await act(async () => { trigger.click(); });
    const renameItem = document.querySelector<HTMLButtonElement>("[data-place-menu-item='rename']")!;
    expect(renameItem).not.toBeNull();
    expect(renameItem.textContent).toContain("Rename");
    expect(document.querySelector<HTMLButtonElement>("[data-place-menu-item='remove']")?.textContent).toContain("Remove connection");

    await act(async () => { renameItem.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    const input = host.querySelector<HTMLInputElement>("[data-rename-place-input]")!;
    expect(input).not.toBeNull();
    expect(input.value).toBe("MacBook-Pro-Karol-3.local");

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Karol's MacBook");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = host.querySelector<HTMLButtonElement>("[data-rename-place-save]")!;
    await act(async () => { save.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    expect(renameComputer).toHaveBeenCalledWith({ id: "ws_mac" }, "Karol's MacBook", undefined);
    const saved = JSON.parse(prefs.get("dusk.mobile.connections.v1")!) as MobileConnectionRecord[];
    expect(saved[0]!.label).toBe("Karol's MacBook");
    expect(host.querySelector("[data-testid='mobile-place']")?.textContent).toContain("Karol's MacBook");
  });

  it("removes an inactive linked computer through the 3-dots menu without reloading the page", async () => {
    const mac = record("mac", "Studio Mac");
    const oldBox = record("old", "Old Linux Box");
    makePlatform([mac, oldBox], "mac");
    await mountSettings();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-place-menu]")];
    expect(buttons).toHaveLength(2);

    await act(async () => { buttons[1]!.click(); });
    const removeItem = document.querySelector<HTMLButtonElement>("[data-place-menu-item='remove']")!;
    await act(async () => { removeItem.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    expect(host.textContent).toContain("Remove Old Linux Box from this phone?");
    const confirm = host.querySelector<HTMLButtonElement>("[data-confirm-action]")!;
    await act(async () => { confirm.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    const saved = JSON.parse(prefs.get("dusk.mobile.connections.v1")!) as MobileConnectionRecord[];
    expect(saved.map((one) => one.id)).toEqual(["mac"]);
    expect([...host.querySelectorAll("[data-testid='mobile-place']")].map((el) => el.textContent)).toEqual(["Studio MacOnline"]);
  });

  it("clears the name input, disables Save when blank, and surfaces rename/remove errors on account-only computers", async () => {
    const mac = record("mac", "Studio Mac");
    makePlatform([mac], "mac");
    accountState.current = {
      account: { id: "acct-err", email: "karol@example.test" },
      accounts: [{ id: "acct-err", email: "karol@example.test" }],
      origin: "https://dusk.bot",
      offered: true,
      signIns: 1,
      places: vi.fn(async () => ({
        clouds: [],
        teams: [],
        computers: [{ id: "ws_srv", name: "Office Server", kind: "vps", presence: "offline", environmentId: "env-srv" }],
      })),
      renameComputer: vi.fn(async () => ({ outcome: "failed" as const })),
      removeComputer: vi.fn(async () => ({ outcome: "failed" as const })),
    };

    await mountSettings();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-place-menu]")];
    await act(async () => { buttons[1]!.click(); });
    expect(buttons[1]!.getAttribute("aria-expanded")).toBe("true");
    // Escape closes the fallback popover menu
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(buttons[1]!.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(document.querySelector("[data-place-menu-popover]")).toBeNull();

    // Open Rename, clear input, verify Save disabled, type new name, submit and see error
    await act(async () => { buttons[1]!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>("[data-place-menu-item='rename']")!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    await act(async () => { host.querySelector<HTMLButtonElement>("button[aria-label='Clear name']")!.click(); });
    const input = host.querySelector<HTMLInputElement>("[data-rename-place-input]")!;
    const save = host.querySelector<HTMLButtonElement>("[data-rename-place-save]")!;
    expect(input.value).toBe("");
    expect(save.disabled).toBe(true);

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Backup Server");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { save.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Couldn't rename Office Server");
    expect(save.disabled).toBe(false);

    // Go back and verify Remove error shows inline
    await act(async () => { host.querySelector<HTMLButtonElement>("button[aria-label='Back']")!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("[data-place-menu]")][1]!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>("[data-place-menu-item='remove']")!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-confirm-action]")!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Couldn't remove Office Server");
  });

  it("uses the native systemMenu when installed on iOS and removes an account-only computer", async () => {
    const mac = record("mac", "Studio Mac");
    makePlatform([mac], "mac");
    const removeComputer = vi.fn(async () => ({ outcome: "ok" as const }));
    accountState.current = {
      account: { id: "acct-native", email: "karol@example.test" },
      accounts: [{ id: "acct-native", email: "karol@example.test" }],
      origin: "https://dusk.bot",
      offered: true,
      signIns: 1,
      places: vi.fn(async () => ({
        clouds: [{ id: "c1", name: "My Cloud", status: "ready", origin: "https://c1.dusk.bot", primary: true, asleep: false }],
        teams: [],
        computers: [{ id: "ws_old", name: "Old Server", kind: "vps", presence: "offline", environmentId: "env-old" }],
      })),
      renameComputer: vi.fn(async () => ({ outcome: "ok" as const })),
      removeComputer,
    };
    const presenter = vi.fn(async () => "remove");
    installSystemMenu(presenter);

    await mountSettings();
    // Unlinked cloud gets no 3-dots menu; linked Mac and unlinked Old Server each get one
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-place-menu]")];
    expect(buttons.map((el) => el.getAttribute("aria-label"))).toEqual([
      "More options for Studio Mac",
      "More options for Old Server",
    ]);

    await act(async () => { buttons[1]!.click(); });
    expect(presenter).toHaveBeenCalledWith(expect.anything(), [
      { key: "rename", label: "Rename", symbol: "pencil" },
      { key: "remove", label: "Remove connection", symbol: "trash", danger: true, separated: true },
    ]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    expect(host.textContent).toContain("Remove Old Server?");
    const confirm = host.querySelector<HTMLButtonElement>("[data-confirm-action]")!;
    await act(async () => { confirm.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    expect(removeComputer).toHaveBeenCalledWith(expect.objectContaining({ id: "ws_old" }), undefined);
    expect([...host.querySelectorAll("[data-testid='mobile-place']")].map((el) => el.textContent)).not.toContain("Old ServerNot connected");
  });

  it("uses native SwiftUI form and UIAlertController for rename and remove when systemDialogs is installed", async () => {
    const mac = record("mac", "Studio Mac");
    const oldBox = record("old", "Old Box");
    makePlatform([mac, oldBox], "mac");
    const alert = vi.fn<SystemDialogs["alert"]>(async () => "confirm");
    const form = vi.fn<SystemDialogs["form"]>(async (options) => {
      const error = await options.onSubmit?.({ name: "Renamed Mac" });
      expect(error).toBeNull();
      return { saved: true, values: { name: "Renamed Mac" } };
    });
    installSystemDialogs({ alert, form });
    let choice = "rename";
    installSystemMenu(vi.fn(async () => choice));

    await mountSettings();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-place-menu]")];
    await act(async () => { buttons[0]!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    expect(form).toHaveBeenCalledWith(expect.objectContaining({
      title: "Rename",
      fields: [expect.objectContaining({ id: "name", value: "Studio Mac", required: true })],
    }));
    expect(host.querySelector("[data-rename-place-input]")).toBeNull();
    expect(host.querySelector("[data-testid='mobile-place']")?.textContent).toContain("Renamed Mac");

    choice = "remove";
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("[data-place-menu]")][1]!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    expect(alert).toHaveBeenCalledWith(expect.objectContaining({
      title: "Remove Old Box from this phone?",
      tone: "danger",
    }));
    expect(host.querySelector("[data-confirm-action]")).toBeNull();
    const saved = JSON.parse(prefs.get("dusk.mobile.connections.v1")!) as MobileConnectionRecord[];
    expect(saved.map((one) => one.id)).toEqual(["mac"]);
  });
});
