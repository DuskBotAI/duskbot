// "Move from Grok Bot" on the server (docs/grok-bot-move.md). Stage A builds each chosen bot from what Grok Bot keeps on
// this computer: its profile through the package path (trust "file": no keys, no grants), its picture, its recent chat
// as one quiet conversation, and the names of its routines. Stage B applies the export a bot writes of itself to that
// same bot. Nothing here starts an engine turn, raises a notification or leaves a conversation unread, and logs carry
// counts and ids only.
import { randomUUID } from "node:crypto";

import { GROK_EXPORT_MAX_CHARS, GROK_FROM, GROK_NOTES_FILE, grokMovePlan, type GrokBot, type GrokImportErrorCode, type GrokMovePlan } from "../shared/grok-import.ts";
import {
  GROK_ORIGIN_APP, GROK_SECTION, grokExportFileName, grokShortId, grokExportFilePattern, grokExportRequest, grokPromptUrl,
  type GrokAcceptExportResult, type GrokDetection, type GrokExportApplied, type GrokExportProblem, type GrokFoundBot,
  type GrokMoveBotProgress, type GrokMoveChoice, type GrokMoveProgress, type GrokMoveStep, type GrokRequestText,
  type GrokUndoPreview, type GrokUndoResult, type GrokWaitingList,
} from "../shared/grok-move.ts";
import type { PackageDocument } from "../shared/package-format.ts";
import { MAUS_COLOR_NAMES, type MausColor } from "../shared/wire.ts";
import {
  downloadsListing, parseExportText, readDownloadsFile, readGrokChat, readGrokPhoto, readGrokProfile,
  type GrokChatWindow, type GrokPlaceholder, type GrokProfile, type GrokRosterBot,
} from "./grok-local.ts";
import { serverLine } from "./server-lines.ts";
import * as records from "./grok-bot-move-store.ts";
import type { MoveRecord, MovedBotRecord, WaitingRecord } from "./grok-bot-move-store.ts";
import type { SetupMachine } from "./setup-import.ts";
import type { BotRecord, Message, Store } from "./store.ts";
import type { RoutineInput } from "./routines.ts";

export interface GrokMoveDeps {
  machine: () => SetupMachine;
  store: Pick<Store, "bots" | "bot" | "patchBot" | "setBotsSection" | "sections" | "changeEmptySection" | "createTask" | "renameTask"
    | "patchTask" | "importTranscript" | "replaceTranscript" | "deleteTask" | "messagesFor" | "setSoul">;
  /** The package path (`trust: "file"`): new records only, routines paused, no keys, no connected apps. */
  importPackage(document: PackageDocument): Promise<{ bots: BotRecord[]; section: string }>;
  routines: { create(input: RoutineInput): { id: string }; listRoutines(): Array<{ botId: string; name: string }> };
  skills: {
    install(botId: string, source: string, files: Array<{ path: string; content: string }>): { name: string } | { error: string };
    setEnabled(botId: string, name: string, enabled: boolean): unknown;
  };
  memory: { writeTopic(botId: string, name: string, text: string): void; readTopic(botId: string, name: string): string | null };
  /** Stores a picture as a bot avatar and answers its URL. */
  saveAvatar(bytes: Buffer, mime: string): string;
  /** The bot deletion every other path uses: its routines, folders and computer go with it. */
  deleteBot(botId: string): Promise<{ status: number; body: { error?: string } }>;
  recordSoulChange(botId: string, before: string, after: string): void;
  timeZone(): string;
  /** The person's language, for the lines the move writes into a chat. */
  language?: () => string | undefined;
  now?: () => number;
  log?: (line: string) => void;
  /** How often Downloads is looked at while a bot's export is awaited. */
  watchEveryMs?: number;
}

export class GrokMoveError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GrokMoveError";
    this.status = status;
  }
}

const CHAT_TITLE = "From Grok Bot";
const ROUTINES_TOPIC = "grok-bot-routines.md";
const MEMORIES_TOPIC = "from-grok-bot.md";
const FACTS_TOPIC = "about-you-from-grok-bot.md";
const DEFAULT_WATCH_MS = 4_000;

