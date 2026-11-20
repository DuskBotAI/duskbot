// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/testing/quiet-canceled-animations";
import type { Bot, Group, Message } from "@/state/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({ bots: [] as Bot[] }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots: fixture.bots }, dispatch: vi.fn() }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { GroupView } = await import("./GroupView");

const member = (id: string, name: string, color: Bot["color"]) =>
  ({ id, name, color, busy: false, messages: [], notifications: true, unread: false, title: "", description: "", modelSelection: { instanceId: "test", model: "default" } }) as unknown as Bot;
fixture.bots = [member("nova", "Nova", "green"), member("quill", "Quill", "blue")];
const at = Date.UTC(2026, 10, 20, 12);
const ask: Message = { id: "ask", role: "user", kind: "text", at, text: "@Nova @Quill both of you, please" };
const said = (id: string, botId: string, name: string, offset: number): Message =>
  ({ id, role: "bot", kind: "text", at: at + offset, text: `${name} here`, from: { botId, name, color: "green" } });
const room = (messages: Message[], busyBotId?: string, threadId = "room-thread"): Group => ({
  id: "room", threadId, name: "Desk team", memberIds: ["nova", "quill"], defaultResponder: { kind: "member", botId: "nova" },
  bulletin: "", unread: false, createdAt: 1, messages, ...(busyBotId ? { busyBotId, turnStartedAt: at } : {}),
} as unknown as Group);

let host: HTMLDivElement;
let root: Root;
const show = (group: Group) => act(() => root.render(createElement(GroupView, { group })));

beforeEach(() => {
  vi.useFakeTimers({ now: at + 10_000 });
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

describe("a room's working line", () => {
  it("stays one line through turns, replies and a thread switch", () => {
    show(room([ask], "nova"));
    show(room([ask, said("n1", "nova", "Nova", 2_000)], "quill"));
    act(() => void vi.advanceTimersByTime(2_000));
    show(room([ask, said("n1", "nova", "Nova", 2_000), said("q1", "quill", "Quill", 4_000)]));
    act(() => void vi.advanceTimersByTime(2_000));
    show(room([ask], "nova", "other-thread"));
    show(room([ask, said("n2", "nova", "Nova", 6_000)], undefined, "other-thread"));
    act(() => void vi.advanceTimersByTime(2_000));
    expect(host.querySelectorAll("[data-room-working-lines]")).toHaveLength(1);
  });
});
