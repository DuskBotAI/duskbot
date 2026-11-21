// @vitest-environment happy-dom
// The card above the first bot's message box while notes from another AI are on their way, and as they come: from
// Downloads, a dropped file or a paste it says it got them for about three seconds and goes; the first bot says it got
// them in its chat and its working row shows each step until its summary.
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ state: {} as Record<string, unknown>, api: vi.fn(), copy: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: vi.fn() }), api: f.api }));
vi.mock("@/lib/copy-text", () => ({ copyText: f.copy }));
vi.mock("@/lib/default-bot", async (original) => ({ ...(await original<typeof import("@/lib/default-bot")>()), useViewerEmail: () => null }));

import { setLocale } from "@/lib/i18n";
import { copyNotesPrompt, dismissNotesOffer, notesOffer, stopWaiting, takeNotesFromDownloads } from "@/lib/assistant-notes";
import { ARRIVAL_SHOWN_MS, noteArrival, notesWork, resetNotesArrivalForTests } from "@/lib/notes-arrival";
import { NotesWaitingLine, useNotesIntake } from "./NotesWaiting";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const maus = { id: "maus", name: "Dusk", threadId: "maus-thread", defaultBot: {}, messages: [] };
const atlas = { id: "atlas", name: "Atlas", threadId: "atlas-thread", messages: [] };
const NOTES = "---\nformat: dusk-bot-notes\nversion: 3\nfrom: ChatGPT\n---\n\n# Memories\n- Likes tea\n\nEND OF DUSK BOT NOTES\n";

let host: HTMLDivElement, root: Root;
let take: ReturnType<typeof useNotesIntake> | null = null;
const card = () => host.querySelector<HTMLElement>("[data-notes-waiting], [data-notes-arrived]");
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
function Harness({ botId }: { botId: string }) {
  const intake = useNotesIntake();
  useEffect(() => { take = intake; }, [intake]);
  return createElement(NotesWaitingLine, { botId });
}
const show = async (botId = "maus") => { await act(async () => root.render(createElement(Harness, { botId }))); };

