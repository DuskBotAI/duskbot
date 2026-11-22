import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ api: vi.fn(), runBotMove: vi.fn(), copy: vi.fn() }));
vi.mock("@/state/store", () => ({ api: f.api }));
vi.mock("./bot-move", () => ({ runBotMove: f.runBotMove }));
vi.mock("./copy-text", () => ({ copyText: f.copy }));
vi.mock("./own-profile", () => ({ saveTeamProfile: vi.fn() }));
import { setLocale } from "@/lib/i18n";
import type { Action } from "@/state/store";
import { NOTES_FORMAT } from "../../shared/assistant-notes";
import { GrokImportError } from "../../shared/grok-import";
import {
  bringOfferedNotesIn, copyNotesPrompt, dismissNotesOffer, importNotes, notesOffer, looksLikeNotes, notesErrorLine, notesInFiles, notesOutcomeLine, notesWaiting, notesWatch, REMIND_AFTER_MS, scheduleNotesReminder, stopWaiting,
  takeNotesFromDownloads, WATCH_FOR_MS,
} from "./assistant-notes";

const memoryStorage = () => {
  const values = new Map<string, string>();
  return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, String(v)), removeItem: (k: string) => void values.delete(k) };
};
const notes = (extra: Record<string, unknown> = {}) => `\`\`\`json\n${JSON.stringify({
  format: NOTES_FORMAT, version: 1, from: "Claude", about_me: ["Name is Sam."], instructions: "Be brief.", memories: ["Bakery launch in March."],
  bots: [{ name: "Recipe helper", instructions: "Scale recipes." }], ...extra,
})}\n\`\`\``;

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("localStorage", memoryStorage());
  f.api.mockReset();
  f.runBotMove.mockReset();
  f.copy.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("waiting for notes from another AI", () => {
  it("starts on a copy, keeps its first start on a second copy, and stops", async () => {
    f.copy.mockResolvedValue("copied");
    expect(await copyNotesPrompt(1_000)).toBe(true);
    expect(await copyNotesPrompt(9_000)).toBe(true);
    expect(notesWaiting()).toEqual({ since: 1_000 });
    stopWaiting();
    expect(notesWaiting()).toBeNull();
    f.copy.mockResolvedValue("failed");
    expect(await copyNotesPrompt()).toBe(false);
    expect(notesWaiting(), "nothing to wait for when the copy failed").toBeNull();
  });

  it("reminds once, 15 minutes after the copy, only while still waiting", async () => {
    vi.useFakeTimers();
    f.copy.mockResolvedValue("copied");
    await copyNotesPrompt(Date.now());
    const show = vi.fn();
    scheduleNotesReminder(show);
    vi.advanceTimersByTime(REMIND_AFTER_MS - 1);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledOnce();
    scheduleNotesReminder(show);
    vi.advanceTimersByTime(REMIND_AFTER_MS * 2);
    expect(show, "never a second time").toHaveBeenCalledOnce();
  });

  it("doesn't remind late for a copy made before the app was closed, or after the notes came", async () => {
    vi.useFakeTimers();
    f.copy.mockResolvedValue("copied");
    await copyNotesPrompt(Date.now() - REMIND_AFTER_MS * 4);
    const show = vi.fn();
    scheduleNotesReminder(show);
    vi.advanceTimersByTime(REMIND_AFTER_MS);
    expect(show).not.toHaveBeenCalled();
    stopWaiting();
    await copyNotesPrompt(Date.now());
    scheduleNotesReminder(show);
    stopWaiting();
    vi.advanceTimersByTime(REMIND_AFTER_MS);
    expect(show).not.toHaveBeenCalled();
  });
});

