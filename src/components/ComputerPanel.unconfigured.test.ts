// @vitest-environment happy-dom
import { createElement, useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo } from "@/state/store";

const captured = vi.hoisted(() => ({ posts: 0 }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useCaptionChrome: () => ({ padClass: undefined }),
  useDesktopCapabilities: () => ({
    ready: true,
    capabilities: {
      host: { platform: "darwin", label: "Host", session: "unknown", packaged: true, homeDir: "/Users/me" },
      windowChrome: "native",
      screenPreview: { available: false, interaction: "none" },
      dictation: { available: false, engine: "none", onDevice: false },
      localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" },
    },
  }),
}));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => null }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./LiveDesktop", () => ({ LiveDesktop: ({ onUnreachable }: { onUnreachable: () => void }) => { useEffect(onUnreachable, []); return null; } }));
const answer = vi.hoisted(() => ({ unconfigured: true }));
vi.mock("./bot-settings/RoutinesSection", () => ({ RoutinesSection: () => null }));
const { ApiError } = await import("@/state/api");
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/bots/bot/computer/screenshot")) {
      if (init?.method === "POST") captured.posts++;
      if (answer.unconfigured) throw new ApiError("VPS is not configured", 409);
      return { png: "POLLED", format: "png" };
    }
    if (path.startsWith("/api/bots/bot/computer/control")) return { held: false, helpReason: null };
    if (path.startsWith("/api/bots/bot/computer?")) return { configured: true, ready: true, managed: true, imageMatches: true, container: "running" };
    return {};
  },
}));

const { ComputerPanel } = await import("./ComputerPanel");
const { BotEditorStore, initialState } = await import("@/state/store");

const bot = {
  id: "bot", threadId: "thread", name: "Fixture", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: true, computer: "cloud", messages: [],
  modelSelection: { instanceId: "claude", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
} as unknown as Bot;
const engine = {
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription",
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: "m", options: [{ id: "m", label: "M" }] },
  capabilities: { computerMcp: true, browserMcp: true },
} as InstanceInfo;

let root: Root;
let value: Parameters<typeof BotEditorStore>[0]["value"];
const render = (shown: Bot) => {
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ComputerPanel, { bot: shown }) })));
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(0);
    await tick();
  }
};
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === name);

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const state: AppState = {
    ...initialState,
    bots: [bot],
    selectedId: bot.id,
    instances: [engine],
    config: { vps: { configured: true } } as AppState["config"],
  };
  value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  render(bot);
  await settle();
});
afterAll(() => {
  root.unmount();
  vi.useRealTimers();
});

describe("Computer panel for a VPS that isn't set up", () => {
  it("offers the VPS settings beside Retry preview, and no Sleep, Full screen or Take control", () => {
    expect(document.querySelector("[role=alert]")?.textContent).toContain("VPS is not configured");
    expect(button("Open VPS settings")).toBeDefined();
    expect(button("Retry preview")).toBeDefined();
    expect(document.querySelector("[data-testid=computer-actions]")).toBeNull();
    flushSync(() => button("Open VPS settings")!.click());
    expect(value.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "computer" });
  });

  it("brings the actions back once the screen shows", async () => {
    answer.unconfigured = false;
    flushSync(() => button("Retry preview")!.click());
    await settle();
    expect(document.querySelector("[data-testid=computer-actions]")).not.toBeNull();
    expect(button("Open VPS settings")).toBeUndefined();
  });
});
