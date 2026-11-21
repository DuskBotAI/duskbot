// @vitest-environment happy-dom
import { createElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group, InstanceInfo } from "@/state/store";
import { SEND_KEYS, type SendKey } from "@/lib/send-key";
import type { ApprovalModeSelector } from "./ApprovalModeSelector";
import type { ModelPicker } from "./ModelPicker";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), instances: [] as unknown[], config: undefined as unknown }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, api: vi.fn(async () => ({})), useStore: () => ({
    state: { ...original.initialState, instances: fixture.instances, config: fixture.config ?? original.initialState.config },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => null, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: (_props: ComponentProps<typeof ModelPicker>) => createElement("span") }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: (_props: ComponentProps<typeof ApprovalModeSelector>) => createElement("span") }));
vi.mock("@/components/Avatar", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/Avatar")>(),
  MausAvatar: () => null,
}));
vi.mock("./onboarding/Spotlight", () => ({ Spotlight: ({ children }: { children: ReactNode }) => createElement("div", null, children) }));
vi.mock("@/components/onboarding/view-transition", () => ({ withViewTransition: (update: () => void) => { update(); return null; } }));

const { Composer } = await import("./Composer");
const { ChatView } = await import("./ChatView");
const { CloudIntent } = await import("./CloudIntent");
const { setSendKey } = await import("@/lib/send-key");
const { setFollowUpDefault } = await import("@/lib/follow-up");
const { setPendingIntent } = await import("@/lib/cloud-intent");
const { api } = await import("@/state/store");

const bot: Bot = {
  id: "bot", threadId: "selected", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "test", model: "profile-default" },
  tasks: [{ threadId: "selected", title: "Selected", createdAt: 1, busy: false, activity: "idle",
    modelSelection: { instanceId: "test", model: "thread-model" }, approvalMode: "ask" }],
};
const room = {
  id: "room", threadId: "room-thread", name: "Launch", memberIds: ["bot"],
  defaultResponder: { kind: "member", botId: "bot" }, bulletin: "", unread: false,
  createdAt: 1, messages: [],
} as unknown as Group;

let host: HTMLDivElement;
let root: Root;
const render = (element: ReactElement) => flushSync(() => root.render(element));
const textarea = (selector = "textarea") => host.querySelector<HTMLTextAreaElement>(selector)!;

function type(input: HTMLTextAreaElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  flushSync(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** A keydown as the browser delivers it; prevented means the box sent. */
function press(input: Element, init: KeyboardEventInit & { keyCode?: number } = {}) {
  const event = new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true, ...init });
  flushSync(() => input.dispatchEvent(event));
  return event;
}

const sends = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => ["send", "sendGroup", "editMessage"].includes(action.type));

function expectSendKey(mode: SendKey, input: () => HTMLTextAreaElement, sent: () => number) {
  const ime = [{ isComposing: true }, { keyCode: 229 }, { isComposing: true, shiftKey: true }, { keyCode: 229, shiftKey: true }, { isComposing: true, ctrlKey: true }, { keyCode: 229, metaKey: true }];
  for (const init of ime) {
    expect(press(input(), init).defaultPrevented, JSON.stringify(init)).toBe(false);
  }
  expect(sent()).toBe(0);
  const newLines = mode === "enter" ? [{ shiftKey: true }] : mode === "shift-enter" ? [{}] : [{}, { shiftKey: true }];
  for (const init of newLines) {
    expect(press(input(), init).defaultPrevented, JSON.stringify(init)).toBe(false);
  }
  expect(sent()).toBe(0);
  const send = mode === "enter" ? {} : mode === "shift-enter" ? { shiftKey: true } : { ctrlKey: true };
  expect(press(input(), send).defaultPrevented).toBe(true);
  expect(sent()).toBe(1);
}

