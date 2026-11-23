// @vitest-environment happy-dom
// "Move from Grok Bot", screen by screen, against a client that plays the server: what was found, the move on its way,
// and what came, what each bot can still send and what stayed in Grok Bot on purpose. Every bot here is invented.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { GrokMoveClient } from "@/lib/grok-bot-move";
import type { GrokDetection, GrokFoundBot, GrokMoveProgress, GrokWaitingBot, GrokWaitingList } from "../../../shared/grok-move";

const f = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async () => {
  const { ApiError } = await import("@/state/api");
  return { useStore: () => ({ state: {}, dispatch: f.dispatch }), api: vi.fn(), ApiError };
});
vi.mock("@/components/Avatar", () => ({ MausAvatar: () => null, BotAvatar: () => null }));
const { GrokMoveDialog } = await import("./GrokMoveDialog");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = (rosterId: string, name: string, over: Partial<GrokFoundBot> = {}): GrokFoundBot => ({
  rosterId, name, label: name, description: `${name} does invented things.`, hasDescription: true, look: { color: "purple" }, removed: false,
  chat: { messages: 24, earlier: false, readable: true }, routines: 0, appsUsed: 0, ...over,
});
const NOVA = bot("r1", "Nova", { chat: { messages: 200, earlier: true, readable: true }, routines: 2, look: { color: "purple", photoUrl: "/api/setup-import/grok/move/photo?id=r1" } });
const QUILL = bot("r2", "Quill");
const RIVET = bot("r3", "Rivet", { description: "", hasDescription: false, chat: { messages: 0, earlier: false, readable: true } });
const JUNO = bot("r4", "Juno", { chat: { messages: 0, earlier: false, readable: false } });
const ECHO = bot("r5", "Echo", { removed: true });
const NOVA_TWO = bot("r6", "Nova", { label: "Nova (2)" });
const FOUND: GrokDetection = {
  available: true, found: true, bots: [NOVA, QUILL, RIVET, JUNO, ECHO, NOVA_TWO], apps: ["Calendar", "Notebook"],
  problems: [{ slice: "chat", rosterId: "r4", code: "newerFormat", message: "newer" }], running: false, waiting: 0,
};

const doneRow = (rosterId: string, name: string, over: Partial<GrokMoveProgress["bots"][number]> = {}) => ({
  rosterId, name, state: "done" as const, update: false, botId: `bot-${rosterId}`,
  moved: { messages: 24, earlier: false, picture: false, instructions: true, routineNames: 0, appsUsed: 0 }, ...over,
});
const MOVE_ID = "11111111-1111-4111-8111-111111111111";
const finished = (bots: GrokMoveProgress["bots"], state: GrokMoveProgress["state"] = "done"): GrokMoveProgress => ({
  moveId: MOVE_ID, state, startedAt: 1, finishedAt: 2, done: bots.filter((one) => one.state === "done" || one.state === "failed").length, total: bots.length, bots,
  result: { moved: bots.filter((one) => one.state === "done").length, failed: bots.filter((one) => one.state === "failed").length, apps: ["Calendar", "Notebook"], earlierChats: 1, restInGrokBot: true },
});

function fakeClient() {
  const state: { detection: GrokDetection; progress: GrokMoveProgress | null; waiting: GrokWaitingList } = { detection: FOUND, progress: null, waiting: { bots: [], waiting: 0 } };
  const client = {
    detect: vi.fn(async (): Promise<GrokDetection> => state.detection),
    progress: vi.fn(async () => state.progress),
    waiting: vi.fn(async () => state.waiting),
    start: vi.fn(async (bots: Array<{ rosterId: string }>) => {
      state.progress = { moveId: MOVE_ID, state: "running", startedAt: 1, done: 0, total: bots.length,
        bots: bots.map((one, index) => ({ rosterId: one.rosterId, name: FOUND.bots.find((found) => found.rosterId === one.rosterId)!.label, state: index ? "queued" : "moving", step: "chat", update: false })) };
      return state.progress;
    }),
    stop: vi.fn(async () => ({ ...state.progress!, state: "stopping" as const })),
    undoPreview: vi.fn(async () => ({ moveId: MOVE_ID, bots: [{ botId: "bot-r1", name: "Nova", newMessages: 3 }, { botId: "bot-r2", name: "Quill", newMessages: 0 }], updated: [] })),
    undo: vi.fn(async () => ({ removedBots: 2, removedConversations: 2, kept: [] })),
    request: vi.fn(async (rosterId: string) => ({ rosterId, url: `grokbot://app/v1/prompt?id=${rosterId}&text=Hi`, text: `Hi ${rosterId}`, file: "grok-bot-export-r1.md" })),
    accept: vi.fn(async () => ({ applied: [{ rosterId: "r1", botId: "bot-r1", name: "Nova", state: "arrived" as const, askedAt: 1, file: "x" }], problems: [] })),
  };
  return { client, state };
}

