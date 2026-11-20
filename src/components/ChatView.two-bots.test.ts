// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/testing/quiet-canceled-animations";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import type { RuntimeEvent } from "../../shared/runtime-events";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";
import type { ModelPicker } from "./ModelPicker";
import { STATUS_HOLD_MS } from "./TurnPresence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: null, instances: [{ instanceId: "test", driverKind: "claudeAgent", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo] },
    dispatch: vi.fn(),
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
const { noteTurnEvent, resetTurnLive } = await import("@/state/turn-status");
const { resetLandedReplies } = await import("@/hooks/use-landed-reply");
const { resetSentTurns } = await import("@/state/sent-turn");

const started = Date.UTC(2026, 10, 20, 12, 0, 0);
const botAt = (id: string, name: string, color: Bot["color"], startedAt: number, busy = true): Bot => {
  const threadId = `thread-${id}`;
  const ask: Message = { id: `ask-${id}`, role: "user", kind: "text", at: startedAt, text: `Question for ${name}` };
  return {
    id, threadId, name, title: "", description: "", color, notifications: true, unread: false, busy,
    activity: busy ? "working" : "idle", turnStartedAt: busy ? startedAt : undefined, messages: [ask],
    modelSelection: { instanceId: "test", model: "profile-default" },
    tasks: [{ threadId, title: name, createdAt: 1, busy, activity: busy ? "working" : "idle", turnStartedAt: busy ? startedAt : undefined,
      modelSelection: { instanceId: "test", model: "thread-model" }, approvalMode: "full" }],
  };
};

let seq = 0;
const engine = (bot: Bot, event: Partial<RuntimeEvent>) => act(() => noteTurnEvent({
  eventId: `e${++seq}`, provider: "claudeAgent", threadId: bot.threadId, createdAt: new Date().toISOString(), turnId: `turn-${bot.id}`, ...event,
} as RuntimeEvent));
const say = (bot: Bot, label: string) => engine(bot, { type: "turn.progress", activity: "tool", tool: "set_status", label } as Partial<RuntimeEvent>);

let host: HTMLDivElement;
let root: Root;
const show = (bot: Bot) => act(() => root.render(createElement(ChatView, { bot })));
const statusLine = () => {
  const line = host.querySelector("[data-turn-status]")?.cloneNode(true) as HTMLElement | undefined;
  line?.querySelectorAll("[data-word-out]").forEach((node) => node.remove());
  return line?.textContent?.replace(/\s+/g, " ").trim() ?? null;
};
const everyWord = () => host.querySelector(".turn-presence")?.textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers({ now: started + 60_000 });
  resetTurnLive();
  resetLandedReplies();
  resetSentTurns();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("two bots working at once", () => {
  it("never shows one bot's working words in the other's chat, switching back and forth mid-turn", () => {
    const nova = botAt("nova", "Nova", "green", started);
    const quill = botAt("quill", "Quill", "blue", started + 20_000);
    engine(nova, { type: "turn.started" });
    engine(quill, { type: "turn.started" });
    show(nova);
    act(() => void vi.advanceTimersByTime(STATUS_HOLD_MS));
    say(nova, "Comparing standing desks");
    say(quill, "Drafting the invoice");
    expect(statusLine()).toBe("Comparing standing desks");

    show(quill);
    expect(everyWord(), "not even fading out").not.toContain("standing desks");
    expect(statusLine()).toBe("Drafting the invoice");

    act(() => void vi.advanceTimersByTime(1_000));
    say(nova, "Pricing the desks");
    expect(statusLine(), "the other bot's next step leaves this line alone").toBe("Drafting the invoice");

    show(nova);
    expect(everyWord()).not.toContain("invoice");
    expect(statusLine()).toBe("Pricing the desks");
  });

  it("keeps a finished bot's last words out of a busy bot's line", () => {
    const nova = botAt("nova", "Nova", "green", started);
    const quill = botAt("quill", "Quill", "blue", started + 20_000);
    engine(nova, { type: "turn.started" });
    engine(quill, { type: "turn.started" });
    show(nova);
    act(() => void vi.advanceTimersByTime(STATUS_HOLD_MS));
    say(nova, "Comparing standing desks");
    engine(nova, { type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    show(botAt("nova", "Nova", "green", started, false));
    show(quill);
    expect(everyWord()).not.toContain("standing desks");
  });

  it("draws the open chat's own mascot, not the one it switched from", () => {
    const nova = botAt("nova", "Nova", "green", started);
    const quill = botAt("quill", "Quill", "blue", started + 20_000);
    engine(nova, { type: "turn.started" });
    engine(quill, { type: "turn.started" });
    show(nova);
    act(() => void vi.advanceTimersByTime(STATUS_HOLD_MS));
    const novaInk = host.querySelector("[data-working-mascot] path")?.getAttribute("fill");
    show(quill);
    expect(host.querySelectorAll("[data-working-mascot]")).toHaveLength(1);
    expect(host.querySelector("[data-working-mascot] path")?.getAttribute("fill")).not.toBe(novaInk);
  });
});