const COLOR_ALIASES: Record<string, MausColor> = {
  violet: "purple", magenta: "pink", black: "chrome", white: "silver", gray: "silver", grey: "silver", gold: "yellow",
  lime: "green", navy: "blue", indigo: "purple", rose: "pink", amber: "orange", mint: "teal",
};
const SHAPE_BODIES: Record<string, string> = { blob: "goo", cloud: "puff", pumpkin: "mochi", teardrop: "drip" };

/** FNV-1a: a stable colour for a bot whose colour has no match here. */
function hashPick(value: string, count: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193) >>> 0;
  return hash % count;
}

export function grokColor(bot: Pick<GrokRosterBot, "color" | "rosterId">): MausColor {
  if ((MAUS_COLOR_NAMES as readonly string[]).includes(bot.color)) return bot.color as MausColor;
  return COLOR_ALIASES[bot.color] ?? MAUS_COLOR_NAMES[hashPick(bot.rosterId, 11)]!;
}

export const grokBody = (shape: string): string | undefined => SHAPE_BODIES[shape];

const isGrokBot = (bot: BotRecord, rosterId: string) => bot.installedPackage?.origin?.app === GROK_ORIGIN_APP && bot.installedPackage.origin.id === rosterId;

function labels(bots: readonly GrokRosterBot[]): Map<string, string> {
  const seen = new Map<string, number>();
  return new Map(bots.map((bot) => {
    const key = bot.name.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return [bot.rosterId, n === 1 ? bot.name : `${bot.name} (${n})`];
  }));
}

const descriptionLine = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 200 ? flat : `${flat.slice(0, 199).trimEnd()}…`;
};

const PLACEHOLDER_LINES = {
  question: "server.grokMove.held.question", email: "server.grokMove.held.email", card: "server.grokMove.held.card",
  file: "server.grokMove.held.file", app: "server.grokMove.held.app", voice: "server.grokMove.held.voice",
} as const;

function placeholderLine(language: string | undefined, held: GrokPlaceholder): string {
  if (held.detail && held.kind === "file") return serverLine(language, "server.grokMove.held.fileNamed", { detail: held.detail });
  if (held.detail && held.kind === "app") return serverLine(language, "server.grokMove.held.appNamed", { detail: held.detail });
  return serverLine(language, PLACEHOLDER_LINES[held.kind]);
}

/** The conversation a recent chat becomes: one quiet note, then each line in order. */
export function chatMessages(window: GrokChatWindow, now: number, language?: string): Message[] {
  const count = window.lines.length;
  const key = count === 1 ? (window.earlier ? "server.grokMove.recentOneEarlier" : "server.grokMove.recentOne") : window.earlier ? "server.grokMove.recentEarlier" : "server.grokMove.recent";
  const note = `notice: ${serverLine(language, key, { count })}`;
  const firstAt = window.lines.find((line) => line.at > 0)?.at ?? now;
  const out: Message[] = [];
  let at = firstAt - 1;
  let parentId: string | null = null;
  const push = (message: Omit<Message, "id" | "at" | "parentId">) => {
    const id = randomUUID();
    out.push({ ...message, id, at, parentId } as Message);
    parentId = id;
  };
  push({ role: "bot", kind: "activity", tool: { name: note, ok: true } });
  for (const line of window.lines) {
    at = Math.max(at + 1, line.at);
    push({ role: line.role, kind: "text", text: line.placeholder ? placeholderLine(language, line.placeholder) : line.text });
  }
  return out;
}

function routinesTopic(name: string, routines: GrokChatWindow["routines"]): string {
  return [`# Routines ${name} had in Grok Bot`, "",
    "Only their names are on this computer; what each one does and when it runs stayed in Grok Bot. They come over in full, paused, when Grok Bot sends the rest.", "",
    ...routines.map((routine) => `- ${routine.name} (${routine.on ? "on" : "off"} there)`), ""].join("\n");
}

/** Every item as it was written: a line that runs over several lines keeps them, indented under its bullet. */
function listTopic(title: string, intro: string, items: readonly string[]): string {
  return [`# ${title}`, "", intro, "", ...items.map((item) => `- ${item.trim().replace(/\r?\n/g, "\n  ")}`), ""].join("\n");
}

