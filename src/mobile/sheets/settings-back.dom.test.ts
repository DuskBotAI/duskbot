// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import { PlatformContext, webPlatform } from "../platform";
import { closeTopSheet } from "../Sheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/state/store", () => ({
  useStore: () => ({
    state: { connected: true, notifications: [], bots: [], config: { profile: { name: "Karol" } } },
    dispatch: vi.fn(),
  }),
}));

vi.mock("../account/AccountGate", () => ({
  useMobileAccount: () => null,
}));

vi.mock("../consent/AiConsent", () => ({
  useAiConsent: () => null,
}));

import { SettingsSheet } from "./SettingsSheet";

let host: HTMLDivElement;
let root: Root;
let fetchSpy: ReturnType<typeof vi.spyOn>;

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const pageTitled = (title: string) => document.querySelector(`section[aria-label="${title}"]`);

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
});

afterEach(() => {
  fetchSpy.mockRestore();
  act(() => root.unmount());
  host.remove();
});

describe("Android's back in Settings", () => {
  it("steps back from a page to the list, and only then closes Settings", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(createElement(PlatformContext, { value: { ...webPlatform(), native: false, kind: "web" } },
        createElement("div", { className: "dusk-mobile" },
          createElement(SettingsSheet, { sheet: { kind: "settings" }, open: true, onClose, onOpenSheet: vi.fn(), onOpenChat: vi.fn() }))));
    });
    await settle();

    const row = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes(t("mobile.settings.language")));
    await act(async () => { row!.click(); });
    await settle();
    expect(pageTitled(t("mobile.settings.language"))).not.toBeNull();

    await act(async () => { expect(closeTopSheet()).toBe(true); });
    await settle();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => { expect(closeTopSheet()).toBe(true); });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
