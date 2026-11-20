import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { instances: [] as InstanceInfo[], bots: [] as Bot[] };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, instances: fixture.instances, bots: fixture.bots },
    dispatch: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { RoomToolChip } = await import("./GroupView");
const { FailedReplyCard } = await import("./FailedReplyCard");
const { trailingRows } = await import("@/lib/failed-reply");

// failures older than a day leave the card, so these rows are recent
const T0 = Date.now();

const claude = {
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
  snapshot: { state: "available", authenticated: false },
  install: { command: { darwin: "npm i -g x", linux: "npm i -g x", win32: "npm i -g x" }, signInCommand: "claude /login", server: { package: "@anthropic-ai/claude-code" } },
  authentication: { method: "paste-code" },
  models: { default: "sonnet", options: [] },
} as InstanceInfo;
const NAMES = ["Echo", "Quill", "Rivet", "Nova"];
fixture.instances = [claude];
fixture.bots = NAMES.map((name) => ({ id: name.toLowerCase(), name, modelSelection: { instanceId: "claude", model: "sonnet" } }) as Bot);

const ask: Message = { id: "ask", role: "user", kind: "text", at: T0 + 1, text: "hi all" };
const failed = (name: string, cause: string, patch: Partial<NonNullable<Message["tool"]>> = {}): Message => ({
  id: `failed-${name}`, role: "bot", kind: "activity", at: T0 + 2,
  from: { botId: name.toLowerCase(), name, color: "blue" },
  tool: { name: `error: ${cause}`, ok: false, ...patch },
});
const card = (messages: Message[], group = true, onRetry?: () => void) =>
  renderToStaticMarkup(createElement(FailedReplyCard, { rows: trailingRows(messages), group, threadId: "room", onRetry }));
const count = (markup: string, needle: string) => markup.split(needle).length - 1;

