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

const { Transcript } = await import("./GroupView");

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
const cards = () => [...host.querySelectorAll<HTMLElement>("[data-live-card]")].map((card) => card.dataset.liveCardState);

beforeEach(() => {
  flags.liveCards = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("command cards in a room", () => {
  it("draws a member's commands, and none of its other tool steps", () => {
    render([ask, command("c1", "pnpm lint", { ok: true }), read, command("c2", "pnpm build", { ok: false })]);
    expect(cards()).toEqual(["done", "failed"]);
    expect(host.textContent).toContain("pnpm lint");
    expect(host.textContent).not.toContain("notes.md");
    expect(host.querySelector('[data-testid="tool-activity"]')).toBeNull();
  });

  it("draws a run of finished commands one under another", () => {
    render([ask, command("c1", "pnpm lint", { ok: true }), command("c2", "pnpm test", { ok: true })]);
    expect(host.querySelector("[data-command-rows]")?.getAttribute("data-command-rows")).toBe("2");
    expect(cards()).toEqual(["done", "done"]);
  });

  it("draws nothing for them when the server's switch is off", () => {
    flags.liveCards = false;
    render([ask, command("c1", "pnpm lint", { ok: true }), command("c2", "pnpm test", { ok: true })]);
    expect(cards()).toEqual([]);
    expect(host.textContent).not.toContain("pnpm lint");
  });
});