const EXPORT_WORDS: Record<GrokImportErrorCode | "otherBot" | "unreadable", string> = {
  notExport: "This file is not an export from Grok Bot.",
  cutOff: "This file looks cut off. Ask the bot to save it again.",
  tooLarge: "This file is larger than 4 MB, so it was not read.",
  credentials: "This file has passwords, tokens or keys in it, so nothing in it was used. Ask the bot to save it again without them.",
  newerVersion: "This file is in a newer format than this version of dusk bot reads. Update dusk bot and try again.",
  unusable: "Nothing in this file could be used.",
  otherBot: "This file is for a bot that was not moved from Grok Bot. Move that bot first.",
  unreadable: "This file could not be opened.",
};

export function exportProblem(file: string, code: GrokExportProblem["code"], keys: readonly string[] = []): GrokExportProblem {
  return { file, code, message: EXPORT_WORDS[code], ...(code === "credentials" && keys.length ? { keys: [...keys] } : {}) };
}

export class GrokMover {
  private running: { record: MoveRecord; stop: boolean } | null = null;
  private watcher: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly deps: GrokMoveDeps;

  constructor(deps: GrokMoveDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    for (const record of records.unfinishedMoves()) {
      for (const bot of record.progress.bots) if (bot.state === "queued" || bot.state === "moving") bot.state = "stopped";
      record.progress.state = "interrupted";
      record.progress.finishedAt ??= this.now();
      records.saveMove(record);
    }
    if (records.waitingEntries().some((entry) => entry.state !== "arrived")) this.watch();
  }

  private log(line: string): void {
    (this.deps.log ?? ((text: string) => console.log(text)))(`[grok-move] ${line}`);
  }

  private packageOfItsOwn(plan: GrokMovePlan, rosterId: string): PackageDocument {
    const taken = this.deps.store.bots.some((bot) => !bot.hidden && bot.installedPackage?.id === plan.packageId);
    if (!taken) return plan.document;
    return { ...plan.document, package: { ...plan.document.package, id: `${plan.packageId}-${grokShortId(rosterId)}` } };
  }

  private hereFor(rosterId: string): BotRecord | undefined {
    return this.deps.store.bots.find((bot) => isGrokBot(bot, rosterId) && !bot.hidden);
  }

  detect(): GrokDetection {
    const profile = readGrokProfile(this.deps.machine());
    const waiting = new Map(records.waitingEntries().map((entry) => [entry.rosterId, entry]));
    const named = labels(profile.bots);
    const problems = [...profile.problems];
    const bots = profile.bots.map((bot): GrokFoundBot => {
      const chat = readGrokChat(this.deps.machine(), profile, bot.rosterId);
      if (chat && "problem" in chat) problems.push(chat.problem);
      const window = chat && !("problem" in chat) ? chat : null;
      const here = this.hereFor(bot.rosterId);
      const asked = waiting.get(bot.rosterId);
      const photo = bot.photoKey && profile.photoNames.has(bot.photoKey);
      const body = grokBody(bot.shape);
      return {
        rosterId: bot.rosterId, name: bot.name, label: named.get(bot.rosterId) ?? bot.name,
        description: descriptionLine(bot.description), hasDescription: Boolean(bot.description.trim()),
        look: { color: grokColor(bot), ...(body ? { body } : {}), ...(photo ? { photoUrl: `/api/setup-import/grok/move/photo?id=${encodeURIComponent(bot.rosterId)}` } : {}) },
        removed: bot.removed,
        ...(bot.createdAt ? { createdAt: bot.createdAt } : {}),
        ...(bot.updatedAt ? { updatedAt: bot.updatedAt } : {}),
        chat: { messages: window?.lines.length ?? 0, earlier: window?.earlier ?? false, readable: !(chat && "problem" in chat) },
        routines: window?.routines.length ?? 0,
        ...(here ? { here: { botId: here.id, name: here.name } } : {}),
        ...(asked ? { asked: { state: asked.state, askedAt: asked.askedAt, file: asked.file, ...(asked.applied ? { applied: asked.applied } : {}), ...(asked.problem ? { problem: asked.problem } : {}) } } : {}),
      };
    });
    return {
      available: true, found: profile.found, bots, apps: profile.apps, problems,
      running: this.running !== null, waiting: [...waiting.values()].filter((entry) => entry.state !== "arrived").length,
    };
  }

