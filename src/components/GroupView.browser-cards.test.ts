// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group, Message } from "@/state/store";

const flags = vi.hoisted(() => ({ liveCards: true }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [] as Bot[], config: { ...original.initialState.config, features: { ...flags } } as AppState["config"] },
    dispatch: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/live-events", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/live-events")>(), listenLiveFrames: () => () => {} }));

const { Transcript } = await import("./GroupView");
const { forgetBrowserSnapshots, noteBrowserFrame } = await import("@/state/browser-snapshots");

const NOW = Date.now();
const from = { botId: "lead", name: "Lead", color: "blue" as const };
const room = (working: boolean): Group => ({
  id: "room", threadId: "room-thread", name: "Launch", memberIds: ["lead"],
  defaultResponder: { kind: "member", botId: "lead" }, bulletin: "", unread: false,
  createdAt: 1, messages: [], ...(working ? { busy: true, turnStartedAt: NOW - 6_000 } : {}),
});
const lead = { id: "lead", name: "Lead", color: "blue" } as Bot;
const ask: Message = { id: "ask", role: "user", kind: "text", at: NOW - 6_000, text: "Ship it" };
const command = (id: string, detail: string, tool: Partial<NonNullable<Message["tool"]>> = {}): Message =>
  ({ id, role: "bot", kind: "activity", at: NOW - 5_000, from, tool: { name: "Bash", itemId: id, step: { activity: "command", target: detail, detail }, ...tool } });
const read: Message = { id: "r1", role: "bot", kind: "activity", at: NOW - 4_500, from, tool: { name: "Read", ok: true, step: { activity: "read", target: "notes.md" } } };

let host: HTMLDivElement;
let root: Root;
const render = (messages: Message[], group: Group = room(false)) => flushSync(() => root.render(createElement(Transcript, {
  group, members: [lead], locale: "en", messages, transcript: messages, onReply: () => {},
})));

beforeEach(() => {
  flags.liveCards = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  forgetBrowserSnapshots();
});

const browse = (id: string, action: string, tool: Partial<NonNullable<Message["tool"]>> = {}): Message =>
  ({ id, role: "bot", kind: "activity", at: NOW - 5_000, from, tool: { name: `mcp__browser__agent_browser_${action}`, itemId: id, ...tool } });
const opened = (id: string, site: string) => browse(id, "open", { ok: true, step: { activity: "fetch", target: site } });
const kinds = () => [...host.querySelectorAll<HTMLElement>("[data-live-card]")].map((card) => `${card.dataset.liveCard}:${card.dataset.liveCardState}`);

describe("browser cards in a room", () => {
  it("draws a member's stretch of browser calls as one pill, past the tool steps the room does not draw", () => {
    render([ask, opened("b1", "example.com"), read, browse("b2", "click", { ok: false }), browse("b3", "get_text", { ok: true })]);
    expect(kinds()).toEqual(["browser:done"]);
    expect(host.textContent).toContain("example.com");
    expect(host.textContent).toContain("3 steps");
    expect(host.textContent).not.toContain("notes.md");
  });

  it("is an open card while that member's call runs, saying what it does and showing the page the room's thread is sent", () => {
    const steps = [ask, opened("b1", "example.com"), browse("b2", "click")];
    render(steps, { ...room(true), working: true, busyBotId: "lead" });
    expect(kinds()).toEqual(["browser:running"]);
    expect(host.querySelector("[data-live-card-now]")!.textContent).toBe("Clicking on the page");
    expect(host.querySelector("[data-live-card-snapshot=waiting]")).not.toBeNull();
    flushSync(() => noteBrowserFrame({ kind: "screen", botId: "someone-else", threadId: "room-thread", png: "OTHER", surface: "browser" }));
    expect(host.querySelector("[data-live-card-snapshot=waiting]")).not.toBeNull();
    flushSync(() => noteBrowserFrame({ kind: "screen", botId: "lead", threadId: "room-thread", png: "PAGE", surface: "browser" }));
    expect(host.querySelector<HTMLImageElement>("img[data-live-card-snapshot]")!.getAttribute("src")).toBe("data:image/png;base64,PAGE");
    expect(host.querySelector<HTMLButtonElement>("[data-live-card-browser] button")!.getAttribute("aria-label")).toBe("Show Lead's browser larger");
  });

  it("keeps a member's commands and browser stretch apart, in order", () => {
    render([ask, command("c1", "pnpm lint", { ok: true }), opened("b1", "example.com"), browse("b2", "click", { ok: true }), command("c2", "pnpm build", { ok: true })]);
    expect(kinds()).toEqual(["command:done", "browser:done", "command:done"]);
  });

  it("draws nothing for them when the server's switch is off", () => {
    flags.liveCards = false;
    render([ask, opened("b1", "example.com")]);
    expect(kinds()).toEqual([]);
    expect(host.textContent).not.toContain("example.com");
  });
});
