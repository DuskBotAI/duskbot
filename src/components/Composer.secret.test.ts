// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { takeOfferedSecret } from "@/lib/composer-secret";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), bot: null as unknown as Bot }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [fixture.bot], instances: [{ instanceId: "claude-test", driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: true } }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));
vi.mock("./CallView", () => ({ CallButton: () => null }));

import { Composer } from "./Composer";

const KEY = "sk-ant-ZZtestFAKE0123456789";
const card = { id: "card-1", role: "assistant", text: "", createdAt: 1,
  secret: { target: "customSecret", label: "Stripe secret key", description: "" } } as unknown as Message;
const base: Bot = {
  id: "key-bot", threadId: "key-thread", name: "Pepper", title: "", description: "",
  color: "blue", notifications: false, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "claude-test", model: "fake" },
};
const draftId = `bot:${base.id}:${base.threadId}`;

describe("a key typed into the composer", () => {
  let root: Root;
  let container: HTMLDivElement;

  const mount = (messages: Message[]) => {
    fixture.bot = { ...base, messages };
    flushSync(() => root.render(createElement(Composer, { bot: fixture.bot })));
  };
  const fill = (text: string) => {
    flushSync(() => restoreComposerDraft(draftId, { text, attachments: [] }));
    return container.querySelector("textarea")!;
  };
  const enter = (input: HTMLTextAreaElement) =>
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  const warning = () => container.querySelector("[data-composer-key-warning]");
  const click = (selector: string) => flushSync(() => container.querySelector<HTMLButtonElement>(selector)!.click());
  const sends = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "send");

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    takeOfferedSecret(card.id);
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("is not sent; with a Secrets card open, the safe choice moves it into the card and keeps the other words", () => {
    mount([card]);
    const input = fill(`here is the key ${KEY}`);
    enter(input);
    expect(sends()).toEqual([]);
    expect(warning()?.textContent).toContain("Put it in the Stripe secret key card instead");
    click("[data-key-keep-out]");
    expect(sends()).toEqual([]);
    expect(takeOfferedSecret(card.id)).toBe(KEY);
    expect(input.value).toBe("here is the key");
    expect(warning()).toBeNull();
  });

  it("moves one key into the card and leaves a second in the words, to be asked about on the next send", () => {
    const second = "sk-ant-ZZtestOTHER9876543210";
    mount([card]);
    const input = fill(`${KEY} and ${second}`);
    enter(input);
    click("[data-key-keep-out]");
    expect(takeOfferedSecret(card.id)).toBe(KEY);
    expect(input.value).toBe(`and ${second}`);
    enter(input);
    expect(sends()).toEqual([]);
    expect(warning()).not.toBeNull();
  });

  it("closes on Escape without sending or changing the words", () => {
    mount([]);
    const input = fill(`deploy with ${KEY}`);
    enter(input);
    flushSync(() => warning()!.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(warning()).toBeNull();
    expect(sends()).toEqual([]);
    expect(input.value).toBe(`deploy with ${KEY}`);
  });

  it("with no card open, the safe choice takes it out of the words", () => {
    mount([]);
    const input = fill(`deploy with ${KEY} please`);
    enter(input);
    expect(warning()?.textContent).toContain("Take it out");
    click("[data-key-keep-out]");
    expect(sends()).toEqual([]);
    expect(input.value).toBe("deploy with please");
  });

  it("is sent word for word only after Send anyway", () => {
    mount([card]);
    enter(fill(KEY));
    click("[data-key-send-anyway]");
    expect(sends()).toEqual([expect.objectContaining({ botId: base.id, text: KEY })]);
    expect(takeOfferedSecret(card.id)).toBeUndefined();
  });

  it("leaves ordinary words alone", () => {
    mount([card]);
    enter(fill("the key is in Settings"));
    expect(warning()).toBeNull();
    expect(sends()).toEqual([expect.objectContaining({ text: "the key is in Settings" })]);
  });
});