beforeEach(() => {
  setLocale("en");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  resetNotesArrivalForTests();
  f.state = { bots: [maus, atlas], selectedId: "maus", config: { profile: {} } };
  f.copy.mockResolvedValue("copied");
  f.api.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  stopWaiting();
  dismissNotesOffer();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the notes card above the message box", () => {
  it("offers a notes file saved to Downloads before the prompt was copied, and brings it in when asked", async () => {
    vi.setSystemTime(new Date(2026, 10, 20, 12));
    await copyNotesPrompt();
    const saved = new Date(2026, 10, 17, 9).getTime();
    f.api.mockImplementation(async (path: string, init?: { body?: string }) => {
      if (path.startsWith("/api/setup-import/notes?")) return { files: [{ name: "dusk-bot-notes.md", modifiedAt: saved, text: NOTES }] };
      if (path === "/api/config") return { profile: JSON.parse(init!.body!).profile };
      if (path.includes("/memory/file?")) return { text: "" };
      return { ok: true };
    });
    await takeNotesFromDownloads({ bots: [maus as never], aboutMe: "", team: false, firstBotId: "maus", dispatch: vi.fn() });
    await show();
    const offer = host.querySelector<HTMLElement>("[data-notes-offer]");
    expect(offer?.textContent).toBe("Found dusk-bot-notes.md from Tuesday. Bring it in?Bring it in");
    expect(offer?.querySelector("[data-notes-dismiss]")?.getAttribute("aria-label")).toBe("Not this file");
    await show("atlas");
    expect(host.querySelector("[data-notes-offer]"), "only in the first bot's chat").toBeNull();
    await show();
    await act(async () => host.querySelector<HTMLElement>("[data-notes-bring]")!.click());
    await settle();
    expect(notesOffer()).toBeNull();
    expect(f.api).toHaveBeenCalledWith("/api/bots/maus/memory/file", expect.objectContaining({ method: "PUT" }));
  });


  it("while waiting: one short line, Copy the prompt and a close, in the first bot's chat only", async () => {
    await copyNotesPrompt();
    await show();
    expect(card()?.dataset.notesWaiting).toBe("");
    expect(card()?.textContent).toBe("Waiting for your notes. Paste or drop the file here.Copy the prompt");
    expect(card()?.querySelector("[data-notes-stop]")?.getAttribute("aria-label")).toBe("Stop waiting");
    await show("atlas");
    expect(card(), "no waiting card in another bot's chat").toBeNull();
  });

  it("says where the notes came from, for about three seconds, then goes, never back to waiting while the bot works", async () => {
    await copyNotesPrompt();
    await show();
    for (const [via, line] of [["downloads", "Got your notes from Downloads. Bringing everything in…"], ["drop", "Got your notes file. Bringing everything in…"], ["paste", "Got your pasted notes. Bringing everything in…"]] as const) {
      await act(async () => noteArrival(via, "maus"));
      expect(card()?.dataset.notesArrived).toBe(via);
      expect(card()?.textContent).toBe(line);
    }
    let finish!: () => void;
    f.api.mockImplementation((path: string, init?: { method?: string }) => (path.endsWith("/memory/file") && init?.method === "PUT"
      ? new Promise((resolve) => { finish = () => resolve({ ok: true }); }) : Promise.resolve({ message: {} })));
    await act(async () => take!(NOTES, undefined, "paste"));
    await settle();
    expect(card()?.textContent).toBe("Got your pasted notes. Bringing everything in…");
    // the first bot says it got them, and its working row shows the step
    expect(f.api).toHaveBeenCalledWith("/api/bots/maus/import-note", expect.objectContaining({ method: "POST", body: JSON.stringify({ from: ["ChatGPT"], start: true }) }));
    expect(notesWork()).toEqual({ botId: "maus", label: "Saving what you shared to memory…" });
    await act(async () => { vi.advanceTimersByTime(ARRIVAL_SHOWN_MS - 1); });
    expect(card()).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(card(), "gone after three seconds, and the waiting card stays away while the bot works").toBeNull();
    await act(async () => finish());
    await settle();
    expect(notesWork(), "the working row ends with the import").toBeNull();
    expect(f.api).toHaveBeenLastCalledWith("/api/bots/maus/import-note", expect.objectContaining({ method: "POST" }));
    expect(card(), "and the waiting is over").toBeNull();
  });

  it("notes pasted in another bot's chat: that bot says it got them, works through them and posts the summary; memory stays the first bot's", async () => {
    f.api.mockImplementation(async (path: string) => (path.includes("/memory/file?") ? { text: "" } : { message: {} }));
    await show("atlas");
    let work: unknown = null;
    f.api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path.endsWith("/memory/file") && init?.method === "PUT") work = notesWork();
      return path.includes("/memory/file?") ? { text: "" } : { message: {} };
    });
    await act(async () => take!(NOTES, undefined, "paste", "atlas"));
    await settle();
    const notes = f.api.mock.calls.filter(([path]) => String(path).endsWith("/import-note")).map(([path]) => path);
    expect(notes).toEqual(["/api/bots/atlas/import-note", "/api/bots/atlas/import-note"]);
    expect(work, "the working row is Atlas's").toMatchObject({ botId: "atlas" });
    expect(f.api).toHaveBeenCalledWith("/api/bots/maus/memory/file", expect.objectContaining({ method: "PUT" }));
    expect(card()?.dataset.notesArrived).toBe("paste");
  });

  it("a paste in another bot's chat says so there; the prompt pasted by mistake says what to do, longer", async () => {
    f.state = { ...f.state, selectedId: "atlas" };
    f.api.mockResolvedValue({});
    await show("atlas");
    await act(async () => take!("I'm moving to a new assistant\nfrom: <name of this app, e.g. ChatGPT>\nformat: dusk-bot-notes", undefined, "paste", "atlas"));
    expect(card()?.dataset.notesArrived).toBe("failed");
    expect(card()?.textContent).toMatch(/^That's the prompt itself/);
    await act(async () => { vi.advanceTimersByTime(ARRIVAL_SHOWN_MS); });
    expect(card(), "a failure stays long enough to read").not.toBeNull();
    await act(async () => (card()!.querySelector("[data-notes-dismiss]") as HTMLButtonElement).click());
    expect(card()).toBeNull();
  });
});
