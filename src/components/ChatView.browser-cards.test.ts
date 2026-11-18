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
vi.mock("@/lib/live-events", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/live-events")>(), listenLiveFrames: () => () => {} }));
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

const browse = (id: string, action: string, tool: Partial<NonNullable<Message["tool"]>> = {}): Message =>
  ({ id, role: "bot", kind: "activity", at: NOW - 5_000, turnId: "turn", tool: { name: `mcp__browser__agent_browser_${action}`, itemId: id, ...tool } });
const opened = (id: string, site: string) => browse(id, "open", { ok: true, step: { activity: "fetch", target: site } });
const kinds = (markup: string) => [...markup.matchAll(/data-live-card="(\w+)" data-live-card-state="(\w+)"/g)].map((match) => `${match[1]}:${match[2]}`);

describe("ChatView browser cards", () => {
  it("draws one open card for the whole stretch while the bot browses, with tool-call chips off", () => {
    const markup = render(bot(transcript(opened("b1", "example.com"), browse("b2", "click", { ok: false }), browse("b3", "fill", { ok: true }), browse("b4", "snapshot")), true));
    expect(kinds(markup)).toEqual(["browser:running"]);
    expect(markup).toContain("example.com");
    expect(markup).toContain("4 steps");
    expect(markup).toContain("Reading the page");
    expect(markup).toContain("Open Pepper&#x27;s live browser");
    expect(markup).not.toContain('data-testid="tool-activity"');
  });

  it("folds the stretch to one pill once the turn has its answer, where the bot browsed", () => {
    const markup = render(bot([
      ...transcript(opened("b1", "example.com"), browse("b2", "get_text", { ok: true })),
      { id: "end", role: "bot", kind: "text", text: "The price is 12 dollars.", at: NOW - 1_000, turnId: "turn", turnTerminal: true },
    ]));
    expect(kinds(markup)).toEqual(["browser:done"]);
    expect(markup).toContain("2 steps");
    expect(markup.indexOf('data-live-card="browser"')).toBeLessThan(markup.indexOf("The price is 12 dollars."));
  });

  it("folds the stretch when the bot moves on to a command, and keeps both in order", () => {
    const markup = render(bot(transcript(opened("b1", "example.com"), browse("b2", "click", { ok: true }), command("c1", "pnpm test")), true));
    expect(kinds(markup)).toEqual(["browser:done", "command:running"]);
  });

  it("starts a new card after the bot's own words", () => {
    const markup = render(bot([
      ...transcript(opened("b1", "example.com")),
      { id: "mid", role: "bot", kind: "text", text: "That page is empty.", at: NOW - 3_000, turnId: "turn" },
      opened("b2", "docs.example.org"),
    ], true));
    expect(kinds(markup)).toEqual(["browser:done", "browser:running"]);
    expect(markup.indexOf("example.com")).toBeLessThan(markup.indexOf("That page is empty."));
  });

  it("keeps a web search and a page fetch out of the chat: they do not use the browser", () => {
    const search: Message = { id: "w1", role: "bot", kind: "activity", at: NOW - 4_000, turnId: "turn", tool: { name: "WebSearch", ok: true, step: { activity: "web", target: "cat pictures" } } };
    const fetched: Message = { id: "w2", role: "bot", kind: "activity", at: NOW - 4_000, turnId: "turn", tool: { name: "WebFetch", ok: true, step: { activity: "fetch", target: "fetched.example" } } };
    const markup = render(bot(transcript(search, fetched)));
    expect(kinds(markup)).toEqual([]);
    expect(markup).not.toContain("cat pictures");
    expect(markup).not.toContain("fetched.example");
  });

  it("draws no card when the server's switch is off, and leaves the steps to the tool chips when those are on", () => {
    flags.liveCards = false;
    expect(kinds(render(bot(transcript(opened("b1", "example.com")))))).toEqual([]);
    flags.liveCards = true;
    flags.showToolCalls = true;
    const markup = render(bot(transcript(opened("b1", "example.com"))));
    expect(kinds(markup)).toEqual([]);
    expect(markup).toContain('data-testid="tool-activity"');
  });
});
