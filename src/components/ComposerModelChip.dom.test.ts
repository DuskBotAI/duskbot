// @vitest-environment happy-dom
import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  instances: [] as InstanceInfo[],
  bots: [] as Bot[],
  dispatch: vi.fn(),
  refreshModels: vi.fn(() => Promise.resolve()),
  refreshInstances: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({
    state: { instances: fixture.instances, bots: fixture.bots, modelVariantSessions: {}, config: {} },
    dispatch: fixture.dispatch,
    refreshInstances: fixture.refreshInstances,
    refreshModels: fixture.refreshModels,
  }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/components/Avatar", () => ({ BotAvatar: () => null }));
// the phone's bottom sheet has its own tests; here only that the chip's menu is shown in one
vi.mock("@/mobile/Sheet", async () => {
  const { createElement: h } = await import("react");
  return { Sheet: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? h("div", { "data-test-sheet": title }, children) : null };
});

const { ComposerModelChip } = await import("./ComposerModelChip");

const claude: InstanceInfo = {
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription",
  snapshot: { state: "available", version: "2.1.300", authenticated: true },
  models: { default: "claude-opus-5-5", options: [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  ] },
};
const scout: Bot = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
};

let host: HTMLDivElement;
let root: Root;
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const render = (phone: boolean, typing = false) =>
  flushSync(() => root.render(createElement(ComposerModelChip, { bot: scout, phone, typing })));
const chip = () => host.querySelector<HTMLButtonElement>("[data-composer-model]")!;
const row = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("[data-model-picker-content] [data-menu-row]")]
  .find((button) => button.textContent?.includes(name));
const picks = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "setModel");

beforeEach(() => {
  fixture.instances = [claude];
  fixture.bots = [scout];
  fixture.dispatch.mockReset();
  document.documentElement.dataset.reducedMotion = "true";
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("the model chip beside the message box", () => {
  it("names the bot's model and switches it in two clicks, for this conversation and the bot", async () => {
    render(false);
    expect(chip().getAttribute("aria-label")).toBe("Model, Claude Opus 5.5");
    expect(chip().querySelector("[data-composer-model-name]")?.textContent).toBe("Opus 5.5");
    expect(chip().querySelector("[data-provider-mark], svg, img")).not.toBeNull();
    flushSync(() => chip().click());
    await settle();
    expect(document.querySelector("[data-model-picker-content]")?.getAttribute("role")).toBe("dialog");
    flushSync(() => row("Sonnet 5.5")!.click());
    expect(picks()).toEqual([expect.objectContaining({ botId: "scout", threadId: "thread-scout", updateBotDefault: true,
      selection: expect.objectContaining({ instanceId: "claude", model: "claude-sonnet-5-5" }) })]);
  });

  it("on a phone shows the menu in a bottom sheet, and keeps only the engine's mark while there is text to send", async () => {
    render(true);
    expect(chip().querySelector("[data-composer-model-name]")?.textContent).toBe("Opus 5.5");
    flushSync(() => chip().click());
    await settle();
    expect(document.querySelector('[data-test-sheet="Choose model"] [data-model-picker-content]')).not.toBeNull();
    flushSync(() => row("Sonnet 5.5")!.click());
    expect(picks()).toHaveLength(1);

    render(true, true);
    expect(chip().querySelector("[data-composer-model-name]")).toBeNull();
    expect(chip().getAttribute("aria-label")).toBe("Model, Claude Opus 5.5");
  });
});