describe("bringing notes in", () => {
  it("puts facts and instructions in About me, memories in the first bot's memory, and makes a bot for each of its own", async () => {
    f.copy.mockResolvedValue("copied");
    await copyNotesPrompt();
    f.api.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === "/api/config") return { profile: JSON.parse(init!.body!).profile };
      if (path.startsWith("/api/bots/dusk/memory/file?")) return { text: "" };
      if (path === "/api/mcp/servers") return { servers: [] };
      return { ok: true };
    });
    f.runBotMove.mockResolvedValue([{ report: { bots: [{ id: "r" }], failed: [] } }]);
    const dispatch = vi.fn();
    const outcome = await importNotes(`Here you go:\n${notes()}`, { bots: [], aboutMe: "I bake.", team: false, firstBotId: "dusk", dispatch });
    const about = JSON.parse(f.api.mock.calls.find(([path]) => path === "/api/config")![1].body).profile.aboutMe;
    expect(about).toMatch(/^I bake\.\n\n- \d{4}-\d{2}-\d{2} · learned by Claude · Name is Sam\./);
    expect(about).toContain("Be brief.");
    const memory = JSON.parse(f.api.mock.calls.find(([path, init]) => path === "/api/bots/dusk/memory/file" && init?.method === "PUT")![1].body);
    expect(memory.path).toBe("memory/notes-from-claude.md");
    expect(f.runBotMove.mock.calls[0]![0].apps[0].preview.plans.map((plan: { name: string }) => plan.name)).toEqual(["Recipe helper"]);
    expect(dispatch).toHaveBeenCalledWith({ type: "profileSaved", profile: { aboutMe: about } });
    expect(notesOutcomeLine(outcome)).toBe("Brought in from Claude: 2 things about you, 1 memory, and 1 bot.");
    expect(notesWaiting(), "the waiting ends once they came in").toBeNull();
  });

  it("keeps open threads in the first bot's notes, adds a later part's memories to the bot an earlier part made, and says so in its chat", async () => {
    const recipe = { name: "Recipe helper", instructions: "", memories: ["Sam bakes sourdough."] };
    const { grokMovePlan } = await import("../../shared/grok-import");
    const { readBot } = await import("../../shared/grok-import");
    const packageId = grokMovePlan(readBot({ name: "Recipe helper", instructions: "Scale recipes." }), { from: { name: "Claude", key: "claude" } }).packageId;
    const topics = new Map<string, string>();
    f.api.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === "/api/config") return { profile: JSON.parse(init!.body!).profile };
      const read = /^\/api\/bots\/(\w+)\/memory\/file\?path=(.+)$/.exec(path);
      if (read) return { text: topics.get(`${read[1]}:${decodeURIComponent(read[2]!)}`) ?? "" };
      if (path.endsWith("/memory/file") && init?.method === "PUT") {
        const body = JSON.parse(init.body!);
        topics.set(`${path.split("/")[3]}:${body.path}`, body.text);
      }
      if (path === "/api/mcp/servers") return { servers: [] };
      return { ok: true };
    });
    f.runBotMove.mockResolvedValue([{ report: { bots: [], failed: [] } }]);
    const part2 = notes({ version: 2, about_me: { basics: ["Name is Sam."] }, memories: [], open_threads: ["Pick a payment provider."], bots: [recipe] });
    const outcome = await importNotes(part2, {
      bots: [{ id: "recipe", name: "Recipe helper", installedPackage: { id: packageId } } as never], aboutMe: "", team: false, firstBotId: "dusk", dispatch: vi.fn(),
    });
    expect(topics.get("dusk:memory/open-threads-from-claude.md")).toContain("- Pick a payment provider.");
    expect(topics.get("recipe:memory/notes-from-claude.md"), "the bot from part 1 gets part 2's memories").toContain("- Sam bakes sourdough.");
    expect(outcome).toMatchObject({ threads: 1, joined: 1, bots: 0 });
    expect(notesOutcomeLine(outcome)).toBe("Brought in from Claude: 2 things about you, 1 open thread, and 1 bot already here, with more.");
    await vi.waitFor(() => expect(f.api).toHaveBeenCalledWith("/api/bots/dusk/import-note", expect.objectContaining({ method: "POST" })));
    const said = f.api.mock.calls.filter(([path]) => path === "/api/bots/dusk/import-note").map(([, init]) => JSON.parse(init.body));
    expect(said[0], "first it says it got them").toEqual({ from: ["Claude"], start: true });
    const note = said.at(-1);
    expect(note).toMatchObject({ from: ["Claude"], facts: 2, threads: 1, joined: 1 });
  });

  it("answers its own \"setting up\" note when nothing in the notes was new, and says when they were cut off", async () => {
    const topics = new Map<string, string>();
    f.api.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === "/api/config") return { profile: JSON.parse(init!.body!).profile };
      const read = /^\/api\/bots\/(\w+)\/memory\/file\?path=(.+)$/.exec(path);
      if (read) return { text: topics.get(decodeURIComponent(read[2]!)) ?? "" };
      if (path.endsWith("/memory/file") && init?.method === "PUT") topics.set(JSON.parse(init.body!).path, JSON.parse(init.body!).text);
      return { ok: true };
    });
    const said = () => f.api.mock.calls.filter(([path]) => path === "/api/bots/dusk/import-note").map(([, init]) => JSON.parse(init.body));
    let about = "";
    const context = () => ({ bots: [], aboutMe: about, team: false, firstBotId: "dusk", dispatch: (action: Action) => { if (action.type === "profileSaved") about = action.profile.aboutMe ?? about; } });
    const text = notes({ bots: [] });
    await importNotes(text, context());
    f.api.mockClear();
    const again = await importNotes(text, context());
    expect(notesOutcomeLine(again)).toBe("Nothing new from Claude. It was all here already.");
    expect(said()).toEqual([{ from: ["Claude"], start: true }, expect.objectContaining({ from: ["Claude"], nothingNew: true, failed: false })]);
    f.api.mockClear();
    const cut = `\`\`\`json\n{"format":"${NOTES_FORMAT}","version":1,"from":"Gemini","memories":["Bakes on Sundays.","Grows tomatoes."],"about_me":["Name is Sa`;
    expect((await importNotes(cut, context())).partial).toBe(true);
    expect(said().at(-1)).toMatchObject({ from: ["Gemini"], memories: 2, partial: true });
  });

  it("takes the same notes pasted twice at once as one import", async () => {
    f.api.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === "/api/config") return { profile: JSON.parse(init!.body!).profile };
      if (path.includes("/memory/file?")) return { text: "" };
      if (path === "/api/mcp/servers") return { servers: [] };
      return { ok: true };
    });
    f.runBotMove.mockImplementation(async () => [{ report: { bots: [{ id: "r", name: "Recipe helper", routines: 0 }], failed: [] } }]);
    const context = { bots: [], aboutMe: "", team: false, firstBotId: "dusk", dispatch: vi.fn() };
    const [first, second] = await Promise.all([importNotes(notes(), context), importNotes(notes(), context, { via: "drop" })]);
    expect(second).toBe(first);
    expect(f.runBotMove).toHaveBeenCalledOnce();
    expect(f.api.mock.calls.filter(([path, init]) => path === "/api/bots/dusk/import-note" && JSON.parse(init.body).start)).toHaveLength(1);
    await importNotes(notes(), context);
    expect(f.runBotMove, "once it is done, the same notes may come in again").toHaveBeenCalledTimes(2);
  });

  it("keeps About me's long facts, and those past its share, word for word in the first bot's memory, and says so", async () => {
    const syllables = ["ka", "lo", "mi", "ren", "tu", "vash", "or", "bel", "quin", "sa", "dro", "pel", "nix", "gru", "fen", "hol", "zar", "wim", "ju", "po"];
    const word = (n: number) => `${syllables[n % 20]}${syllables[Math.floor(n / 20) % 20]}${syllables[Math.floor(n / 400) % 20]}`;
    const words = (from: number, count: number) => Array.from({ length: count }, (_, k) => word(from * 37 + k * 11)).join(" ");
    const short = Array.from({ length: 82 }, (_, i) => `Fact ${i}: ${words(i, 6)}.`);
    const long = Array.from({ length: 10 }, (_, i) => `Long fact ${i}: ${words(500 + i * 13, 70)}.`);
    const topics = new Map<string, string>();
    f.api.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === "/api/config") return { profile: JSON.parse(init!.body!).profile };
      const read = /^\/api\/bots\/(\w+)\/memory\/file\?path=(.+)$/.exec(path);
      if (read) return { text: topics.get(decodeURIComponent(read[2]!)) ?? "" };
      if (path.endsWith("/memory/file") && init?.method === "PUT") topics.set(JSON.parse(init.body!).path, JSON.parse(init.body!).text);
      return { ok: true };
    });
    const outcome = await importNotes(notes({ about_me: [...long, ...short], instructions: "", bots: [] }), { bots: [], aboutMe: "", team: false, firstBotId: "dusk", dispatch: vi.fn() });
    const kept = topics.get("memory/about-you-from-claude.md")!;
    for (const fact of [...long, ...short.slice(-2)]) expect(kept).toContain(`- ${fact}\n`);
    expect(outcome).toMatchObject({ facts: 80, aboutInMemory: 12 });
    expect(notesOutcomeLine(outcome)).toBe("Brought in from Claude: 80 things about you, 12 more things about you, kept in memory, and 1 memory.");
    const note = JSON.parse(f.api.mock.calls.findLast(([path]) => path === "/api/bots/dusk/import-note")![1].body);
    expect(note).toMatchObject({ facts: 80, aboutInMemory: 12 });
  });

  it("makes the person's own routines real, paused routines and their skills switched-off skills of the first bot, once", async () => {
    const routines: Array<Record<string, unknown>> = [];
    const skills: Array<{ name: string }> = [];
    f.api.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === "/api/config") return { profile: JSON.parse(init!.body!).profile };
      if (path === "/api/routines" && init?.method === "POST") { routines.push({ ...JSON.parse(init.body!), id: `r${routines.length}` }); return { routine: {} }; }
      if (path === "/api/routines") return { routines };
      if (path === "/api/bots/dusk/skills") return { skills };
      if (path === "/api/bots/dusk/skill-template") { skills.push({ name: JSON.parse(init!.body!).name }); return { installed: {} }; }
      return { ok: true };
    });
    const md = [
      "---", "format: dusk-bot-notes", "version: 3", "from: Gemini", "---", "",
      "# Routines", "## Morning brief", "- Cron: 0 8 * * 1-5", "- Time zone: Europe/Lisbon", "~~~text", "Summarize my inbox.", "~~~",
      "## Someday", "- Schedule: whenever it rains", "~~~text", "Tell me to take an umbrella.", "~~~",
      "# Skills", "## Tone check", "- When to use: before I send an email", "~~~text", "Flag anything curt.", "~~~", "", "END OF DUSK BOT NOTES",
    ].join("\n");
    const context = { bots: [], aboutMe: "", team: false, firstBotId: "dusk", dispatch: vi.fn() };
    const outcome = await importNotes(md, context);
    expect(routines).toEqual([{ id: "r0", botId: "dusk", name: "Morning brief", prompt: "Summarize my inbox.", enabled: false, schedule: { type: "cron", expression: "0 8 * * 1-5", timeZone: "Europe/Lisbon" } }]);
    const skill = JSON.parse(f.api.mock.calls.find(([path]) => path === "/api/bots/dusk/skill-template")![1].body);
    expect(skill).toMatchObject({ name: "tone-check", description: "before I send an email", enabled: false, source: "notes from Gemini" });
    expect(skill.text).toContain("Flag anything curt.");
    expect(outcome).toMatchObject({ routines: 1, skills: 1, threads: 1 });
    expect(notesOutcomeLine(outcome)).toBe("Brought in from Gemini: 1 open thread, 1 paused routine, and 1 skill.");
    const again = await importNotes(md, context);
    expect(routines, "the same file twice makes nothing twice").toHaveLength(1);
    expect(skills).toHaveLength(1);
    expect(again).toMatchObject({ routines: 1, skills: 0 });
  });

  it("says what went wrong in plain words, and what a cut-off paste still brought", async () => {
    expect(notesErrorLine(new GrokImportError("cutOff"))).toBe("That answer looks cut off. Ask for the rest in the same shape, then paste it too.");
    expect(notesErrorLine(new Error("boom"))).toBe("Couldn't bring in your notes. Try pasting them again.");
    expect(notesOutcomeLine({ from: "Gemini", facts: 0, memories: 0, bots: 0, failed: [], partial: true }))
      .toBe("Nothing new from Gemini. It was all here already. The end was cut off. Ask for the rest and paste it here too.");
  });

  it("finds notes among dropped files, skipping other kinds and other text", async () => {
    const file = (name: string, text: string) => ({ name, size: text.length, text: async () => text });
    expect(await notesInFiles([file("photo.png", notes()), file("readme.md", "# hi {"), file("claude-notes.json", notes())]))
      .toEqual({ names: ["claude-notes.json"], text: notes() });
    expect(await notesInFiles([file("readme.md", "plain")])).toBeNull();
    // the file the prompt asks for now: markdown with front matter, dropped or picked into any chat
    const md = "---\nformat: dusk-bot-notes\nversion: 3\nfrom: Grok\n---\n\n# Memories\n- Likes tea\n\nEND OF DUSK BOT NOTES\n";
    expect(looksLikeNotes(md)).toBe(true);
    expect(await notesInFiles([file("notes.md", "# my notes\n- nothing here"), file("dusk-bot-notes.md", md)])).toEqual({ names: ["dusk-bot-notes.md"], text: md });
  });
});

