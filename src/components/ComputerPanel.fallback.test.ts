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
vi.mock("./CloudScreenPreview", () => ({
  CloudScreenPreview: ({ src, canOpen }: { src: string | null; canOpen?: boolean }) => createElement("img", { "data-preview": "", "data-can-open": String(canOpen !== false), src: src ?? "" }),
}));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => null }));
const joins = vi.hoisted(() => ({ count: 0 }));
vi.mock("./LiveDesktop", () => ({ LiveDesktop: ({ onUnreachable }: { onUnreachable: () => void }) => { useEffect(() => { joins.count++; onUnreachable(); }, []); return null; } }));
vi.mock("./bot-settings/RoutinesSection", () => ({ RoutinesSection: () => null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/bots/bot/computer/screenshot")) {
      if (init?.method === "POST") captured.posts++;
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

describe("Computer panel when the live desktop can't connect", () => {
  it("says why Take control and Full screen are off, and drops the picture's Open action", () => {
    expect(joins.count).toBe(1);
    expect(document.querySelector("img[data-preview]")?.getAttribute("data-can-open")).toBe("false");
    expect(button("Take control")?.disabled).toBe(true);
    expect(button("Take control")?.title).toBe("The live view isn't connecting, so you can only watch for now.");
    expect(button("Full screen")?.disabled).toBe(true);
    expect(button("Full screen")?.title).toBe("The live view isn't connecting, so you can only watch for now.");
    expect(document.querySelector("[role=status]")?.textContent).toContain("you can only watch for now");
  });

  it("keeps saying so through its own retries, and Retry live view tries again at once", async () => {
    await vi.advanceTimersByTimeAsync(1_500);
    await settle();
    expect(joins.count).toBe(2);
    expect(button("Take control")?.title).toBe("The live view isn't connecting, so you can only watch for now.");
    flushSync(() => button("Retry live view")!.click());
    await settle();
    expect(joins.count).toBe(3);
  });
});
