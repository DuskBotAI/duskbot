// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TRANSCRIPT_WINDOW_SIZE } from "@/lib/transcript-window";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState } = await import("@/state/store");
const { t } = await import("@/lib/i18n");

const at = (minute: number) => new Date(2026, 9, 21, 9, minute).getTime();
const line = (runId: string, extra: Partial<NonNullable<Message["automation"]>> = {}): NonNullable<Message["automation"]> => ({
  routineId: "inbox", runId, name: "Inbox brief", trigger: "schedule", executionThreadId: `${runId}-thread`, scheduledFor: at(0), ...extra,
});
const transcript = (tail: Message[]): Message[] => [
  { id: "m1", parentId: null, role: "user", kind: "text", text: "Draft the weekly update.", at: at(1) },
  { id: "m2", parentId: "m1", role: "bot", kind: "text", text: "Here is the draft.", at: at(2), turnId: "t1", turnTerminal: true },
  ...tail,
];
const pepper = (messages: Message[]): Bot => ({
  id: "pepper", threadId: "main", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: messages.at(-1)!.id, modelSelection: { instanceId: "test", model: "m" },
  tasks: [
    { threadId: "main", title: "Chat", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" },
    { threadId: "run-1-thread", title: "Inbox brief · Oct 21", createdAt: 2, busy: false, activity: "idle", routineRunId: "run-1", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" },
  ],
});

const dispatch = vi.fn();
let root: Root;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function draw(messages: Message[], hasMore = false) {
  const bot = { ...pepper(messages), hasMore };
  const state: AppState = {
    ...initialState, connected: true, selectedId: "pepper", bots: [bot],
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
  };
  const value = { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
  await settle();
}
const caption = (runId: string) => document.querySelector<HTMLElement>(`[data-automation-caption="${runId}"]`);
async function regenerateOffers(): Promise<string[]> {
  const found: string[] = [];
  for (const row of document.querySelectorAll("[data-mid]")) {
    const more = row.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    if (!more) continue;
    flushSync(() => more.click());
    await settle();
    if ([...row.querySelectorAll("[role=menuitem]")].some((item) => item.textContent === t("chat.regenerate"))) found.push(row.getAttribute("data-mid")!);
    flushSync(() => more.click());
    await settle();
  }
  return found;
}

beforeAll(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("an automation's line in the chat", () => {
  it("is the bot's own message, with no caption above it", async () => {
    await draw(transcript([
      { id: "r1", parentId: "m2", role: "bot", kind: "text", text: "Acme replied about the order.", at: at(3), automation: line("run-1") },
      { id: "r2", parentId: "r1", role: "bot", kind: "text", text: "Should I send it?", at: at(4), automation: line("run-2", { needsYou: true }) },
    ]));
    expect(document.querySelector('[data-mid="r1"]')?.textContent).toContain("Acme replied about the order.");
    expect(document.querySelector('[data-mid="r2"]')?.textContent).toContain("Should I send it?");
    expect(caption("run-1")).toBeNull();
    expect(caption("run-2")).toBeNull();
    expect(document.body.textContent).not.toContain(t("chat.automation.needsYou"));
  });

  it("never offers Regenerate on a report, which would branch the person's chat away from it", async () => {
    await draw(transcript([]));
    expect(await regenerateOffers()).toEqual(["m2"]);
    await draw(transcript([{ id: "r1", parentId: "m2", role: "bot", kind: "text", text: "Acme replied.", at: at(3), automation: line("run-1") }]));
    expect(await regenerateOffers()).toEqual([]);
  });

  it("shows a card the run waits on as the card alone", async () => {
    await draw(transcript([{
      id: "c1", parentId: "m2", role: "bot", kind: "options", at: at(3), automation: line("run-1", { needsYou: true }),
      card: { title: "Your bot has a question", subtitle: "Which account should I check?", options: ["Work", "Home"], requestId: "ask-1", requestType: "question" },
    }]));
    expect(caption("run-1")).toBeNull();
    expect(document.querySelector('[data-mid="c1"]')?.textContent).toContain("Which account should I check?");
  });
});

describe("a routine run's opening turn", () => {
  const prompt = '[Scheduled routine "Monday price check", do this now:]\nTrigger id: 1d5d5e0a-7c1f-4b6e-9d2a-3f0e8b1c2d4e\nCheck the prices and tell me what moved.';
  const shown = () => document.body.textContent ?? "";
  for (const [label, row] of [
    ["marked by the server", { routineStart: { name: "Monday price check" } }],
    ["an older line, known by its header", {}],
  ] as const) {
    it(`shows nothing, so the bot's reply reads like any other: no ran-at line, never the prompt or its ids (${label})`, async () => {
      await draw(transcript([
        { id: "p1", parentId: "m2", role: "user", kind: "text", text: prompt, at: at(30), ...row },
        { id: "p2", parentId: "p1", role: "bot", kind: "text", text: "Two prices moved.", at: at(31), turnId: "t2", turnTerminal: true },
      ]));
      expect(document.querySelector('[data-mid="p1"]')).toBeNull();
      for (const raw of ["Monday price check", "ran at", "do this now", "Trigger id", "1d5d5e0a", "[Scheduled routine", "Check the prices"]) expect(shown()).not.toContain(raw);
      expect(shown()).toContain("Two prices moved.");
    });
  }
});

describe("opening a chat after quiet routines", () => {
  const quietRows: Message[] = Array.from({ length: TRANSCRIPT_WINDOW_SIZE + 53 }, (_, index) => {
    const base = { id: `quiet-${index}`, parentId: index === 0 ? "m2" : `quiet-${index - 1}`, at: at(5) + index };
    return index % 3 === 0
      ? { ...base, role: "user", kind: "text", text: "Internal routine prompt", routineStart: { name: "Fixture routine" } }
      : { ...base, role: "bot", kind: "activity", tool: { name: "Fixture tool", ok: true } };
  });

  it("opens on the latest visible reply outside the default window", async () => {
    await draw(transcript(quietRows));
    expect(document.querySelector('[data-mid="m2"]')?.textContent).toContain("Here is the draft.");
    expect(document.querySelector('[data-mid^="quiet-"]')).toBeNull();
  });

  it("requests earlier history once per cursor when the loaded page is entirely hidden", async () => {
    dispatch.mockClear();
    const firstPage = quietRows.slice(-50);
    const requests = () => dispatch.mock.calls.filter(([action]) => action.type === "loadOlderMessages");
    await draw(firstPage, true);
    expect(requests()).toEqual([[{ type: "loadOlderMessages", threadId: "main" }]]);
    await draw([...firstPage], true);
    expect(requests()).toHaveLength(1);
    await draw(quietRows, true);
    expect(requests()).toHaveLength(2);
    await draw(transcript(quietRows));
    expect(document.querySelector('[data-mid="m2"]')?.textContent).toContain("Here is the draft.");
    expect(requests()).toHaveLength(2);
  });
});
