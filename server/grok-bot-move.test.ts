import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { grokExportFileName, GROK_PROMPT_URL_MAX, GROK_SECTION } from "../shared/grok-move.ts";
import { GROK_SENTINEL, SYNTHETIC_BOTS, syntheticExport } from "./testing/grok-bot-profile.ts";
import { grokMoveFixture, removeGrokMoveFixtures } from "./testing/grok-move-fixture.ts";

type Fixture = Awaited<ReturnType<typeof grokMoveFixture>>;
let app: Fixture | null = null;
afterAll(removeGrokMoveFixtures);
afterEach(async () => {
  await app?.close();
  app = null;
});

const [NOVA, QUILL, RIVET, TALLY, ECHO, NOVA_TWO, JUNO] = SYNTHETIC_BOTS.map((bot) => bot.id) as [string, string, string, string, string, string, string];

async function moved(choices: Array<{ rosterId: string; chat?: boolean; instructions?: boolean }>) {
  const progress = app!.mover.start(choices);
  await app!.mover.settled();
  return { started: progress, finished: app!.mover.progress()! };
}

describe("finding Grok Bot's bots", () => {
  it("shows names, descriptions, counts and pictures, never chat text or login material", async () => {
    app = await grokMoveFixture();
    const found = app.mover.detect();
    const text = JSON.stringify(found);
    expect(text).not.toContain("Invented question");
    expect(text).not.toContain("Invented answer");
    expect(text).not.toContain(GROK_SENTINEL);
    expect(found).toMatchObject({ available: true, found: true, apps: ["Calendar", "Notebook"], running: false, waiting: 0 });
    const nova = found.bots.find((bot) => bot.rosterId === NOVA)!;
    expect(nova).toMatchObject({ label: "Nova", look: { color: "purple", body: "goo", photoUrl: expect.stringContaining(NOVA) }, chat: { messages: 201, earlier: true, readable: true }, routines: 2 });
    expect(found.bots.find((bot) => bot.rosterId === NOVA_TWO)!.label).toBe("Nova (2)");
    expect(found.bots.find((bot) => bot.rosterId === ECHO)!.removed).toBe(true);
    expect(found.bots.find((bot) => bot.rosterId === QUILL)!.look.color).toBe("pink");
    expect(found.bots.find((bot) => bot.rosterId === RIVET)!.look.color).toBe("chrome");
    expect(found.bots.find((bot) => bot.rosterId === JUNO)!.chat.readable).toBe(false);
    expect(found.problems).toEqual([expect.objectContaining({ slice: "chat", rosterId: JUNO, code: "newerFormat" })]);
    for (const path of app.never) expect(app.opened).not.toContain(path);
  });
});