describe("the notes file in Downloads", () => {
  const context = () => ({ bots: [], aboutMe: "", team: false, firstBotId: "dusk", dispatch: vi.fn() });
  const serve = (files: Array<{ name: string; modifiedAt: number; text: string }>) => f.api.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (path.startsWith("/api/setup-import/notes?")) return { files };
    if (path === "/api/config") return { profile: JSON.parse(init!.body!).profile };
    if (path.includes("/memory/file?")) return { text: "" };
    if (path === "/api/mcp/servers") return { servers: [] };
    return { ok: true };
  });

  it("is never looked for before the prompt was copied, then only from that moment", async () => {
    serve([]);
    expect(await takeNotesFromDownloads(context())).toBeNull();
    expect(f.api, "no copy, no look at Downloads").not.toHaveBeenCalled();
    f.copy.mockResolvedValue("copied");
    await copyNotesPrompt(5_000);
    await takeNotesFromDownloads(context(), 6_000);
    expect(f.api, "the first look also sees a file saved before the copy").toHaveBeenCalledWith("/api/setup-import/notes?since=1", expect.anything());
    f.api.mockClear();
    await takeNotesFromDownloads(context(), 7_000);
    expect(f.api).toHaveBeenCalledWith("/api/setup-import/notes?since=5000", expect.anything());
    f.api.mockClear();
    expect(await takeNotesFromDownloads(context(), 5_000 + WATCH_FOR_MS + 1), "the watch ends").toBeNull();
    expect(f.api).not.toHaveBeenCalled();
  });

  it("brings a new file in by itself, once, and the first bot says it found it in Downloads", async () => {
    f.copy.mockResolvedValue("copied");
    await copyNotesPrompt(1_000);
    f.runBotMove.mockResolvedValue([{ report: { bots: [], failed: [] } }]);
    serve([{ name: "dusk-bot-notes.json", modifiedAt: 2_000, text: notes({ bots: [] }) }]);
    const outcome = await takeNotesFromDownloads(context(), 3_000);
    expect(outcome).toMatchObject({ from: "Claude", memories: 1 });
    await vi.waitFor(() => expect(f.api).toHaveBeenCalledWith("/api/bots/dusk/import-note", expect.anything()));
    expect(JSON.parse(f.api.mock.calls.findLast(([path]) => path === "/api/bots/dusk/import-note")![1].body)).toMatchObject({ via: "downloads", from: ["Claude"] });
    expect(notesWatch()!.taken).toEqual(["dusk-bot-notes.json:2000"]);
    f.api.mockClear();
    expect(await takeNotesFromDownloads(context(), 4_000), "the same file never twice").toBeNull();
    expect(f.api.mock.calls.filter(([path]) => String(path).includes("/memory/file"))).toEqual([]);
  });

  it("offers a file saved before the prompt was copied, bringing it in only when asked, once", async () => {
    f.copy.mockResolvedValue("copied");
    await copyNotesPrompt(5_000);
    f.runBotMove.mockResolvedValue([{ report: { bots: [], failed: [] } }]);
    serve([{ name: "dusk-bot-notes.md", modifiedAt: 1_000, text: notes({ bots: [] }) }]);
    expect(await takeNotesFromDownloads(context(), 6_000), "not brought in by itself").toBeNull();
    expect(f.api.mock.calls.filter(([path]) => String(path).includes("/memory/file"))).toEqual([]);
    expect(notesOffer()).toMatchObject({ name: "dusk-bot-notes.md", modifiedAt: 1_000 });
    expect(await takeNotesFromDownloads(context(), 7_000)).toBeNull();
    const outcome = await bringOfferedNotesIn(context());
    expect(outcome).toMatchObject({ from: "Claude", memories: 1 });
    expect(notesOffer()).toBeNull();
    expect(notesWatch()!.taken).toEqual(["dusk-bot-notes.md:1000"]);
  });

  it("a file offered and turned down is not offered again", async () => {
    f.copy.mockResolvedValue("copied");
    await copyNotesPrompt(5_000);
    serve([{ name: "dusk-bot-notes.md", modifiedAt: 1_000, text: notes({ bots: [] }) }]);
    await takeNotesFromDownloads(context(), 6_000);
    dismissNotesOffer();
    expect(notesOffer()).toBeNull();
    await copyNotesPrompt(8_000);
    await takeNotesFromDownloads(context(), 9_000);
    expect(notesOffer()).toBeNull();
    expect(f.runBotMove).not.toHaveBeenCalled();
  });
});

