// @vitest-environment happy-dom
import { createElement, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";
import type { ModelPicker } from "./ModelPicker";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  showToolCalls: false,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: fixture.showToolCalls ? { features: { showToolCalls: true } } : null,
      instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./SidebarPopoverMenu", async (importOriginal) => ({
  ...await importOriginal<typeof import("./SidebarPopoverMenu")>(),
  SidebarPopoverMenu: (props: { renderTrigger: (state: { open: boolean }) => unknown }) => props.renderTrigger({ open: false }),
}));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => null, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: (_props: ComponentProps<typeof ModelPicker>) => createElement("span") }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: (_props: ComponentProps<typeof ApprovalModeSelector>) => createElement("span") }));

const { ChatView } = await import("./ChatView");

const CANCELLED = "The request was cancelled by the client.";
const bot: Bot = {
  id: "bot", threadId: "selected", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "test", model: "profile-default" },
  tasks: [{ threadId: "selected", title: "Selected", createdAt: 1, busy: false, activity: "idle",
    modelSelection: { instanceId: "test", model: "thread-model" }, approvalMode: "ask" }],
};

let host: HTMLDivElement;
let root: Root;
const render = (shown: Bot) => flushSync(() => root.render(createElement(ChatView, { bot: shown })));
const retry = () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Retry") || button.textContent?.includes("Try again"));

beforeEach(() => {
  fixture.dispatch.mockClear();
  fixture.showToolCalls = false;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("a cancelled turn", () => {
  const T0 = Date.now();
  const ask = { id: "ask", role: "user" as const, kind: "text" as const, at: T0 + 1, text: "Try the new model" };

  it("leaves no row behind for the provider's stop sentence or a legacy stop row", () => {
    render({ ...bot, messages: [ask, { id: "cancel", role: "bot", kind: "text", at: T0 + 2, text: CANCELLED }] });
    expect(host.textContent).toContain("Try the new model");
    expect(host.textContent).not.toContain(CANCELLED);
    expect(retry()).toBeUndefined();
    render({ ...bot, messages: [ask, { id: "cancel", role: "bot", kind: "activity", at: T0 + 2, tool: { name: `error: ${CANCELLED}`, ok: false } }] });
    expect(host.textContent).not.toContain(CANCELLED);
    expect(retry()).toBeUndefined();
  });

  it("keeps a real error, including one that only mentions cancellation", () => {
    const cause = `${CANCELLED} See the logs.`;
    render({ ...bot, messages: [ask, { id: "error", role: "bot", kind: "activity", at: T0 + 2, tool: { name: `error: ${cause}`, ok: false } }] });
    expect(host.textContent).toContain("Bot failed to respond");
    expect(host.textContent, "what the engine said stays in the logs").not.toContain("See the logs");
    expect(host.querySelector("[data-failed-reply] [data-chat-error][role=alert]"), "a real error keeps the danger card, above the composer").not.toBeNull();
    expect(host.textContent).not.toContain("stopped");
    expect(retry()).toBeTruthy();
  });
});