describe("stage A: the move", () => {
  it("makes each bot with its picture and recent chat as one quiet conversation, and starts no turn", async () => {
    app = await grokMoveFixture();
    const before = app.store.bots.length;
    const { finished } = await moved([{ rosterId: NOVA }, { rosterId: QUILL, chat: false }, { rosterId: TALLY }, { rosterId: NOVA_TWO, instructions: false }]);
    expect(finished).toMatchObject({ state: "done", done: 4, total: 4, result: { moved: 4, failed: 0, apps: ["Calendar", "Notebook"], earlierChats: 1 } });
    expect(app.store.bots.length).toBe(before + 4);
    const nova = app.store.bot(finished.bots[0]!.botId!)!;
    expect(nova).toMatchObject({ name: "Nova", color: "purple", mascotBody: "goo", section: GROK_SECTION, avatarUrl: "/api/attachments/avatar-1.png", composio: false, connectorTools: {} });
    expect(nova.installedPackage?.origin).toEqual({ app: "grok-bot", id: NOVA });
    expect(nova.soul).toContain("Plans the week");
    expect(finished.bots[0]!.moved).toEqual({ messages: 201, earlier: true, picture: true, instructions: true, routineNames: 2 });
    const messages = app.store.messagesFor(nova.threadId);
    expect(messages[0]).toMatchObject({ kind: "activity", tool: { name: "notice: The last 201 messages from Grok Bot. Earlier messages stayed there." } });
    expect(messages.slice(1).map((message) => message.role)).toContain("user");
    expect(messages.filter((message) => message.text?.startsWith("(A file was here: receipt-"))).not.toHaveLength(0);
    expect(messages.some((message) => message.text?.includes("sk-live-not-real"))).toBe(false);
    expect(nova.tasks!.every((task) => !task.unread)).toBe(true);
    expect(nova.tasks![0]!.title).toBe("From Grok Bot");
    expect(app.workspace.readMemoryTopic(nova.id, "grok-bot-routines.md")).toContain("- Friday wrap (off there)");
    const quill = app.store.bot(finished.bots[1]!.botId!)!;
    expect(app.store.messagesFor(quill.threadId)).toEqual([]);
    const secondNova = app.store.bot(finished.bots[3]!.botId!)!;
    expect(secondNova.name).toBe("Nova 2");
    expect(secondNova.soul).not.toContain("A second bot with the same name");
    expect(app.routines.listRoutines()).toEqual([]);
    expect(app.store.sections.filter((section) => section !== GROK_SECTION)).toEqual([]);
  });

  it("refuses a second move while one runs, and a second run updates the same bot (MIG-06)", async () => {
    app = await grokMoveFixture();
    app.mover.start([{ rosterId: NOVA }]);
    expect(() => app!.mover.start([{ rosterId: QUILL }])).toThrow(/already running/);
    await app.mover.settled();
    const first = app.mover.progress()!.bots[0]!.botId!;
    const count = app.store.bots.length;
    const { finished } = await moved([{ rosterId: NOVA }]);
    expect(finished.bots[0]).toMatchObject({ botId: first, update: true, state: "done" });
    expect(app.store.bots.length).toBe(count);
    expect(app.store.bot(first)!.tasks!.length).toBe(1);
  });

  it("an update keeps what was said here since the move, and puts the recent chat in a conversation of its own", async () => {
    app = await grokMoveFixture();
    const { finished: first } = await moved([{ rosterId: NOVA }]);
    const nova = app.store.bot(first.bots[0]!.botId!)!;
    const brought = app.store.messagesFor(nova.threadId).length;
    app.store.appendMessage(nova.threadId, { role: "user", kind: "text", text: "said here after the move", at: Date.now() + 1_000 });
    const { finished } = await moved([{ rosterId: NOVA }]);
    expect(finished.bots[0]).toMatchObject({ botId: nova.id, update: true, state: "done" });
    const kept = app.store.messagesFor(nova.threadId);
    expect(kept.length).toBe(brought + 1);
    expect(kept.at(-1)).toMatchObject({ text: "said here after the move" });
    const tasks = app.store.bot(nova.id)!.tasks!;
    expect(tasks.length).toBe(2);
    const fresh = tasks.find((task) => task.threadId !== nova.threadId)!.threadId;
    expect(app.store.messagesFor(fresh).length).toBe(brought);
    await moved([{ rosterId: NOVA }]);
    expect(app.store.bot(nova.id)!.tasks!.length).toBe(2);
    expect(app.store.messagesFor(nova.threadId).length).toBe(brought + 1);
    expect(await app.mover.undo(finished.moveId)).toMatchObject({ removedBots: 0, removedConversations: 1 });
    expect(app.store.messagesFor(nova.threadId).at(-1)).toMatchObject({ text: "said here after the move" });
  });

  it("stops after the bot it is moving and keeps the ones done", async () => {
    app = await grokMoveFixture();
    app.mover.start([{ rosterId: NOVA }, { rosterId: QUILL }, { rosterId: TALLY }]);
    app.mover.stop();
    await app.mover.settled();
    const progress = app.mover.progress()!;
    expect(progress.state).toBe("stopped");
    expect(progress.bots.map((bot) => bot.state)).toEqual(["done", "stopped", "stopped"]);
  });

  it("names a bot that is gone from the roster and carries on", async () => {
    app = await grokMoveFixture();
    const { finished } = await moved([{ rosterId: "not-in-roster" }, { rosterId: TALLY }]);
    expect(finished.bots.map((bot) => [bot.state, bot.error])).toEqual([["failed", "notFound"], ["done", undefined]]);
  });

  it("marks a move cut off by a restart as interrupted", async () => {
    app = await grokMoveFixture();
    app.mover.start([{ rosterId: NOVA }, { rosterId: QUILL }]);
    const again = app.create();
    expect(again.progress()).toMatchObject({ state: "interrupted" });
    await app.mover.settled();
    again.close();
  });

  it("undo removes exactly what the move made, after saying which bots have new messages", async () => {
    app = await grokMoveFixture();
    const { finished: first } = await moved([{ rosterId: TALLY }]);
    const tally = first.bots[0]!.botId!;
    const { finished } = await moved([{ rosterId: NOVA }, { rosterId: TALLY }]);
    const nova = finished.bots[0]!.botId!;
    app.store.appendMessage(app.store.bot(nova)!.threadId, { role: "user", kind: "text", text: "hello", at: Date.now() + 1_000 });
    const preview = app.mover.undoPreview(finished.moveId);
    expect(preview.bots).toEqual([{ botId: nova, name: "Nova", newMessages: 1 }]);
    expect(preview.updated).toEqual([{ botId: tally, name: "Tally" }]);
    expect(await app.mover.undo(finished.moveId)).toMatchObject({ removedBots: 1, kept: [] });
    expect(app.store.bot(nova)).toBeFalsy();
    expect(app.store.bot(tally)).toBeDefined();
    await expect(app.mover.undo(finished.moveId)).rejects.toThrow(/undone already/);
  });
});

