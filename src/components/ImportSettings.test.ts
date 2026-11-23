// @vitest-environment happy-dom
// Settings → general → bring in from other apps: the Grok Bot row, what this computer holds (BringIn), then the first run's
// prompt for AIs online.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { bringRunNow, resetBringRunForTests } from "@/lib/first-run-import";
import type { SetupDetection } from "../../shared/setup-import";

const f = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn(), api: vi.fn(),
  grok: { detect: {} as unknown, waiting: { bots: [], waiting: 0 } as unknown, last: null as unknown } }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: f.api }));
vi.mock("@/state/api", () => ({ api: f.api }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/components/Avatar", () => ({ BotAvatar: () => null, MausAvatar: () => null }));
vi.mock("@/lib/default-bot", async (original) => ({ ...(await original<typeof import("@/lib/default-bot")>()), useViewerEmail: () => null }));
const { ImportSettings } = await import("./ImportSettings");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const maus = { id: "maus", name: "Dusk", defaultBot: {}, messages: [] };
const molty = { source: "openclaw", app: "OpenClaw", where: "~/.openclaw", channels: [], unreadable: [], bots: [{
  name: "Molty", title: "", description: "", instructions: "Be helpful.", memories: ["Sam's sister is Ana."], userFacts: [], skills: [], routines: [], apps: [],
}] };
const grokBot = (rosterId: string, name: string, here?: boolean) => ({ rosterId, name, label: name, description: "", hasDescription: false, look: { color: "blue" },
  removed: false, chat: { messages: 3, earlier: false, readable: true }, routines: 0, ...(here ? { here: { botId: `b-${rosterId}`, name } } : {}) });
const SETUP: SetupDetection = { skills: [{ name: "pdf", source: "claudeCode" }], tools: [] };

let host: HTMLDivElement, root: Root;
const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label);
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const client = (detection: SetupDetection) => ({
  detect: vi.fn(async () => detection),
  apply: vi.fn(async () => ({ skills: { added: ["pdf"], present: [], skipped: [], filesLeftOut: 0, review: [] }, tools: { added: [], present: [], skipped: [] } })),
});
async function show(options: { local?: boolean; detection?: SetupDetection } = {}) {
  if (options.local !== false) vi.stubGlobal("duskDesktop", { remoteClient: { active: false } });
  const setup = client(options.detection ?? SETUP);
  await act(async () => root.render(createElement(ImportSettings, { client: setup })));
  await settle();
  return setup;
}

beforeEach(() => {
  setLocale("en");
  resetBringRunForTests();
  f.state = { bots: [maus], config: { profile: {} } };
  f.dispatch = vi.fn();
  f.grok = { detect: { available: true, found: false, bots: [], apps: [], problems: [], running: false, waiting: 0 }, waiting: { bots: [], waiting: 0 }, last: null };
  f.api.mockReset();
  f.api.mockImplementation(async (path: string, init?: { body?: string; method?: string }) => {
    if (path === "/api/setup-import/bots") return { apps: [molty] };
    if (path === "/api/setup-import/grok/move/detect") return f.grok.detect;
    if (path === "/api/setup-import/grok/move/waiting") return f.grok.waiting;
    if (path === "/api/setup-import/grok/move/progress") return f.grok.last;
    if (path.startsWith("/api/setup-import/grok")) throw new Error("the old Grok Bot look is gone");
    if (path === "/api/mcp/servers") return { servers: [] };
    if (path.startsWith("/api/teams/import")) return { bots: [{ id: `id-${JSON.parse(init!.body!).package.name}`, name: JSON.parse(init!.body!).package.name }], routines: [] };
    return {};
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Settings → bring in from other apps", () => {
  it("lists everything this computer holds, with the prompt for AIs online folded below", async () => {
    await show();
    expect(f.api.mock.calls.map(([path]) => path), "Grok Bot is its own move's, never the old look").not.toContain("/api/setup-import/grok");
    expect(host.querySelector("[data-grok-entry]"), "no Grok Bot on this Mac: no row").toBeNull();
    expect(host.querySelector("[data-bring-hero]"), "nothing here is really used: no memory source").toBeNull();
    expect([...host.querySelectorAll("[data-bring-find]")].map((row) => row.getAttribute("data-bring-find")).sort(), "everything is reachable here")
      .toEqual(["bots:openclaw", "setup:claudeCode"]);
    expect(host.querySelector('[data-bring-import="bots:openclaw"]')?.getAttribute("aria-label")).toBe("Import from OpenClaw");
    expect(host.querySelector("[data-bring-more], [data-bring-memory]"), "no Show more, no notes checkbox").toBeNull();
    const online = host.querySelector<HTMLButtonElement>("[data-bring-online]")!;
    expect(online.textContent, "below what is here, the prompt is one quiet line").toBe("From ChatGPT, Claude, Gemini or another AI");
    expect(online.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { online.click(); });
    expect(online.getAttribute("aria-expanded")).toBe("true");
    expect(button("Copy the prompt")).toBeTruthy();
    expect(host.querySelector("[data-bring-ai], [data-bring-paste], textarea"), "no AI to pick, no answer box").toBeNull();
    expect(host.querySelector("[data-bring-grok]"), "Grok Bot's bots no longer go through the prompt").toBeNull();
    for (const old of ["Copy the prompt for Grok Bot", "Start import", "Copy prompt", "Look for bots"]) expect(button(old), old).toBeUndefined();
    expect(host.querySelector("[data-import-section=grok], [data-import-section=notes], [data-import-section=apps], [data-import-section=bots]")).toBeNull();
    expect(host.querySelector("[data-bring-skip], [data-bring-next]"), "no funnel buttons").toBeNull();
  });

  it("brings one app in on its own Bring in, says how it went on the page, and marks it imported", async () => {
    const setup = await show();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-bring-import="bots:openclaw"]')!.click(); });
    await settle();
    expect(setup.apply, "only that app's things").not.toHaveBeenCalled();
    const imported = f.api.mock.calls.filter(([path]) => String(path).startsWith("/api/teams/import")).map(([, init]) => JSON.parse(init.body).package.name);
    expect(imported).toEqual(["Molty"]);
    expect(host.querySelector("[data-bring-run]")?.textContent).toBe("Your bots now know 1 thing about you. Also brought in 1 bot.");
    expect(host.querySelector('[data-bring-find="bots:openclaw"]')?.getAttribute("data-bring-state")).toBe("done");
    expect(host.querySelector('[data-bring-import="bots:openclaw"]'), "no second import of the same").toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-bring-import="setup:claudeCode"]')!.click(); });
    await settle();
    expect(setup.apply).toHaveBeenCalledWith({ skills: true, tools: true, sources: ["claudeCode"] });
    expect(host.querySelector('[data-bring-find="setup:claudeCode"]')?.getAttribute("data-bring-state")).toBe("done");
  });

  it("leads with the app really used, its memory always coming, and its own confirmation", async () => {
    const detection: SetupDetection = { ...SETUP, memory: [{ source: "claudeCode", files: 4, notes: 30, topics: { preferences: true, aboutYou: true, workStyle: false, projects: 0 } }],
      usage: { claudeCode: 14 } };
    const setup = await show({ detection });
    const hero = host.querySelector("[data-bring-hero]")!;
    expect(hero.getAttribute("data-bring-find")).toBe("setup:claudeCode");
    expect(hero.textContent).toContain("It's learned your preferences and who you are.");
    setup.apply.mockResolvedValueOnce({ skills: { added: ["pdf"], present: [], skipped: [], filesLeftOut: 0, review: [] }, tools: { added: [], present: [], skipped: [] }, memory: { added: 30, sources: ["claudeCode"], failed: false } } as never);
    await act(async () => { hero.querySelector<HTMLButtonElement>("[data-bring-import]")!.click(); });
    await settle();
    expect(setup.apply).toHaveBeenCalledWith({ skills: true, tools: true, sources: ["claudeCode"], memory: true, memoryBot: maus.id });
    expect(host.querySelector("[data-bring-said]")?.textContent).toBe("Done. Your bots now know 30 things about you.");
  });

  it("forgets a bringing in that finished before the page opened", async () => {
    await show();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-bring-import="setup:claudeCode"]')!.click(); });
    await settle();
    expect(bringRunNow().kind).toBe("done");
    await act(async () => root.unmount());
    root = createRoot(host);
    await show();
    expect(bringRunNow().kind).toBe("idle");
    expect(host.querySelector('[data-bring-import="setup:claudeCode"]')).toBeTruthy();
  });

  it("away from this computer's own desktop app, reads nothing here and offers the prompt straight away", async () => {
    await show({ local: false });
    expect(f.api.mock.calls.filter(([path]) => String(path).startsWith("/api/setup-import"))).toEqual([]);
    expect(host.querySelector("[data-bring-looking]")).toBeNull();
    expect(host.querySelector("[data-bring-find]")).toBeNull();
    expect(host.querySelector("[data-bring-prompt] pre")?.textContent).toContain("dusk-bot-notes");
    expect(button("Copy the prompt")).toBeTruthy();
    expect(button("Import all")).toBeUndefined();
  });

  it("takes the notes another AI wrote when they are pasted on the page, and says so there", async () => {
    await show({ local: false });
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => JSON.stringify({ format: "dusk-bot-notes", version: 2, from: "ChatGPT", about_me: { basics: ["I live in Pune."] } }) } });
    await act(async () => { host.dispatchEvent(paste); });
    expect(paste.defaultPrevented, "nothing behind gets it").toBe(true);
    await settle();
    expect(host.querySelector("[data-bring-notes]")).not.toBeNull();
    expect(host.querySelector("[data-bring-notes]")?.textContent).toMatch(/ChatGPT|notes/);
  });

  it("has a row for Grok Bot: its bots one press from the move, then the bots still to send the rest, then already here", async () => {
    f.grok.detect = { available: true, found: true, bots: [grokBot("g1", "Nova"), grokBot("g2", "Quill"), grokBot("g3", "Rivet", true)], apps: [], problems: [], running: false, waiting: 0 };
    await show();
    const opened = vi.fn((event: Event) => event);
    window.addEventListener("dusk:open-grok-move", opened);
    const row = () => host.querySelector("[data-grok-entry=settings]")!;
    expect(row().textContent).toContain("3 bots, ready to move here. 1 already here.");
    expect(host.querySelector("[data-import-section]")!.firstElementChild?.nextElementSibling, "first, under the page's line").toBe(row());
    await act(async () => { button("Move them")!.click(); });
    expect(opened).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    root = createRoot(host);
    f.grok.detect = { ...(f.grok.detect as object), bots: [grokBot("g1", "Nova", true), grokBot("g2", "Quill", true)] };
    f.grok.last = { moveId: "m", state: "done", startedAt: 1, done: 2, total: 2, bots: [] };
    f.grok.waiting = { bots: [], waiting: 2 };
    await show();
    expect(row().textContent, "asked bots are awaited, across restarts").toContain("Waiting for 2 bots to send the rest.");
    await act(async () => { button("Open")!.click(); });
    expect(opened).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
    root = createRoot(host);
    f.grok.waiting = { bots: [], waiting: 0 };
    await show();
    expect(row().textContent, "after a move, already here rather than nothing found").toContain("2 bots, already here.");
    window.removeEventListener("dusk:open-grok-move", opened);
  });

  it("away from the desktop app, says in one line why Grok Bot's bots cannot move from here", async () => {
    await show({ local: false });
    expect(host.querySelector("[data-grok-entry=notDesktop]")?.textContent).toBe("Bots move straight from Grok Bot only in the desktop app, on the Mac where Grok Bot is. Here, use the prompt below.");
    expect(f.api.mock.calls.filter(([path]) => String(path).includes("/grok/"))).toEqual([]);
  });
});