let host: HTMLDivElement, root: Root;
const onClose = vi.fn();
const opened: string[] = [];
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.body.querySelector<T>(selector);
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)];
const button = (label: string) => $$("button").find((node) => node.textContent === label) as HTMLButtonElement | undefined;
const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const press = async (target: HTMLElement | null | undefined) => { expect(target).toBeTruthy(); await act(async () => { target!.click(); }); await settle(); };
const title = () => $("#grok-move-title")?.textContent;
async function open(client: GrokMoveClient, at?: "result") {
  await act(async () => { root.render(createElement(GrokMoveDialog, { client, open: at ? { at } : {}, onClose })); });
  await settle();
}

beforeEach(() => {
  setLocale("en");
  opened.length = 0;
  vi.stubGlobal("duskDesktop", { remoteClient: { active: false }, openExternal: vi.fn(async (url: string) => { opened.push(url); }) });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("screen 1: what was found", () => {
  it("lists each live bot once with its look and what can come now; removed ones fold away; nothing is written yet", async () => {
    const { client } = fakeClient();
    await open(client);
    expect($("[data-grok-move]")?.getAttribute("data-grok-move")).toBe("preview");
    expect(title()).toBe("5 bots found on this Mac");
    expect($("#grok-move-line")?.textContent).toBe("Nothing changes in Grok Bot. Sign-ins and keys never move.");
    expect(document.activeElement, "focus lands on the title").toBe($("#grok-move-title"));
    const rows = $$("[data-grok-screen=preview] > section:first-of-type [data-grok-bot]");
    expect(rows.map((row) => row.querySelector("label span")?.textContent), "two bots of one name are told apart").toEqual(["Nova", "Quill", "Rivet", "Juno", "Nova (2)"]);
    expect($<HTMLImageElement>("[data-grok-bot=r1] img")?.getAttribute("src"), "its real picture").toBe("/api/setup-import/grok/move/photo?id=r1");
    const chips = (id: string) => $$(`[data-grok-bot=${id}] [data-grok-chip]`).map((chip) => chip.textContent);
    expect(chips("r1")).toEqual(["profile", "starting instructions", "last 200 messages", "2 routines (names)"]);
    expect(chips("r3"), "no description, no chat").toEqual(["profile"]);
    expect(chips("r4"), "a chat too new to read costs only that").toEqual(["profile", "starting instructions", "chat too new to read"]);
    const removed = $("[data-grok-removed]")!;
    expect(removed.textContent).toBe("1 bot you removed in Grok Bot");
    expect(removed.getAttribute("aria-expanded")).toBe("false");
    expect($<HTMLInputElement>("[data-grok-bot=r5] input")?.checked, "removed bots are unchecked").toBe(false);
    expect(button("Move 5 bots")).toBeTruthy();
    expect(client.start, "nothing is written before the button").not.toHaveBeenCalled();
  });

  it("chooses per bot and per item, and moves exactly what was chosen", async () => {
    const { client } = fakeClient();
    await open(client);
    await press($("[data-grok-all=none]"));
    expect(button("Choose bots to move")?.disabled).toBe(true);
    await press($("[data-grok-bot=r1] input"));
    await press($("[data-grok-bot=r2] input"));
    const expand = $<HTMLButtonElement>("[data-grok-bot=r1] button[aria-expanded]")!;
    await press(expand);
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect($("[data-grok-bot=r1]")?.textContent).toContain("The last 200 messages; earlier ones stay in Grok Bot.");
    await press($("[data-grok-bot=r1] [data-grok-switch=chat]"));
    expect($("[data-grok-bot=r3] [data-grok-switch=instructions]")?.hasAttribute("disabled"), "nothing to switch on without a description").toBe(true);
    await press(button("Move 2 bots"));
    expect(client.start).toHaveBeenCalledWith([{ rosterId: "r1", chat: false, instructions: true }, { rosterId: "r2", chat: true, instructions: true }]);
    expect($("[data-grok-move]")?.getAttribute("data-grok-move")).toBe("progress");
  });

  it("all already here: says so, unticks them, and offers Update", async () => {
    const here = { botId: "b", name: "x" };
    const { client } = fakeClient();
    client.detect.mockResolvedValue({ ...FOUND, bots: [{ ...QUILL, here }, { ...RIVET, here }] });
    await open(client);
    expect(title()).toBe("All 2 bots are already here");
    expect($$("[data-grok-chip=here]").map((chip) => chip.textContent)).toEqual(["Already here", "Already here"]);
    expect($<HTMLInputElement>("[data-grok-bot=r2] input")!.getAttribute("aria-label")).toBe("Update Quill");
    expect(button("Choose bots to move")?.disabled).toBe(true);
    await press($("[data-grok-bot=r2] input"));
    expect(button("Update 1 bot")).toBeTruthy();
  });

  it("nothing found, and away from the desktop app, each say so plainly", async () => {
    const { client } = fakeClient();
    client.detect.mockResolvedValue({ ...FOUND, found: false, bots: [] });
    await open(client);
    expect(title()).toBe("Grok Bot isn't on this Mac");
    await act(async () => root.unmount());
    root = createRoot(host);
    client.detect.mockResolvedValue({ available: false, reason: "notDesktop", found: false, bots: [], apps: [], problems: [], running: false, waiting: 0 });
    await open(client);
    expect($("[data-grok-move]")?.getAttribute("data-grok-move")).toBe("unavailable");
    expect($("#grok-move-line")?.textContent).toContain("only in the desktop app");
  });

  it("Escape and Not now close it", async () => {
    const { client } = fakeClient();
    await open(client);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    await press(button("Not now"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("screen 2: the move on its way", () => {
  it("names each bot's step, counts, stops after the bot being moved, and turns to the result when done", async () => {
    const { client, state } = fakeClient();
    await open(client);
    await press(button("Move 5 bots"));
    expect(title()).toBe("Moving your bots");
    expect($("[data-grok-row=r1]")?.textContent).toContain("Moving its recent chat…");
    expect($("[data-grok-row=r2]")?.textContent).toContain("Waiting its turn");
    expect($("[data-grok-count]")?.textContent).toBe("0 of 5");
    await press(button("Stop"));
    expect(client.stop).toHaveBeenCalled();
    state.progress = finished([doneRow("r1", "Nova"), { rosterId: "r2", name: "Quill", state: "stopped", update: false }], "stopped");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
    await settle();
    expect($("[data-grok-move]")?.getAttribute("data-grok-move")).toBe("result");
    expect(document.activeElement, "the new screen's title takes focus").toBe($("#grok-move-title"));
    expect($("[data-grok-left]")?.textContent).toContain("You stopped the move, so 1 bots didn't come.");
    expect(client.detect, "what is here is looked at again once the move is over").toHaveBeenCalledTimes(2);
  });

  it("a move still running when it is opened shows its progress, not a second preview", async () => {
    const { client, state } = fakeClient();
    state.detection = { ...FOUND, running: true };
    state.progress = { moveId: MOVE_ID, state: "running", startedAt: 1, done: 1, total: 2, bots: [doneRow("r1", "Nova"), { rosterId: "r2", name: "Quill", state: "moving", step: "picture", update: false }] };
    await open(client);
    expect($("[data-grok-move]")?.getAttribute("data-grok-move")).toBe("progress");
    expect($("[data-grok-row=r2]")?.textContent).toContain("Moving its picture…");
    expect($("[data-grok-count]")?.textContent).toBe("1 of 2");
  });
});

describe("screen 3: what came, and the rest", () => {
  const result = (waiting: GrokWaitingBot[] = []) => {
    const made = fakeClient();
    made.state.progress = finished([doneRow("r1", "Nova", { moved: { messages: 200, earlier: true, picture: true, instructions: true, routineNames: 2, appsUsed: 0 } }), doneRow("r2", "Quill"),
      { rosterId: "r3", name: "Rivet", state: "failed", update: false, error: "botLimit", message: "Your plan has no room for another bot." }]);
    made.state.waiting = { bots: waiting, waiting: waiting.filter((one) => one.state === "waiting").length };
    return made;
  };

  it("says what each bot brought, what stayed on purpose, and a failed bot can be tried again", async () => {
    const { client } = result();
    await open(client, "result");
    expect(title()).toBe("2 bots moved");
    expect($("[data-grok-row=r1]")?.textContent).toContain("profile, picture, starting instructions, last 200 messages, and 2 routines (names)");
    expect($("[data-grok-row=r3]")?.textContent).toContain("Your plan has no room for another bot.");
    const stayed = $("[data-grok-section=stayed]")!.textContent!;
    expect(stayed).toContain("Sign-ins and keys stay in Grok Bot.");
    expect(stayed).toContain("2 connected apps to connect again here: Calendar and Notebook.");
    expect(stayed).toContain("Earlier messages of 1 bot stayed in Grok Bot.");
    await press($("[data-grok-apps]"));
    expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "apps" });
    expect(onClose).toHaveBeenCalled();
    await press($("[data-grok-retry=r3]"));
    expect(client.start).toHaveBeenCalledWith([{ rosterId: "r3", chat: false, instructions: false }]);
  });

  it("asks a bot for the rest in Grok Bot, then waits, and the request can be copied instead", async () => {
    const { client, state } = result();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await open(client, "result");
    expect($("[data-grok-section=rest]")?.textContent).toContain("you press Enter");
    state.waiting = { bots: [{ rosterId: "r1", botId: "bot-r1", name: "Nova", state: "waiting", askedAt: 1, file: "grok-bot-export-r1.md" }], waiting: 1 };
    await press(button("Ask Nova for the rest"));
    expect(client.request).toHaveBeenCalledWith("r1");
    expect(opened, "the link opens through the app's own bridge, never here in a test").toEqual(["grokbot://app/v1/prompt?id=r1&text=Hi"]);
    expect($("[data-grok-ask-row=r1]")?.getAttribute("data-grok-ask-state")).toBe("waiting");
    expect($("[data-grok-ask-row=r1]")?.textContent).toContain("Waiting for Nova. Press Enter in Grok Bot.");
    expect($("[data-grok-section=rest]")?.textContent).toContain("Waiting for 1 bot.");
    await press(button("Copy the request instead"));
    expect(writeText).toHaveBeenCalledWith("Hi r1");
    expect($("[data-grok-ask-row=r1]")?.textContent).toContain("Copied");
  });

  it("walks every bot on one consent: opens each in turn and advances as each file arrives", async () => {
    const { client, state } = result();
    await open(client, "result");
    const change = async () => { await act(async () => { window.dispatchEvent(new Event("dusk:grok-move-changed")); }); await settle(); };
    // one consent before anything opens
    expect($("[data-grok-walk]")?.getAttribute("data-grok-walk")).toBe("idle");
    await press($("[data-grok-walk-start]"));
    expect($("[data-grok-walk]")?.getAttribute("data-grok-walk")).toBe("consent");
    expect($("[data-grok-walk-consent]")?.textContent).toContain("nothing sends on its own");
    expect(client.request, "nothing opens before the person agrees").not.toHaveBeenCalled();
    // agreeing opens the first bot and shows which one it is asking
    await press($("[data-grok-walk-go]"));
    expect(opened).toEqual(["grokbot://app/v1/prompt?id=r1&text=Hi"]);
    expect($("[data-grok-walk]")?.getAttribute("data-grok-walk")).toBe("asking");
    expect($("[data-grok-walk-progress]")?.textContent).toBe("Asking Nova… 1 of 2. Press Enter in Grok Bot.");
    // the first bot's file arrives, so the walk opens the next on its own
    state.waiting = { bots: [{ rosterId: "r1", botId: "bot-r1", name: "Nova", state: "arrived", askedAt: 1, file: "x" }, { rosterId: "r2", botId: "bot-r2", name: "Quill", state: "waiting", askedAt: 1, file: "y" }], waiting: 1 };
    await change();
    expect(opened).toEqual(["grokbot://app/v1/prompt?id=r1&text=Hi", "grokbot://app/v1/prompt?id=r2&text=Hi"]);
    expect($("[data-grok-walk-progress]")?.textContent).toBe("Asking Quill… 2 of 2. Press Enter in Grok Bot.");
    // the last file arrives and the walk ends
    state.waiting = { bots: [{ rosterId: "r1", botId: "bot-r1", name: "Nova", state: "arrived", askedAt: 1, file: "x" }, { rosterId: "r2", botId: "bot-r2", name: "Quill", state: "arrived", askedAt: 1, file: "y" }], waiting: 0 };
    await change();
    expect($("[data-grok-walk]"), "with every bot got, the walk is gone").toBeFalsy();
    expect(opened.length).toBe(2);
  });

  it("when Grok Bot cannot be opened, says so and offers the copy", async () => {
    const { client } = result();
    vi.stubGlobal("duskDesktop", { remoteClient: { active: false }, openExternal: vi.fn(async () => { throw new Error("no handler"); }) });
    await open(client, "result");
    await press(button("Ask Quill for the rest"));
    expect($("[data-grok-ask-row=r2]")?.textContent).toContain("Grok Bot didn't open. Copy the request");
  });

  it("an arrived file turns the row to Got it, with what still needs the person; a refused one says why", async () => {
    const applied = { at: 1, file: "grok-bot-export-r1.md", instructions: true, memories: 41, facts: 1, skills: 3, skillsOff: 3, routines: [{ name: "Monday plan", wasOn: true }],
      routinesToSet: [{ name: "Moon check", reason: "zone" }] as never, apps: ["Calendar"] };
    const { client } = result([
      { rosterId: "r1", botId: "bot-r1", name: "Nova", state: "arrived", askedAt: 1, file: "grok-bot-export-r1.md", applied },
      { rosterId: "r2", botId: "bot-r2", name: "Quill", state: "problem", askedAt: 1, file: "grok-bot-export-r2.md",
        problem: { file: "grok-bot-export-r2.md", code: "credentials", message: "x", keys: ["apps[0].api_key"] } },
    ]);
    await open(client, "result");
    const nova = $("[data-grok-ask-row=r1]")!;
    expect(nova.getAttribute("data-grok-ask-state")).toBe("arrived");
    expect(nova.textContent).toContain("Got it: instructions, 42 memories, 3 skills, and 1 routine (paused)");
    expect(nova.textContent).toContain("Needs you: 3 skills to check and switch on, 1 routine to give a time, and 1 app to connect again");
    const quill = $("[data-grok-ask-row=r2]")!;
    expect(quill.getAttribute("data-grok-ask-state")).toBe("problem");
    expect(quill.textContent).toContain("grok-bot-export-r2.md: It had passwords, tokens or keys in it (apps[0].api_key), so nothing in it was used.");
    expect(button("Ask again")).toBeTruthy();
  });

  it("a dropped export goes to its bot and says so", async () => {
    const { client } = result();
    await open(client, "result");
    const file = new File([JSON.stringify({ format: "grok-bot-export", version: 1, bots: [{ name: "Nova" }] })], "grok-bot-export-r1.md");
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [file], types: ["Files"] } });
    await act(async () => { $("[data-grok-move]")!.dispatchEvent(drop); });
    await settle();
    expect(client.accept).toHaveBeenCalledWith({ text: expect.stringContaining("grok-bot-export"), file: "grok-bot-export-r1.md" });
    expect($("[data-grok-said=done]")?.textContent).toBe("Got the rest for Nova.");
  });

  it("an interrupted move says so and moves the rest on one press", async () => {
    const { client, state } = fakeClient();
    state.progress = finished([doneRow("r1", "Nova"), { rosterId: "r2", name: "Quill", state: "queued", update: false }], "interrupted");
    await open(client);
    expect($("[data-grok-left=interrupted]")?.textContent).toContain("dusk bot closed during the move, so 1 bots didn't come.");
    await press($("[data-grok-rest]"));
    expect(client.start).toHaveBeenCalledWith([{ rosterId: "r2", chat: true, instructions: true }]);
  });
});

describe("undo", () => {
  it("shows exactly what goes, warns about new messages, and only then removes it", async () => {
    const { client, state } = fakeClient();
    state.progress = finished([doneRow("r1", "Nova"), doneRow("r2", "Quill")]);
    await open(client, "result");
    await press($("[data-grok-undo]"));
    expect(client.undoPreview).toHaveBeenCalledWith(MOVE_ID);
    expect(client.undo, "never before the person agrees").not.toHaveBeenCalled();
    expect(title()).toBe("Undo this move?");
    expect($("[data-grok-undo-warn]")?.textContent).toBe("Nova has 3 new messages since the move. They go too.");
    expect($("[data-grok-section=undo-bots]")?.textContent).toContain("2 bots will be removed");
    await press(button("Keep them"));
    expect($("[data-grok-move]")?.getAttribute("data-grok-move")).toBe("result");
    await press($("[data-grok-undo]"));
    await press(button("Undo the move"));
    expect(client.undo).toHaveBeenCalledWith(MOVE_ID);
    expect(title()).toBe("Move undone");
    expect($("[data-grok-screen=undone]")?.textContent).toContain("2 bots removed.");
  });
});