  photo(rosterId: string): { bytes: Buffer; mime: string } | null {
    const profile = readGrokProfile(this.deps.machine());
    const bot = profile.bots.find((candidate) => candidate.rosterId === rosterId);
    const read = bot ? readGrokPhoto(this.deps.machine(), profile, bot) : null;
    return read && "bytes" in read ? read : null;
  }

  progress(): GrokMoveProgress | null {
    return this.running ? structuredClone(this.running.record.progress) : records.lastMove()?.progress ?? null;
  }

  start(choices: readonly GrokMoveChoice[]): GrokMoveProgress {
    if (this.running) throw new GrokMoveError(409, "A move from Grok Bot is already running. Wait for it to finish or stop it.");
    const profile = readGrokProfile(this.deps.machine());
    if (!profile.found) throw new GrokMoveError(404, "Grok Bot is not on this computer.");
    const byId = new Map(profile.bots.map((bot) => [bot.rosterId, bot]));
    const named = labels(profile.bots);
    const unique = [...new Map(choices.map((choice) => [choice.rosterId, choice])).values()];
    const progress: GrokMoveProgress = {
      moveId: randomUUID(), state: "running", startedAt: this.now(), done: 0, total: unique.length,
      bots: unique.map((choice) => ({
        rosterId: choice.rosterId, name: named.get(choice.rosterId) ?? choice.rosterId, state: "queued",
        update: Boolean(this.hereFor(choice.rosterId)),
      })),
    };
    const record: MoveRecord = { progress, moved: [] };
    records.saveMove(record);
    this.running = { record, stop: false };
    this.log(`move ${progress.moveId} started: ${unique.length} bots`);
    void this.run(profile, byId, unique).catch((error: unknown) => {
      this.log(`move ${progress.moveId} ended early: ${error instanceof Error ? error.name : "error"}`);
      this.finish("interrupted");
    });
    return structuredClone(progress);
  }

  stop(): GrokMoveProgress {
    if (!this.running) throw new GrokMoveError(409, "No move from Grok Bot is running.");
    this.running.stop = true;
    this.running.record.progress.state = "stopping";
    records.saveMove(this.running.record);
    return structuredClone(this.running.record.progress);
  }

