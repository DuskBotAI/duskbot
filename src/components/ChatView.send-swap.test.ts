// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AppState, Bot, Message } from "../state/store";

vi.mock("./DesktopCapabilities", async (original) => ({
  ...await original<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ ready: true, capabilities: { dictation: { available: false },
    host: { packaged: true, platform: "other" }, localComputer: { available: false } } }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState } = await import("../state/store");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; vi.unstubAllGlobals(); });

it("keeps the person's bubble as the same element when the server's copy replaces the optimistic one", async () => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const hello: Message = { id: "hello", kind: "text", role: "bot", text: "Hi there", at: 1 };
  const bot: Bot = { id: "bot", threadId: "thread", name: "Fixture", title: "", description: "", color: "green",
    modelSelection: { instanceId: "fake", model: "fake" }, notifications: true, unread: false, messages: [hello], activeLeafId: hello.id };
  let state: AppState = { ...initialState, connected: true, selectedId: bot.id, bots: [bot] };
  const host = document.createElement("div");
  root = createRoot(host);
  const draw = () => root!.render(createElement(BotEditorStore, { value: { state, dispatch: vi.fn(),
    flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
    children: createElement(ChatView, { bot: state.bots[0]! }) }));
  await act(async () => draw());

  const at = Date.now();
  const optimistic: Message = { id: "optimistic-s1", kind: "text", role: "user", text: "plan my week", at, sendId: "s1", parentId: "hello" };
  state = { ...state, bots: [{ ...bot, messages: [hello, optimistic], activeLeafId: optimistic.id }] };
  await act(async () => draw());
  const sentRow = host.querySelector('[data-mid="optimistic-s1"]');
  const sentBubble = sentRow?.querySelector("[data-message-row]");
  expect(sentRow).not.toBeNull();

  const confirmed: Message = { ...optimistic, id: "server-1" };
  state = { ...state, bots: [{ ...bot, messages: [hello, confirmed], activeLeafId: confirmed.id }] };
  await act(async () => draw());
  // the same node, so it neither remounts nor plays its entrance a second time
  expect(host.querySelector('[data-mid="server-1"]')).toBe(sentRow);
  expect(sentRow?.querySelector("[data-message-row]")).toBe(sentBubble);
  expect(host.textContent?.match(/plan my week/g)).toHaveLength(1);
});

it("carries a send out of the composer, grows the reply out of the mascot, and keeps its copy row for a hover", async () => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const { noteSendLaunch } = await import("./bubble-entrance");
  type Played = { el: Element; keyframes: Keyframe[]; done: () => void };
  const played: Played[] = [];
  vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(function (this: HTMLElement, keyframes) {
    const listeners: (() => void)[] = [];
    played.push({ el: this, keyframes: keyframes as Keyframe[], done: () => listeners.forEach((listener) => listener()) });
    return { cancel: vi.fn(), addEventListener: (_type: string, listener: () => void) => listeners.push(listener) } as unknown as Animation;
  });
  const hello: Message = { id: "hello", kind: "text", role: "bot", text: "Hi there", at: 1 };
  const bot: Bot = { id: "bot", threadId: "thread", name: "Fixture", title: "", description: "", color: "green",
    modelSelection: { instanceId: "fake", model: "fake" }, notifications: true, unread: false, messages: [hello], activeLeafId: hello.id };
  let state: AppState = { ...initialState, connected: true, selectedId: bot.id, bots: [bot] };
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const draw = () => root!.render(createElement(BotEditorStore, { value: { state, dispatch: vi.fn(),
    flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
    children: createElement(ChatView, { bot: state.bots[0]! }) }));
  await act(async () => draw());
  expect(played.filter((one) => one.el.closest('[data-mid="hello"]')), "a row already there never animates").toHaveLength(0);

  noteSendLaunch("s1");
  const optimistic: Message = { id: "optimistic-s1", kind: "text", role: "user", text: "plan my week", at: Date.now() + 5, sendId: "s1", parentId: "hello" };
  state = { ...state, bots: [{ ...bot, messages: [hello, optimistic], activeLeafId: optimistic.id }] };
  await act(async () => draw());
  const sent = host.querySelector('[data-mid="optimistic-s1"] [data-chat-bubble]')!;
  expect(sent.closest("[data-arrival-own]"), "the bubble rises on its own, so its row never rises as well").not.toBeNull();
  // one fade, a grow from 0.9 and a 16px rise from its tail corner, by the composer
  expect(played.filter((one) => one.el === sent).map((one) => one.keyframes)).toEqual([[
    { opacity: 0, transform: "translateY(16px) scale(0.9)" }, { opacity: 1, transform: "translateY(0px) scale(1)" },
  ]]);
  expect(played.filter((one) => one.el === sent.closest("[data-arrival]")), "nor does its row").toHaveLength(0);
  expect((sent as HTMLElement).style.transformOrigin).toBe("100% 100%");

  const before = played.length;
  const confirmed: Message = { ...optimistic, id: "server-1" };
  const reply: Message = { id: "reply", kind: "text", role: "bot", text: "Mornings stay clear.", at: Date.now() + 10, parentId: "server-1" };
  state = { ...state, bots: [{ ...bot, messages: [hello, confirmed], activeLeafId: confirmed.id }] };
  await act(async () => draw());
  expect(played.length, "the server's copy does not play the send again").toBe(before);

  state = { ...state, bots: [{ ...bot, messages: [hello, confirmed, reply], activeLeafId: reply.id }] };
  await act(async () => draw());
  // the reply waits on its typing beat, then lands whole
  await act(async () => new Promise((resolve) => setTimeout(resolve, 520)));
  const replyBubble = host.querySelector('[data-mid="reply"] [data-chat-bubble]')!;
  expect(played.find((one) => one.el === replyBubble)?.keyframes).toEqual([{ opacity: 0, transform: "scale(0.94)" }, { opacity: 1, transform: "scale(1)" }]);
  expect((replyBubble as HTMLElement).style.transformOrigin).toBe("0% 0%");
  expect(played.filter((one) => replyBubble.contains(one.el) && one.el !== replyBubble), "its words come with it, never an empty bubble first").toHaveLength(0);
  const replyRow = host.querySelector('[data-mid="reply"]');
  await act(async () => draw());
  expect(host.querySelector('[data-mid="reply"]'), "a redraw keeps the landed reply's node").toBe(replyRow);
  expect(host.querySelector('[data-mid="reply"] [data-chat-bubble]')).toBe(replyBubble);
  expect(played.filter((one) => one.el === replyBubble), "and never grows it again").toHaveLength(1);
  expect(played.filter((one) => one.el === sent).length, "the send never plays again").toBe(1);

  const actions = () => host.querySelector('[data-mid="reply"] [data-testid="message-actions"]');
  expect(actions()?.getAttribute("data-shown")).toBeNull();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 160)));
  expect(actions()?.getAttribute("data-shown"), "the copy row waits for a hover").toBeNull();
  host.remove();
  vi.restoreAllMocks();
});