describe("failed replies in a room", () => {
  const signedOut = NAMES.map((name) => failed(name, "Not logged in · Please run /login", { setup: true }));

  it("leaves no row in the chat", () => {
    expect(renderToStaticMarkup(createElement(RoomToolChip, { message: signedOut[0]!, roomId: "room" }))).toBe("");
  });

  it("says every bot that failed in one card, the reason in plain words, with the sign-in", () => {
    const markup = card([ask, ...signedOut]);
    expect(count(markup, "data-chat-error")).toBe(1);
    expect(markup).toContain("Echo, Quill and 2 more couldn&#x27;t respond");
    expect(markup).toContain("Claude isn&#x27;t signed in on this computer");
    expect(markup).toContain("Sign in</button>");
    expect(markup).toContain('aria-label="Dismiss"');
    expect(markup).not.toContain("/login");
    expect(markup).not.toContain("Not logged in");
    expect(markup).not.toContain("Copy details");
  });

  it("says the most actionable reason when they differ, and never the engine's raw words", () => {
    const markup = card([ask, failed("Echo", "API Error: 529 overloaded_error"), failed("Quill", "Not logged in · Please run /login", { setup: true })]);
    expect(markup).toContain("Echo and Quill couldn&#x27;t respond");
    expect(markup).toContain("Claude isn&#x27;t signed in on this computer");
    expect(markup).not.toContain("529");
  });

  it("maps a stored reason or the words to its kind's one sentence, never the cause itself", () => {
    expect(card([ask, failed("Echo", "x", { reason: "rate_limit" })])).toContain("Claude is busy right now. Try again in a moment.");
    expect(card([ask, failed("Echo", "The operation timed out.")])).toContain("Claude didn&#x27;t reply. Try again.");
    const plain = card([ask, failed("Echo", "Your Pro plan includes 2 cloud computers at once.")]);
    expect(plain).toContain("Echo couldn&#x27;t respond");
    expect(plain).not.toContain("Your Pro plan includes");
    const technical = card([ask, failed("Echo", "TypeError: Cannot read properties of undefined (reading 'id')")]);
    expect(technical).toContain("Your bot couldn&#x27;t finish this reply. Try again.");
    expect(technical).not.toContain("TypeError");
  });

  it("goes away once a bot replies or the person writes again", () => {
    const reply: Message = { id: "r", role: "bot", kind: "text", at: T0 + 3, text: "here", from: { botId: "echo", name: "Echo", color: "blue" } };
    expect(card([ask, signedOut[0]!, reply])).toBe("");
    expect(card([ask, ...signedOut, { ...ask, id: "again", at: T0 + 4 }])).toBe("");
  });

  it("folds a sign-out notice into the same card, one card total", () => {
    const notice: Message = { id: "n", role: "bot", kind: "activity", at: T0 + 3, from: { botId: "echo", name: "Echo", color: "blue" },
      tool: { name: "notice: Claude is signed out on this computer. Sign in again in Settings → AI to keep using it.", ok: true, setup: true } };
    const rows = trailingRows([ask, signedOut[0]!, notice]);
    expect(rows.notices.map((m) => m.id)).toEqual(["n"]);
    const markup = card([ask, signedOut[0]!, notice]);
    expect(count(markup, "data-chat-error")).toBe(1);
    expect(count(markup, "Sign in</button>")).toBe(1);
    expect(markup).not.toContain("Settings → AI");
  });

  it("titles a direct chat's card the way grok does", () => {
    expect(card([ask, signedOut[0]!], false)).toContain("Bot failed to respond");
  });

  it("says a member that timed out, or whose AI never answered, in the same card, with Try again", () => {
    const timedOut = failed("Rivet", "Rivet's room turn made no progress for 1 minute and was stopped", { reason: "timeout" });
    const rescue = { botId: "quill", threadId: "room", turnId: "t", instanceId: "claude", ai: "Claude", groupId: "g" };
    const silent: Message = { id: "silent", role: "bot", kind: "activity", at: T0 + 2, from: { botId: "quill", name: "Quill", color: "blue" },
      tool: { name: "notice: Quill didn't hear back from Claude.", ok: true, rescue: { ...rescue, over: true } } };
    const markup = card([ask, failed("Echo", "API Error: 529 Overloaded"), timedOut, silent], true, () => {});
    expect(count(markup, "data-chat-error")).toBe(1);
    expect(markup).toContain("Echo, Rivet and 1 more couldn&#x27;t respond");
    expect(markup).toContain("Try again</button>");
    expect(markup).not.toContain("made no progress");
    expect(markup).not.toContain("hear back");
    // still waiting is no failure: the working line says it
    const waiting = { ...silent, tool: { ...silent.tool!, name: "notice: Quill hasn't heard back from Claude yet.", rescue } };
    expect(card([ask, waiting])).toBe("");
  });

  it("says a direct chat's first reply that never came in the card, with Switch AI and Connect your subscription", () => {
    const rescue = { botId: "echo", threadId: "main", turnId: "t", instanceId: "claude", ai: "Claude" };
    const silent: Message = { id: "silent", role: "bot", kind: "activity", at: T0 + 2,
      tool: { name: "notice: Echo didn't hear back from Claude.", ok: true, rescue: { ...rescue, over: true } } };
    const markup = renderToStaticMarkup(createElement(FailedReplyCard, { rows: trailingRows([ask, silent]), botId: "echo", threadId: "main", onRetry: () => {} }));
    expect(count(markup, "data-chat-error")).toBe(1);
    expect(markup).toContain("Bot failed to respond");
    expect(markup).toContain("Echo didn&#x27;t hear back from Claude.");
    expect(markup).toContain("Switch AI</button>");
    expect(markup).toContain("Connect your subscription</button>");
    const waiting = { ...silent, tool: { ...silent.tool!, name: "notice: Echo hasn't heard back from Claude yet.", rescue } };
    expect(renderToStaticMarkup(createElement(FailedReplyCard, { rows: trailingRows([ask, waiting]), botId: "echo", threadId: "main" }))).toBe("");
  });

  it("offers no Try again when nothing can send the line again", () => {
    expect(card([ask, failed("Echo", "API Error: 529 Overloaded")])).not.toContain("try again</button>");
  });
});

describe("a member's hand-off that failed", () => {
  it("is a flat hand-off row in plain words, never a red pill with the engine's", () => {
    const message: Message = {
      id: "h", role: "bot", kind: "activity", at: T0 + 2, from: { botId: "quill", name: "Quill", color: "blue" },
      roomRequest: { id: "job", phase: "result" },
      handoff: { phase: "result", from: { botId: "quill", name: "Quill", color: "blue" }, to: { botId: "nova", name: "Nova", color: "red" } },
      comm: { groupId: "room", withBotId: "quill", withName: "Quill", withColor: "blue" },
      tool: { name: "Quill \u2014 failed: API Error: 529 Overloaded", ok: false },
    };
    const markup = renderToStaticMarkup(createElement(RoomToolChip, { message, roomId: "room" }));
    expect(markup).toContain('data-handoff-row="result"');
    expect(markup).toContain("Your AI is busy right now. Try again in a moment.");
    expect(markup).not.toContain("529");
    expect(markup).not.toContain("text-danger");
  });
});