beforeEach(() => {
  fixture.dispatch.mockClear();
  vi.mocked(api).mockClear();
  fixture.instances = [];
  fixture.config = undefined;
  setSendKey("enter");
  setFollowUpDefault("steer");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe.each(SEND_KEYS)("in %s mode", (mode) => {
  beforeEach(() => setSendKey(mode));

  it("the 1:1 composer sends on its key, and Ctrl/⌘+Enter always", () => {
    render(createElement(Composer, { bot }));
    type(textarea(), "first");
    expectSendKey(mode, textarea, () => sends().length);
    expect(sends()).toEqual([expect.objectContaining({ type: "send", botId: "bot", text: "first" })]);
    type(textarea(), "second");
    expect(press(textarea(), { metaKey: true }).defaultPrevented).toBe(true);
    expect(sends().at(-1)).toEqual(expect.objectContaining({ type: "send", text: "second" }));
    type(textarea(), "third");
    expect(press(textarea(), { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(sends().at(-1)).toEqual(expect.objectContaining({ type: "send", text: "third" }));
  });

  it("a room's composer follows the same key", () => {
    render(createElement(Composer, { group: room, members: [bot] }));
    type(textarea(), "hello room");
    expectSendKey(mode, textarea, () => sends().length);
    expect(sends()).toEqual([expect.objectContaining({ type: "sendGroup", groupId: "room", text: "hello room" })]);
  });

  it("editing a sent message submits on the same key", () => {
    render(createElement(ChatView, { bot: { ...bot, messages: [{ id: "ask", role: "user", kind: "text", at: 1, text: "Try the new model" }] } }));
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-mid="ask"] button[aria-haspopup="menu"]')!.click());
    const edit = [...host.querySelectorAll<HTMLButtonElement>('[data-mid="ask"] [role=menuitem]')].find((item) => (item.textContent ?? "").startsWith("Edit"))!;
    flushSync(() => edit.click());
    const editor = () => host.querySelector<HTMLTextAreaElement>("textarea:not([aria-label])")!;
    expect(editor().value).toBe("Try the new model");
    expectSendKey(mode, editor, () => sends().length);
    expect(sends()).toEqual([expect.objectContaining({ type: "editMessage", messageId: "ask", text: "Try the new model" })]);
  });

  it("the Cloud's first job starts on the same key", () => {
    setPendingIntent("Watch my inbox");
    render(createElement(CloudIntent));
    const job = () => textarea('textarea[aria-label="What should the cloud do while you\'re away?"]');
    expect(job().value).toBe("Watch my inbox");
    const given = () => vi.mocked(api).mock.calls.filter(([, init]) => String(init?.body).includes("cloud-intent-given")).length;
    expectSendKey(mode, job, given);
    expect(given()).toBe(1);
    setPendingIntent(null);
  });
});

describe("an input method in the composer's menus", () => {
  const ime = [{ isComposing: true }, { keyCode: 229 }];

  it("leaves the Enter that confirms 山田 to the input method, not the mention menu", () => {
    render(createElement(Composer, { group: room, members: [{ ...bot, name: "山田" }] }));
    type(textarea(), "@山田");
    // a real input method opens a composition before its candidate keys arrive
    flushSync(() => textarea().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    for (const init of ime) {
      for (const key of ["Enter", "tab", "ArrowDown"]) {
        expect(press(textarea(), { ...init, key }).defaultPrevented, JSON.stringify({ ...init, key })).toBe(false);
      }
      expect(textarea().value).toBe("@山田");
    }
    flushSync(() => textarea().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    expect(press(textarea()).defaultPrevented).toBe(true);
    expect(textarea().value).toBe("@山田 ");
    expect(sends()).toEqual([]);
  });

  it("leaves it to the input method in the command menu too", () => {
    render(createElement(Composer, { group: room, members: [bot] }));
    type(textarea(), "/go");
    for (const init of ime) {
      expect(press(textarea(), init).defaultPrevented, JSON.stringify(init)).toBe(false);
      expect(textarea().value).toBe("/go");
    }
    expect(press(textarea()).defaultPrevented).toBe(true);
    expect(textarea().value).toBe("");
    expect(sends()).toEqual([]);
  });
});

describe("the send key in hints", () => {
  it("names the key on the send button", () => {
    fixture.instances = [{ instanceId: "test", driverKind: "codex", displayName: "Test", capabilities: { queueing: true } } as unknown as InstanceInfo];
    render(createElement(Composer, { bot }));
    type(textarea(), "hi");
    expect(host.querySelector('button[aria-label="Send message"]')?.getAttribute("title")).toBe("Send (Enter)");
    flushSync(() => setSendKey("shift-enter"));
    expect(host.querySelector('button[aria-label="Send message"]')?.getAttribute("title")).toBe("Send (Shift+Enter)");
    flushSync(() => setSendKey("mod-enter"));
    expect(host.querySelector('button[aria-label="Send message"]')?.getAttribute("title")).toBe("Send (Ctrl+Enter)");
  });

  it("names the key on the Cloud's first-job button", () => {
    setSendKey("mod-enter");
    render(createElement(CloudIntent));
    expect(host.querySelector('button[aria-label="Start setting it up"]')?.getAttribute("title")).toBe("Start setting it up (Ctrl+Enter)");
  });
});

describe("a message sent while a one-to-one bot works", () => {
  const steers = { instanceId: "test", driverKind: "codex", displayName: "Test", capabilities: { queueing: true } } as unknown as InstanceInfo;
  const cannotSteer = { ...steers, capabilities: { queueing: false } } as unknown as InstanceInfo;
  const working = { ...bot, busy: true, tasks: [{ ...bot.tasks![0]!, busy: true }] };
  const followUps = () => sends().map((action) => action.followUp);
  const sendButton = () => host.querySelector<HTMLButtonElement>("button[data-composer-send]")!;
  const chooser = () => host.querySelector<HTMLButtonElement>('button[aria-label="Choose how to send this message"]');

  it("steers on Enter and queues with Ctrl/⌘, by key or by click", () => {
    fixture.instances = [steers];
    render(createElement(Composer, { bot: working }));
    for (const [init, followUp] of [[{}, "steer"], [{ ctrlKey: true }, "queue"], [{ metaKey: true }, "queue"]] as const) {
      type(textarea(), "words");
      expect(press(textarea(), init).defaultPrevented).toBe(true);
      expect(sends().at(-1), JSON.stringify(init)).toMatchObject({ type: "send", text: "words", followUp });
    }
    type(textarea(), "clicked");
    expect(sendButton().getAttribute("title")).toBe("Add this to what Pepper is doing");
    flushSync(() => sendButton().click());
    type(textarea(), "ctrl-clicked");
    flushSync(() => sendButton().dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
    expect(sends().slice(-2).map((action) => [action.text, action.followUp])).toEqual([["clicked", "steer"], ["ctrl-clicked", "queue"]]);
  });

  it("follows the setting: Enter queues and Ctrl/⌘ steers once the person picks queue", () => {
    fixture.instances = [steers];
    setFollowUpDefault("queue");
    render(createElement(Composer, { bot: working }));
    type(textarea(), "later");
    press(textarea());
    type(textarea(), "now");
    press(textarea(), { ctrlKey: true });
    expect(followUps()).toEqual(["queue", "steer"]);
  });

  it("needs Shift too when Ctrl/⌘+Enter is the send key", () => {
    fixture.instances = [steers];
    setSendKey("mod-enter");
    render(createElement(Composer, { bot: working }));
    type(textarea(), "one");
    expect(press(textarea()).defaultPrevented).toBe(false);
    press(textarea(), { ctrlKey: true });
    type(textarea(), "two");
    press(textarea(), { ctrlKey: true, shiftKey: true });
    expect(followUps()).toEqual(["steer", "queue"]);
  });

  // while the bot works it is only voice and send: no steer, queue or restart menu
  it("offers no menu of ways to send beside Send, only Send itself", () => {
    fixture.instances = [steers];
    render(createElement(Composer, { bot: working }));
    type(textarea(), "start again with this");
    expect(chooser()).toBeNull();
    expect(sendButton()).not.toBeNull();
  });

  it("sends the person's choice even when it believes the turn cannot be steered: the server queues what the running engine cannot take", () => {
    fixture.instances = [cannotSteer];
    render(createElement(Composer, { bot: working }));
    type(textarea(), "a");
    press(textarea());
    type(textarea(), "b");
    press(textarea(), { ctrlKey: true });
    expect(followUps()).toEqual(["steer", "queue"]);
    type(textarea(), "c");
    flushSync(() => sendButton().click());
    expect(followUps()).toEqual(["steer", "queue", "steer"]);
  });

  it("leaves an idle bot and a room's queue as they were", () => {
    fixture.instances = [steers];
    render(createElement(Composer, { bot }));
    type(textarea(), "idle");
    press(textarea(), { ctrlKey: true });
    expect(chooser()).toBeNull();
    render(createElement(Composer, { group: { ...room, busyBotId: "bot" }, members: [bot] }));
    type(textarea(), "room");
    press(textarea(), { ctrlKey: true });
    expect(chooser()).toBeNull();
    expect(sends().map((action) => [action.type, "followUp" in action])).toEqual([["send", false], ["sendGroup", false]]);
  });
});
