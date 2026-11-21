// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ServerFrame } from "../../../shared/wire";
import type { Message } from "@/state/store";
import type { BrowserStep } from "./browser-step";

const frames = vi.hoisted(() => ({ listeners: [] as Array<{ screens?: boolean; onFrame: (frame: unknown) => void }> }));
vi.mock("@/lib/live-events", () => ({
  listenLiveFrames: (listener: { screens?: boolean; onFrame: (frame: unknown) => void }) => {
    frames.listeners.push(listener);
    return () => { frames.listeners.splice(frames.listeners.indexOf(listener), 1); };
  },
}));
vi.mock("@/components/AttachmentPreview", () => ({
  AttachmentPreviewDialog: ({ image, onClose }: { image: { src: string; name: string }; onClose: () => void }) =>
    createElement("div", { role: "dialog", "data-large": image.src, "aria-label": image.name, onClick: onClose }),
}));
const { forgetBrowserSnapshots } = await import("@/state/browser-snapshots");
const { BrowserCard } = await import("./BrowserCard");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = { id: "b1", name: "Nova", color: "green" as const };
const step = (id: string, action: string, tool: Partial<NonNullable<Message["tool"]>> = {}): BrowserStep =>
  ({ id, role: "bot", kind: "activity", at: Date.now() - 2_000, tool: { name: `mcp__browser__agent_browser_${action}`, ...tool } }) as BrowserStep;
const opened = (id: string) => step(id, "open", { ok: true, step: { activity: "fetch", target: "example.com" } });
const page = (png: string): ServerFrame => ({ kind: "screen", botId: "b1", threadId: "t1", png, surface: "browser" });
const send = (frame: ServerFrame) => act(async () => { for (const listener of frames.listeners.slice()) listener.onFrame(frame); });
const render = (steps: BrowserStep[], running: boolean) =>
  act(async () => { root.render(createElement(BrowserCard, { steps, bot, threadId: "t1", running })); });
const card = () => host.querySelector<HTMLElement>("[data-live-card]")!;
const toggle = () => host.querySelector<HTMLButtonElement>("[data-live-card] button[aria-expanded]")!;
const view = () => host.querySelector<HTMLButtonElement>("[data-live-card-browser] button")!;
const shown = () => host.querySelector<HTMLImageElement>("[data-live-card-snapshot]")?.getAttribute("src") ?? null;

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); forgetBrowserSnapshots(); frames.listeners.length = 0; vi.useRealTimers(); });

it("follows the page while the bot browses, then folds to a pill that reopens on the last page and what it did", async () => {
  await render([opened("s1")], true);
  expect(frames.listeners).toHaveLength(1);
  expect(frames.listeners[0]!.screens).toBe(true);
  expect(host.querySelector("[data-live-card-snapshot=waiting]")).not.toBeNull();
  await send(page("ONE"));
  expect(shown()).toBe("data:image/png;base64,ONE");
  await render([opened("s1"), step("s2", "click")], true);
  await send(page("TWO"));
  expect(shown()).toBe("data:image/png;base64,TWO");
  expect(host.querySelector("[data-live-card-now]")!.textContent).toBe("Clicking on the page");

  await render([opened("s1"), step("s2", "click", { ok: true })], false);
  expect(card().dataset.liveCardState).toBe("done");
  expect(frames.listeners).toHaveLength(0);
  expect(host.querySelector("[data-live-card-thumb]")!.getAttribute("src")).toBe("data:image/png;base64,TWO");
  await act(async () => { vi.advanceTimersByTime(400); });
  expect(host.querySelector("[data-live-card-browser]")).toBeNull();

  await act(async () => { toggle().click(); });
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(shown()).toBe("data:image/png;base64,TWO");
  expect([...host.querySelectorAll("ol li")].map((item) => item.textContent)).toEqual(["Opened example.com", "Clicked on the page"]);
  expect(host.querySelector("[data-live-card-now]")).toBeNull();
});

it("lists what it did and no picture when the page is gone from memory", async () => {
  await render([opened("s1"), step("s2", "fill", { ok: false })], false);
  await act(async () => { toggle().click(); });
  expect(host.querySelector("[data-live-card-snapshot]")).toBeNull();
  expect(host.querySelector("[data-live-card-browser] button")).toBeNull();
  expect([...host.querySelectorAll("ol li")].map((item) => item.textContent)).toEqual(["Opened example.com", "Typed on the page"]);
});

it("shows the page larger, keeps it fresh, and closes", async () => {
  await render([opened("s1")], true);
  expect(view().disabled).toBe(true);
  await send(page("ONE"));
  await act(async () => { view().click(); });
  const large = () => host.querySelector<HTMLElement>("[role=dialog]");
  expect(large()!.dataset.large).toBe("data:image/png;base64,ONE");
  expect(large()!.getAttribute("aria-label")).toBe("example.com");
  await send(page("TWO"));
  expect(large()!.dataset.large).toBe("data:image/png;base64,TWO");
  await act(async () => { large()!.click(); });
  expect(large()).toBeNull();
});