describe("stage B: the rest, from the bot's own export", () => {
  const drop = (home: string, name: string, text: string, at = Date.now()) => {
    mkdirSync(join(home, "Downloads"), { recursive: true });
    writeFileSync(join(home, "Downloads", name), text);
    utimesSync(join(home, "Downloads", name), at / 1000, at / 1000);
  };

  it("asks with a link inside Grok Bot's limits, and applies the file to the same bot", async () => {
    app = await grokMoveFixture();
    const { finished } = await moved([{ rosterId: NOVA }]);
    const botId = finished.bots[0]!.botId!;
    const count = app.store.bots.length;
    const request = app.mover.request(NOVA);
    expect(request.url.startsWith(`grokbot://app/v1/prompt?id=${NOVA}&text=`)).toBe(true);
    expect(request.url.length).toBeLessThanOrEqual(GROK_PROMPT_URL_MAX);
    expect(request.file).toBe(grokExportFileName(NOVA));
    expect(app.mover.waiting()).toMatchObject({ waiting: 1, bots: [{ rosterId: NOVA, botId, state: "waiting" }] });

    drop(app.home, request.file, syntheticExport("Nova"));
    expect(app.mover.lookInDownloads()).toBe(1);
    expect(app.mover.lookInDownloads()).toBe(0);
    expect(app.store.bots.length).toBe(count);
    const bot = app.store.bot(botId)!;
    expect(bot.soul).toContain("keep notes short");
    expect(app.soulChanges).toEqual([expect.objectContaining({ botId, before: expect.stringContaining("Plans the week") })]);
    expect(app.workspace.readMemoryTopic(botId, "from-grok-bot.md")).toContain("- Standing meeting moved to Tuesday.\n  It runs 30 minutes.");
    expect(app.workspace.readMemoryTopic(botId, "about-you-from-grok-bot.md")).toContain("Lives in Lisbon.");
    expect(app.skills.listSkills(botId).map((skill) => [skill.name, skill.enabled])).toEqual([["week-plan", false]]);
    expect(app.routines.listRoutines().map((routine) => [routine.name, routine.enabled, routine.schedule])).toEqual([
      ["Monday plan", false, expect.objectContaining({ expression: "0 8 * * 1", timeZone: "Europe/Lisbon" })],
    ]);
    const entry = app.mover.waiting().bots[0]!;
    expect(entry).toMatchObject({ state: "arrived", applied: {
      instructions: true, memories: 2, facts: 1, skills: 1, skillsOff: 1, routines: [{ name: "Monday plan", wasOn: true }], apps: ["Calendar"],
      routinesToSet: [{ name: "Moon check", reason: "zone", wasOn: false }, { name: "Sunday tidy", reason: "words", wasOn: true }],
    } });
    expect(JSON.stringify(entry)).not.toContain("Plan the week, every Monday");

    expect(app.mover.accept(syntheticExport("Nova"), { rosterId: NOVA }).applied).toHaveLength(1);
    expect(app.routines.listRoutines()).toHaveLength(1);
    expect(app.store.bots.length).toBe(count);
  });

  it("says in plain words why a file was refused, and keeps waiting", async () => {
    app = await grokMoveFixture();
    await moved([{ rosterId: QUILL }]);
    const request = app.mover.request(QUILL);
    drop(app.home, request.file, JSON.stringify({ format: "grok-bot-export", version: 1, bots: [{ name: "Quill", api_key: "sk-not-real" }] }));
    app.mover.lookInDownloads();
    expect(app.mover.waiting().bots[0]).toMatchObject({ state: "problem", problem: { code: "credentials", keys: ["bots[0].api_key"], message: expect.stringContaining("passwords, tokens or keys") } });
    expect(JSON.stringify(app.mover.waiting())).not.toContain("sk-not-real");
    drop(app.home, request.file, "{\"format\": \"grok-bot-export\", \"bots\": [{\"name\": \"Qu", Date.now() + 2_000);
    app.mover.lookInDownloads();
    expect(app.mover.waiting().bots[0]!.problem?.code).toBe("cutOff");
    expect(app.mover.waiting().waiting).toBe(1);
  });

  it("refuses to ask for a bot not moved yet", async () => {
    app = await grokMoveFixture();
    expect(() => app!.mover.request(QUILL)).toThrow(/Move this bot/);
  });

  it("takes a pasted export for the bot of that name, and names one that matches none", async () => {
    app = await grokMoveFixture();
    const { finished } = await moved([{ rosterId: RIVET }]);
    const result = app.mover.accept(syntheticExport("Rivet"), {});
    expect(result.applied).toEqual([expect.objectContaining({ rosterId: RIVET, botId: finished.bots[0]!.botId, state: "arrived" })]);
    expect(app.mover.accept(syntheticExport("Nobody"), {}).problems).toEqual([expect.objectContaining({ code: "otherBot" })]);
  });
});

describe("the lines a moved chat holds", () => {
  it("are written in the person's language: the opening note and each placeholder", async () => {
    await import("./server-line-packs.ts");
    const { chatMessages } = await import("./grok-bot-move.ts");
    const window = { earlier: true, routines: [], lines: [
      { role: "user" as const, text: "Invented question", at: 1 },
      { role: "bot" as const, text: "", at: 2, placeholder: { kind: "file" as const, detail: "receipt-1.png" } },
      { role: "bot" as const, text: "", at: 3, placeholder: { kind: "voice" as const } },
    ] };
    expect(chatMessages(window, 10).map((message) => message.text ?? message.tool?.name)).toEqual([
      "notice: The last 3 messages from Grok Bot. Earlier messages stayed there.", "Invented question", "(A file was here: receipt-1.png.)", "(A voice call was here.)",
    ]);
    expect(chatMessages(window, 10, "de").map((message) => message.text ?? message.tool?.name)).toEqual([
      "notice: Die letzten 3 Nachrichten aus Grok Bot. Frühere Nachrichten sind dort geblieben.", "Invented question", "(Hier war eine Datei: receipt-1.png.)", "(Hier war ein Sprachanruf.)",
    ]);
  });
});
