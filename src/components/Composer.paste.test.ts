// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { resetNotesArrivalForTests } from "@/lib/notes-arrival";
import type { Attachment } from "@/lib/composer-attachments";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  agentsMcp: true,
  dispatch: vi.fn(),
  call: null as Record<string, unknown> | null,
  liveCall: null as unknown,
  config: undefined as unknown,
  api: vi.fn(async () => ({})),
}));
const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, selectedId: "atlas", config: fixture.config ?? original.initialState.config, bots: [bot, { ...peer, defaultBot: {} }], liveCall: fixture.liveCall, instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: fixture.agentsMcp },
    }] },
    dispatch: fixture.dispatch,
  }), api: fixture.api };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/cloud-guest")>(), useReactor: () => "user" }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/default-bot", async (original) => ({ ...(await original<typeof import("@/lib/default-bot")>()), useViewerEmail: () => null }));
vi.mock("./ComposerModelChip", () => ({ ComposerModelChip: () => null }));
vi.mock("./CallView", () => ({ CallButton: (props: Record<string, unknown>) => {
  fixture.call = props;
  return null;
} }));

import { Composer } from "./Composer";

const bot: Bot = {
  id: "atlas", threadId: "atlas-thread", name: "Atlas", title: "", description: "",
  color: "purple", notifications: false, unread: false, busy: false, messages: [], approvalMode: "ask",
  modelSelection: { instanceId: ENGINE, model: "fake" },
};
const peer: Bot = { ...bot, id: "juniper", threadId: "juniper-thread", name: "Juniper", color: "teal" };

let root: Root;
let container: HTMLDivElement;
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

beforeEach(() => {
  setLocale("en");
  resetNotesArrivalForTests();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const LONG = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the build log`).join("\n");
const files: Attachment[] = ["one.pdf", "two.csv", "three.md"].map((name, i) => ({ kind: "file", id: `f${i}`, path: `/u/${name}`, name, size: 10 }));

function paste(text: string) {
  const box = container.querySelector("textarea")!;
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? text : ""), files: [], items: [], types: ["text/plain"] } });
  flushSync(() => box.dispatchEvent(event));
  return event;
}
const tiles = () => [...container.querySelectorAll<HTMLElement>("[data-composer-attachment]")];
const lit = () => tiles().filter((tile) => tile.querySelector("[data-attachment-glow]")).map((tile) => tile.dataset.attachmentId);

describe("a long paste into a message that already has attachments", () => {
  it("lands where it can be seen: the new tile scrolls into view, lights up and is announced with the count", async () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: files });
    flushSync(() => root.render(createElement(Composer, { bot })));
    expect(lit()).toEqual([]);
    const scrolled = vi.mocked(HTMLElement.prototype.scrollIntoView);
    scrolled.mockClear();
    expect(paste(LONG).defaultPrevented).toBe(true);
    await settle();
    expect(tiles()).toHaveLength(4);
    const added = tiles().at(-1)!;
    expect(added.dataset.attachmentKind).toBe("paste");
    expect(lit()).toEqual([added.dataset.attachmentId]);
    expect(scrolled.mock.contexts.at(-1)).toBe(added);
    expect(container.querySelector(".sr-only[role=status]")?.textContent).toBe("Pasted text added. 4 attachments in this message.");
  });

  it("is attached once however many times the same text is pasted, and pasting it again shows the one already there", async () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: files });
    flushSync(() => root.render(createElement(Composer, { bot })));
    paste(LONG);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(lit()).toEqual([]);
    const first = tiles().at(-1)!.dataset.attachmentId;
    const scrolled = vi.mocked(HTMLElement.prototype.scrollIntoView);
    scrolled.mockClear();
    expect(paste(LONG).defaultPrevented).toBe(true);
    expect(paste(LONG).defaultPrevented).toBe(true);
    await settle();
    expect(tiles().filter((tile) => tile.dataset.attachmentKind === "paste").map((tile) => tile.dataset.attachmentId)).toEqual([first]);
    expect(lit()).toEqual([first]);
    expect(scrolled.mock.contexts.at(-1)).toBe(tiles().at(-1));
    paste(`${LONG}\nand one more line`);
    await settle();
    expect(tiles().filter((tile) => tile.dataset.attachmentKind === "paste")).toHaveLength(2);
  });
});
