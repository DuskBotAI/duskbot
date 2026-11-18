import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

const flags = vi.hoisted(() => ({ liveCards: true, showToolCalls: false }));
vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: { ...original.initialState.config, features: { ...flags } } as AppState["config"], instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo] },
    dispatch: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => { flags.liveCards = true; flags.showToolCalls = false; });

const NOW = Date.now();
const command = (id: string, detail: string, tool: Partial<NonNullable<Message["tool"]>> = {}): Message =>
  ({ id, role: "bot", kind: "activity", at: NOW - 5_000, turnId: "turn", tool: { name: "Bash", itemId: id, step: { activity: "command", target: detail, detail }, ...tool } });
const transcript = (...steps: Message[]): Message[] => [
  { id: "ask", role: "user", kind: "text", text: "run the checks", at: NOW - 6_000 },
  ...steps,
];
const chained = (messages: Message[]): Message[] => messages.map((message, index) => (index ? { ...message, parentId: messages[index - 1]!.id } : message));
const bot = (rows: Message[], busy = false, messages = chained(rows)): Bot => ({
  id: "bot", threadId: "t1", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy, ...(busy ? { turnStartedAt: NOW - 6_000 } : {}), messages, activeLeafId: messages.at(-1)?.id,
  modelSelection: { instanceId: "test", model: "m" },
});
const render = (b: Bot) => renderToStaticMarkup(createElement(ChatView, { bot: b }));
const cards = (markup: string) => [...markup.matchAll(/data-live-card-state="(\w+)"/g)].map((match) => match[1]);

describe("ChatView command cards", () => {
  it("draws a running command as an open card and a finished one as a pill, with tool-call chips off", () => {
    const markup = render(bot(transcript(command("c1", "pnpm lint", { ok: true, ms: 2_000 }), command("c2", "pnpm test")), true));
    expect(cards(markup)).toEqual(["done", "running"]);
    expect(markup).toContain("pnpm lint");
    expect(markup).toContain("pnpm test");
    expect(markup).not.toContain('data-testid="tool-activity"');
  });

  it("keeps every other tool step out of the chat", () => {
    const read: Message = { id: "r1", role: "bot", kind: "activity", at: NOW - 4_000, turnId: "turn", tool: { name: "Read", ok: true, step: { activity: "read", target: "notes.md" } } };
    const markup = render(bot(transcript(read, command("c1", "ls", { ok: true }))));
    expect(cards(markup)).toEqual(["done"]);
    expect(markup).not.toContain("notes.md");
  });

  it("keeps a settled turn's commands in the chat, each where it ran", () => {
    const markup = render(bot([
      ...transcript(command("c1", "git status", { ok: true })),
      { id: "mid", role: "bot", kind: "text", text: "Two files changed.", at: NOW - 3_000, turnId: "turn" },
      command("c2", "pnpm build", { ok: false }),
      { id: "end", role: "bot", kind: "text", text: "The build failed.", at: NOW - 1_000, turnId: "turn", turnTerminal: true },
    ]));
    expect(cards(markup)).toEqual(["done", "failed"]);
    expect(markup.indexOf("git status")).toBeLessThan(markup.indexOf("Two files changed."));
    expect(markup.indexOf("Two files changed.")).toBeLessThan(markup.indexOf("pnpm build"));
  });

  it("draws no card when the server's switch is off", () => {
    flags.liveCards = false;
    const markup = render(bot(transcript(command("c1", "pnpm lint", { ok: true }))));
    expect(cards(markup)).toEqual([]);
    expect(markup).not.toContain("pnpm lint");
  });

  it("leaves command steps to the tool chips when those are on", () => {
    flags.showToolCalls = true;
    const markup = render(bot(transcript(command("c1", "pnpm lint", { ok: true }))));
    expect(cards(markup)).toEqual([]);
    expect(markup).toContain('data-testid="tool-activity"');
  });
});