  /** Settles when the running move is over; for tests and the recipe. */
  async settled(): Promise<void> {
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  private finish(state: GrokMoveProgress["state"]): void {
    if (!this.running) return;
    const { record } = this.running;
    record.progress.state = state;
    record.progress.finishedAt = this.now();
    const bots = record.progress.bots;
    record.progress.result = {
      moved: bots.filter((bot) => bot.state === "done").length,
      failed: bots.filter((bot) => bot.state === "failed").length,
      apps: readGrokProfile(this.deps.machine()).apps,
      earlierChats: bots.filter((bot) => bot.moved?.earlier).length,
      restInGrokBot: true,
    };
    records.saveMove(record);
    this.log(`move ${record.progress.moveId} ${state}: ${record.progress.result.moved} moved, ${record.progress.result.failed} failed`);
    this.running = null;
  }

  private async run(profile: GrokProfile, byId: Map<string, GrokRosterBot>, choices: readonly GrokMoveChoice[]): Promise<void> {
    const state = this.running!;
    for (const [index, choice] of choices.entries()) {
      const row = state.record.progress.bots[index]!;
      if (state.stop) {
        row.state = "stopped";
        continue;
      }
      await new Promise((resolve) => setImmediate(resolve));
      const source = byId.get(choice.rosterId);
      if (!source) {
        Object.assign(row, { state: "failed", error: "notFound", message: "This bot is no longer in Grok Bot's list." });
      } else {
        try {
          await this.moveOne(profile, source, choice, row, state.record);
          row.state = "done";
          delete row.step;
        } catch (error) {
          const limit = (error as { code?: string }).code === "bot_limit";
          Object.assign(row, {
            state: "failed", error: limit ? "botLimit" : "failed",
            message: limit ? "Your plan has no room for another bot." : "This bot could not be moved. Try again.",
          });
          this.log(`bot ${source.rosterId} failed at ${row.step ?? "start"}`);
        }
      }
      state.record.progress.done += 1;
      records.saveMove(state.record);
    }
    this.finish(state.stop ? "stopped" : "done");
  }

  private step(row: GrokMoveBotProgress, record: MoveRecord, step: GrokMoveStep): void {
    row.step = step;
    row.state = "moving";
    records.saveMove(record);
  }

  private async moveOne(profile: GrokProfile, source: GrokRosterBot, choice: GrokMoveChoice, row: GrokMoveBotProgress, record: MoveRecord): Promise<void> {
    const { store } = this.deps;
    const wantsInstructions = choice.instructions !== false;
    this.step(row, record, "profile");
    let bot = this.hereFor(source.rosterId);
    const created = !bot;
    if (!bot) {
      const draft: GrokBot = {
        name: source.name, title: source.title, description: wantsInstructions ? source.description : "",
        instructions: wantsInstructions ? source.description : "",
        memories: [], userFacts: [], skills: [], routines: [], apps: [], color: grokColor(source),
      };
      const plan = grokMovePlan(draft, { from: GROK_FROM, appNamesOnly: true, timeZone: this.deps.timeZone() });
      const imported = await this.deps.importPackage(this.packageOfItsOwn(plan, source.rosterId));
      const made = imported.bots[0];
      if (!made) throw new Error("no bot");
      const body = grokBody(source.shape);
      store.patchBot(made.id, {
        installedPackage: { ...made.installedPackage!, origin: { app: GROK_ORIGIN_APP, id: source.rosterId } },
        ...(!wantsInstructions && source.description.trim() ? { description: source.description.slice(0, 4_000) } : {}),
        ...(body ? { mascotBody: body as BotRecord["mascotBody"] } : {}),
      });
      store.setBotsSection([made.id], GROK_SECTION);
      if (imported.section && imported.section !== GROK_SECTION && store.sections.includes(imported.section)) store.changeEmptySection(imported.section, null);
      bot = store.bot(made.id)!;
    } else {
      store.patchBot(bot.id, { color: grokColor(source), ...(source.description.trim() && !bot.description?.trim() ? { description: source.description.slice(0, 4_000) } : {}) });
    }
    const moved: MovedBotRecord = { rosterId: source.rosterId, botId: bot.id, created };
    record.moved.push(moved);
    row.botId = bot.id;
    row.update = !created;
    const counts = { messages: 0, earlier: false, picture: false, instructions: created && wantsInstructions && Boolean(source.description.trim()), routineNames: 0 };

    this.step(row, record, "picture");
    const photo = readGrokPhoto(this.deps.machine(), profile, source);
    if (photo && "bytes" in photo) {
      try {
        store.patchBot(bot.id, { avatarUrl: this.deps.saveAvatar(photo.bytes, photo.mime), avatarCrop: "circle" });
        counts.picture = true;
      } catch {
        row.message = "Its picture could not be kept, so it has its colour instead.";
      }
    }

    const chat = readGrokChat(this.deps.machine(), profile, source.rosterId);
    const window = chat && !("problem" in chat) ? chat : null;
    if (choice.chat !== false && window?.lines.length) {
      this.step(row, record, "chat");
      const messages = chatMessages(window, this.now(), this.deps.language?.());
      const earlierThread = created ? null : records.chatThreadOf(bot.id);
      const untouched = earlierThread !== null && store.messagesFor(earlierThread).at(-1)?.id === records.chatEndOf(bot.id);
      const reuse = untouched && bot.tasks?.some((task) => task.threadId === earlierThread) ? earlierThread : null;
      let threadId: string;
      if (reuse) {
        store.replaceTranscript(reuse, messages, messages.at(-1)!.id);
        threadId = reuse;
      } else {
        threadId = created ? bot.threadId : store.createTask(bot.id, CHAT_TITLE, false)!.threadId;
        store.importTranscript(threadId, messages, messages.at(-1)!.id);
        moved.threadId = threadId;
      }
      store.renameTask(bot.id, threadId, CHAT_TITLE);
      store.patchTask(bot.id, threadId, { unread: false });
      records.saveChatThread(bot.id, source.rosterId, threadId);
      moved.chatEnd = messages.at(-1)!.id;
      counts.messages = window.lines.length;
      counts.earlier = window.earlier;
    }

    if (window?.routines.length) {
      this.step(row, record, "routines");
      if (created || this.deps.memory.readTopic(bot.id, ROUTINES_TOPIC) !== null) this.deps.memory.writeTopic(bot.id, ROUTINES_TOPIC, routinesTopic(bot.name, window.routines));
      counts.routineNames = window.routines.length;
    }
    row.moved = counts;
  }

  undoPreview(moveId: string): GrokUndoPreview {
    const record = this.finishedMove(moveId);
    const after = record.progress.finishedAt ?? record.progress.startedAt;
    const live = record.moved.filter((moved) => this.deps.store.bot(moved.botId));
    return {
      moveId,
      bots: live.filter((moved) => moved.created).map((moved) => {
        const bot = this.deps.store.bot(moved.botId)!;
        const newMessages = (bot.tasks ?? []).reduce((sum, task) => sum + this.deps.store.messagesFor(task.threadId).filter((message) => message.at > after).length, 0);
        return { botId: bot.id, name: bot.name, newMessages };
      }),
      updated: live.filter((moved) => !moved.created).map((moved) => ({ botId: moved.botId, name: this.deps.store.bot(moved.botId)!.name })),
    };
  }

  private finishedMove(moveId: string): MoveRecord {
    if (this.running?.record.progress.moveId === moveId) throw new GrokMoveError(409, "This move is still running. Stop it first.");
    const record = records.loadMove(moveId);
    if (!record) throw new GrokMoveError(404, "There is no such move.");
    if (record.progress.state === "undone") throw new GrokMoveError(409, "This move was undone already.");
    return record;
  }

  async undo(moveId: string): Promise<GrokUndoResult> {
    const record = this.finishedMove(moveId);
    const result: GrokUndoResult = { removedBots: 0, removedConversations: 0, kept: [] };
    for (const moved of record.moved) {
      const bot = this.deps.store.bot(moved.botId);
      if (!bot) continue;
      if (moved.created) {
        const deleted = await this.deps.deleteBot(moved.botId);
        if (deleted.status >= 400) {
          result.kept.push({ botId: bot.id, name: bot.name, message: deleted.body.error ?? "It could not be removed now." });
          continue;
        }
        records.forgetWaitingForBot(moved.botId);
        records.forgetChatThread(moved.botId);
        result.removedBots += 1;
      } else if (moved.threadId && this.deps.store.deleteTask(moved.botId, moved.threadId)) {
        records.forgetChatThread(moved.botId);
        result.removedConversations += 1;
      }
    }
    record.progress.state = "undone";
    records.saveMove(record);
    this.log(`move ${moveId} undone: ${result.removedBots} bots, ${result.removedConversations} conversations, ${result.kept.length} kept`);
    return result;
  }

  waiting(): GrokWaitingList {
    const bots = records.waitingEntries().filter((entry) => this.deps.store.bot(entry.botId)).map(({ seen: _seen, ...entry }) => entry);
    return { bots, waiting: bots.filter((entry) => entry.state !== "arrived").length };
  }

  /** The request for one moved bot, which is then awaited in Downloads. */
  request(rosterId: string): GrokRequestText {
    const bot = this.hereFor(rosterId);
    if (!bot) throw new GrokMoveError(409, "Move this bot from Grok Bot first.");
    const source = readGrokProfile(this.deps.machine()).bots.find((candidate) => candidate.rosterId === rosterId);
    const text = grokExportRequest({ rosterId, name: source?.name ?? bot.name });
    const url = grokPromptUrl(rosterId, text);
    if (!url) throw new GrokMoveError(400, "This bot's id cannot be opened in Grok Bot.");
    const file = grokExportFileName(rosterId);
    const { problem: _problem, ...held } = records.waitingEntries().find((entry) => entry.rosterId === rosterId) ?? {};
    records.saveWaiting({ ...held, rosterId, botId: bot.id, name: bot.name, state: "waiting", askedAt: this.now(), file });
    this.watch();
    return { rosterId, url, text, file };
  }

  private watch(): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => this.lookInDownloads(), this.deps.watchEveryMs ?? DEFAULT_WATCH_MS);
    this.watcher.unref?.();
  }

  close(): void {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
  }

  /** One look at Downloads for each awaited bot's file; a file already applied, unchanged, is left alone. */
  lookInDownloads(): number {
    const waiting = records.waitingEntries().filter((entry) => this.deps.store.bot(entry.botId));
    if (!waiting.some((entry) => entry.state !== "arrived")) {
      this.close();
      return 0;
    }
    const machine = this.deps.machine();
    const listing = downloadsListing(machine);
    let applied = 0;
    for (const entry of waiting) {
      const pattern = grokExportFilePattern(entry.rosterId);
      const candidates = listing.filter((name) => pattern.test(name)).flatMap((name) => {
        const read = readDownloadsFile(machine, name, GROK_EXPORT_MAX_CHARS);
        return read ? [{ name, read }] : [];
      }).sort((a, b) => b.read.modifiedAt - a.read.modifiedAt);
      const newest = candidates[0];
      if (!newest || (entry.seen?.name === newest.name && entry.seen.modifiedAt === newest.read.modifiedAt)) continue;
      const seen = { name: newest.name, modifiedAt: newest.read.modifiedAt };
      if ("tooLarge" in newest.read) this.saveProblem(entry, exportProblem(newest.name, "tooLarge"), seen);
      else if (this.applyText(entry, newest.read.text, newest.name, seen)) applied += 1;
    }
    return applied;
  }

  private saveProblem(entry: WaitingRecord, problem: GrokExportProblem, seen?: WaitingRecord["seen"]): void {
    records.saveWaiting({ ...entry, state: entry.state === "arrived" ? "arrived" : "problem", problem, ...(seen ? { seen } : {}) });
    this.log(`export for ${entry.rosterId} refused: ${problem.code}`);
  }

  /** Applies one export to the waiting bot; answers whether it was used. */
  private applyText(entry: WaitingRecord, text: string, file: string, seen?: WaitingRecord["seen"]): boolean {
    const parsed = parseExportText(text);
    if (parsed.refused) {
      this.saveProblem(entry, exportProblem(file, parsed.refused.code, parsed.refused.keys), seen);
      return false;
    }
    const bots = parsed.bots ?? [];
    const bot = this.deps.store.bot(entry.botId);
    const names = new Set([entry.name, bot?.name ?? ""].map((name) => name.trim().toLowerCase()).filter(Boolean));
    const exported = bots.length === 1 ? bots[0] : bots.find((candidate) => names.has(candidate.name.trim().toLowerCase()));
    if (!bot || !exported) {
      this.saveProblem(entry, exportProblem(file, "otherBot"), seen);
      return false;
    }
    const applied = this.applyExport(bot, exported, file);
    const { problem: _problem, ...rest } = entry;
    records.saveWaiting({ ...rest, state: "arrived", applied, ...(seen ? { seen } : {}) });
    this.log(`export for ${entry.rosterId} applied: ${applied.memories} memories, ${applied.skills} skills, ${applied.routines.length} routines, ${applied.routinesToSet.length} to set`);
    return true;
  }

  /** Full instructions replace the starting ones (the earlier text stays in its history), every memory is kept as written,
   * skills land off, routines paused with their own schedule and zone, apps as names only. Applied again, nothing doubles. */
  private applyExport(bot: BotRecord, exported: GrokBot, file: string): GrokExportApplied {
    const { store, memory } = this.deps;
    const plan = grokMovePlan({ ...exported, name: bot.name }, { from: GROK_FROM, exactZones: true, appNamesOnly: true, timeZone: this.deps.timeZone() });
    const agent = plan.document.package.agents[0]!;
    const applied: GrokExportApplied = {
      at: this.now(), file, instructions: false, memories: exported.memories.length, facts: exported.userFacts.length,
      skills: 0, skillsOff: 0, routines: [], routinesToSet: plan.routineNotes, apps: exported.apps.map((app) => app.name),
    };
    if (exported.instructions.trim() && agent.soul && agent.soul !== bot.soul) {
      const before = bot.soul ?? "";
      store.setSoul(bot.id, agent.soul);
      this.deps.recordSoulChange(bot.id, before, agent.soul);
      applied.instructions = true;
    }
    if (exported.memories.length) {
      memory.writeTopic(bot.id, MEMORIES_TOPIC, listTopic("What I remembered in Grok Bot", "Brought over word for word when I moved.", exported.memories));
    }
    if (exported.userFacts.length) {
      memory.writeTopic(bot.id, FACTS_TOPIC, listTopic("About the person, from Grok Bot", "What I knew about you there, word for word.", exported.userFacts));
    }
    const notes = agent.seed?.memory?.[GROK_NOTES_FILE];
    if (notes) memory.writeTopic(bot.id, GROK_NOTES_FILE.slice("memory/".length), notes);
    for (const skill of plan.document.package.skills?.entries ?? []) {
      const installed = this.deps.skills.install(bot.id, `package:${plan.packageId}`, [{ path: "SKILL.md", content: skill.instructions }]);
      if ("error" in installed) continue;
      this.deps.skills.setEnabled(bot.id, installed.name, false);
      applied.skills += 1;
      applied.skillsOff += 1;
    }
    const existing = new Set(this.deps.routines.listRoutines().filter((routine) => routine.botId === bot.id).map((routine) => routine.name));
    for (const [index, routine] of (plan.document.package.routines ?? []).entries()) {
      const label = plan.pausedRoutines[index] ?? { name: routine.name, wasOn: false };
      if (!existing.has(routine.name)) {
        this.deps.routines.create({ name: routine.name, prompt: routine.prompt, botId: bot.id, runOn: routine.runOn, enabled: false, schedule: routine.schedule, durationMinutes: routine.durationMinutes });
      }
      applied.routines.push(label);
    }
    return applied;
  }

  /** A dropped or pasted export: for the named bot, else each bot in it by its name among the bots moved from Grok Bot. */
  accept(text: string, options: { rosterId?: string; file?: string }): GrokAcceptExportResult {
    const file = options.file?.trim() || "pasted text";
    const result: GrokAcceptExportResult = { applied: [], problems: [] };
    const entryFor = (rosterId: string, bot: BotRecord): WaitingRecord =>
      records.waitingEntries().find((entry) => entry.rosterId === rosterId)
        ?? { rosterId, botId: bot.id, name: bot.name, state: "waiting", askedAt: this.now(), file: grokExportFileName(rosterId) };
    const appliedEntry = (rosterId: string) => {
      const { seen: _seen, ...entry } = records.waitingEntries().find((candidate) => candidate.rosterId === rosterId)!;
      return entry;
    };
    if (options.rosterId) {
      const bot = this.hereFor(options.rosterId);
      if (!bot) throw new GrokMoveError(409, "Move this bot from Grok Bot first.");
      const entry = entryFor(options.rosterId, bot);
      if (this.applyText(entry, text, file)) result.applied.push(appliedEntry(options.rosterId));
      else result.problems.push(appliedEntry(options.rosterId).problem ?? exportProblem(file, "unusable"));
      return result;
    }
    const parsed = parseExportText(text);
    if (parsed.refused) return { applied: [], problems: [exportProblem(file, parsed.refused.code, parsed.refused.keys)] };
    const moved = this.deps.store.bots.filter((bot) => bot.installedPackage?.origin?.app === GROK_ORIGIN_APP && !bot.hidden);
    for (const exported of parsed.bots ?? []) {
      const key = exported.name.trim().toLowerCase();
      const matches = moved.filter((bot) => bot.name.trim().toLowerCase() === key);
      const bot = matches.length === 1 ? matches[0] : undefined;
      if (!bot) {
        result.problems.push(exportProblem(file, "otherBot"));
        continue;
      }
      const rosterId = bot.installedPackage!.origin!.id;
      const entry = entryFor(rosterId, bot);
      const applied = this.applyExport(bot, exported, file);
      records.saveWaiting({ ...entry, state: "arrived", applied });
      result.applied.push(appliedEntry(rosterId));
    }
    return result;
  }
}
