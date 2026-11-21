import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { CaptureBuffer, captureItemLimit, capturePrompt, captureSize, newCandidates, parseCandidates, statedInConversation, worthCapturing, type Candidate, type CaptureBatch, type CaptureTurn, type KnownFact } from "./memory-capture.ts";
import { ABOUT_FILE, aboutOwner, annotateFact, pruneRetiredFacts, type FactRow, type FactSource } from "./memory-facts.ts";
import { nearDuplicateOf, recallFacts, SAME_FACT } from "./memory-recall.ts";
import { looksLikeInstruction } from "./memory-trust.ts";
import { UNVERIFIED_MAX_BYTES, UNVERIFIED_TOPIC } from "./memory-forget.ts";
import { cosine, embedderReady, embedPassages } from "./memory-embed.ts";
import { MERGE_ENTRIES, mergedLine, mergeLoser, mergePairs, mergePrompt, parseMerge, type MergeItem, type MergePair } from "./memory-merge.ts";
import { DREAM_FIRST_LOOKBACK_MS, DREAM_MIN_CONVERSATIONS, dreamEvidenced, dreamNoticedEvidenced, dreamPrompt, parseDream, type DreamConversation } from "./memory-dream.ts";
import { factIdentity, foldForMatch, isExpired, lineFactIdentity, notebookIdentities, parseMemoryEntries } from "./memory-entries.ts";
import { applyNotebookChange, consolidatePrompt, namesFact, parseConsolidation, parseGeneral, planConsolidation, recordGeneralHistory, PROMPT_LINES, type NotebookChange, type NotebookLine } from "./general-memory.ts";
import { mergeTopicText } from "./memory-topics.ts";
import { commitLearned, dropLearnedLines, isForgotten, learnedState } from "./profile-learned.ts";
import { applyMoves, MAX_MOVES, organizeCandidates, organizePrompt, parseMoves } from "./memory-organize.ts";
import { recordMemoryChange, rotateMemoryJournal } from "./memory-journal.ts";
import { applyTidy, contradictionBudget, contradictionCandidates, contradictionPrompt, parseContradictions, planChanges, planTidy, type Contradiction } from "./memory-tidy.ts";
import { appendMemoryArchive, ARCHIVE_TOPIC, compactMemoryTopic, ensureWorkspace, foldOldLogs, isArchiveTopic, listMemoryTopics, memoryDate, memoryEntry, memoryTopicIndex, readMemoryText, updateMemory, workspaceDir, writeMemoryFile, writeMemoryTopic } from "./workspace.ts";

export { dreamConversations } from "./memory-dream.ts";

export const CAPTURE_MAX_TURNS = 6;
/** One capture call reads at most this much of one bot's waiting chats; the rest wait for the next call. */
export const CAPTURE_CALL_MAX_TURNS = 2 * CAPTURE_MAX_TURNS;
export const CAPTURE_CALL_MAX_BYTES = 24_000;
/** A chat that goes quiet takes along its bot's other chats that would go quiet within this long. */
export const CAPTURE_GATHER_MS = 15_000;
export const MODEL_TIMEOUT_MS = 60_000;
/** A dream reads up to twenty chats at once, so it gets longer than a capture call. */
export const DREAM_TIMEOUT_MS = 180_000;
export const MAX_TOPIC_CHECKS = 4;
export const TIDY_CHECK_MS = 10 * 60_000;
export const MIN_ENTRIES_FOR_CONTRADICTIONS = 5;
const ARCHIVE_PATH = `memory/${ARCHIVE_TOPIC}`;
export const MAX_PENDING_THREADS = 50;
export const TOPIC_MAX_BYTES = 64 * 1024;
/** Two entries of one topic this alike, yet not the same fact, are worth a contradiction check first. */
const LIKELY_CONFLICT = 0.8;
/** Rows of facts deleted by hand are kept this long, then dropped from the store. */
export const RETIRED_FACTS_KEEP_MS = 180 * 24 * 60 * 60_000;
const CONFLICT_SCAN_TOPICS = 40;
const CONFLICT_SCAN_ENTRIES = 60;
/** Known facts a capture call is shown to judge new items against. */
export const KNOWN_FACTS = 20;

export interface UpkeepEngine {
  generateText?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<string>;
}

export interface UpkeepBot {
  id: string;
  name: string;
  memoryUpkeep?: boolean;
  memoryEnabled?: boolean;
}

export function upkeepEnabled(bot: Pick<UpkeepBot, "memoryUpkeep" | "memoryEnabled"> | undefined): bot is UpkeepBot {
  return Boolean(bot) && bot!.memoryUpkeep !== false && bot!.memoryEnabled !== false;
}

export interface UpkeepDeps {
  bots: () => readonly UpkeepBot[];
  bot: (id: string) => UpkeepBot | undefined;
  engine: (botId: string) => UpkeepEngine | null;
  busy: (botId: string) => boolean;
  /** `replaces`: older facts the new ones change; they leave About me. */
  addToAboutMe: (from: { botId: string; botName: string }, texts: readonly string[], replaces?: readonly string[]) => number;
  /** Asks the dream found left undone, into the person's commitments; how many were new. */
  missed?: (botId: string, texts: readonly string[]) => number;
  /** The one general memory every bot reads (About me), where there is one person to keep it for: absent on a Team Cloud,
   * where each person's About me is their own. `promote`: whether lasting facts about the person may move into it from
   * a bot's own notes, which only holds where one person uses every bot. */
  general?: { read(): string; write(text: string): void; changed(): void; promote(): boolean };
  sourceLabel: (botId: string, threadId: string) => string;
  /** Asked again at capture, so a turn queued before a visibility change is dropped. */
  mayCapture?: (botId: string, threadId: string) => boolean;
  restoreTurn?: (botId: string, threadId: string, turnId: string) => CaptureTurn | null;
  /** The person's chats with a bot since a time, for a dream; without it a bot cannot dream. */
  conversations?: (botId: string, since: number) => DreamConversation[];
  /** The one bot that dreams tonight, if any: its ideas go into the person's brief. */
  dreamer?: () => string | undefined;
  quietMs: () => number;
  tidyHour: () => number;
  writing?: <T>(botId: string, write: () => T) => T;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface TidyReport {
  at: number;
  expired: number;
  duplicates: number;
  superseded: number;
  deferred: number;
  organized?: number;
  /** Lines struck through as the same fact as another line. */
  merged?: number;
  contradictionsChecked: boolean;
  topicChecks?: number;
  topicsDeferred?: number;
  note?: string;
}

export interface CaptureReport {
  at: number;
  added: number;
  topics: number;
  aboutMe: number;
  organized?: number;
  note?: string;
}

export interface GeneralReport {
  at: number;
  /** Lines taken out of general memory (duplicates, replaced, trimmed); each is in the history. */
  removed: number;
  /** Facts moved into general memory from bots' own notes. */
  promoted: number;
  /** Bot notes removed as copies of general memory, or struck through as replaced by it. */
  notes: number;
  note?: string;
}

export interface DreamReport {
  at: number;
  conversations: number;
  learned: { text: string; where: string }[];
  outdated: { was: string; now: string }[];
  ideas: string[];
  aboutMe: number;
  note?: string;
}

interface UpkeepState {
  general?: { last?: GeneralReport };
  bots: Record<string, {
    lastTidy?: TidyReport;
    lastCapture?: CaptureReport;
    core?: string[];
    topicCursor?: string;
    lastDream?: DreamReport;
    /** The last time a dream's model call answered: the next dream reads the chats after it. */
    dreamedTo?: number;
  }>;
}

const MAX_CORE = 500;

function statePath(): string {
  return join(DATA_DIR, "memory-upkeep.json");
}

function loadState(): UpkeepState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as UpkeepState;
    return parsed && typeof parsed.bots === "object" && parsed.bots ? parsed : { bots: {} };
  } catch {
    return { bots: {} };
  }
}

/** Answers whether the file on disk is now current; a failed write stays pending for the next flush. */
function saveState(state: UpkeepState): boolean {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileAtomic(statePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

interface PendingCapture {
  batches: { botId: string; threadId: string; turnIds: string[] }[];
}

function pendingPath(): string {
  return join(DATA_DIR, "memory-capture-pending.json");
}

function savePending(batches: readonly CaptureBatch[]): void {
  const byThread = new Map<string, { botId: string; threadId: string; turnIds: string[] }>();
  for (const batch of batches) {
    const ids = batch.turns.map((turn) => turn.turnId).filter((id): id is string => typeof id === "string" && id.length > 0);
    if (!ids.length) continue;
    const key = `${batch.botId}\n${batch.threadId}`;
    const entry = byThread.get(key) ?? { botId: batch.botId, threadId: batch.threadId, turnIds: [] };
    entry.turnIds.push(...ids.filter((id) => !entry.turnIds.includes(id)));
    byThread.set(key, entry);
  }
  if (!byThread.size) return;
  const state: PendingCapture = {
    batches: [...byThread.values()].slice(-MAX_PENDING_THREADS).map((entry) => ({ ...entry, turnIds: entry.turnIds.slice(-CAPTURE_MAX_TURNS) })),
  };
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileAtomic(pendingPath(), `${JSON.stringify(state)}\n`, { mode: 0o600 });
  } catch {
  }
}

/** Removed before replay, so a start that fails part way never replays them twice. */
function takePending(): PendingCapture["batches"] {
  let raw: string;
  try {
    raw = readFileSync(pendingPath(), "utf8");
  } catch {
    return [];
  }
  rmSync(pendingPath(), { force: true });
  try {
    const parsed = JSON.parse(raw) as Partial<PendingCapture>;
    if (!Array.isArray(parsed?.batches)) return [];
    return parsed.batches
      .filter((batch) => batch && typeof batch.botId === "string" && typeof batch.threadId === "string" && Array.isArray(batch.turnIds))
      .slice(-MAX_PENDING_THREADS)
      .map((batch) => ({ botId: batch.botId, threadId: batch.threadId, turnIds: batch.turnIds.filter((id): id is string => typeof id === "string").slice(-CAPTURE_MAX_TURNS) }));
  } catch {
    return [];
  }
}

function dropPending(botId: string): void {
  let parsed: Partial<PendingCapture>;
  try {
    parsed = JSON.parse(readFileSync(pendingPath(), "utf8")) as Partial<PendingCapture>;
  } catch {
    return;
  }
  if (!Array.isArray(parsed?.batches)) return;
  const kept = parsed.batches.filter((batch) => batch?.botId !== botId);
  if (kept.length === parsed.batches.length) return;
  try {
    if (kept.length) writeFileAtomic(pendingPath(), `${JSON.stringify({ batches: kept })}\n`, { mode: 0o600 });
    else rmSync(pendingPath(), { force: true });
  } catch {
    // best effort: a deleted bot's saved turns are refused at capture anyway
  }
}

function readRaw(botId: string, relative: string): string | null {
  try {
    return readMemoryText(join(workspaceDir(botId), relative));
  } catch {
    return null;
  }
}

async function askModel(engine: UpkeepEngine, prompt: string, timeoutMs = MODEL_TIMEOUT_MS): Promise<string | null> {
  if (!engine.generateText) return null;
  const expiry = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException("The background model call timed out.", "TimeoutError");
      expiry.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    const answer = await Promise.race([engine.generateText(prompt, { signal: expiry.signal }), expired]);
    return typeof answer === "string" ? answer : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A flushed chat waiting for its capture call; `done` answers a caller of `capture`. */
interface Waiting {
  batch: CaptureBatch;
  done?: { resolve: (report: CaptureReport) => void; reject: (error: unknown) => void };
}

function callBytes(batch: CaptureBatch): number {
  const { said, replied } = captureSize(batch.turns);
  return said + replied;
}

/** A dream's ideas are offered until the next day's dream; older ones are dropped. */
export const IDEAS_FOR_MS = 24 * 60 * 60_000;
export const NO_DREAM_ENGINE = "This bot's engine cannot make the background model call a dream uses.";
export const NO_TEXT_ENGINE = "This bot's engine cannot make the quick background model call upkeep uses, so only expired notes and exact duplicates are tidied.";

export interface MemoryUpkeep {
  noteTurn(botId: string, threadId: string, turn: CaptureTurn): void;
  flushThread(threadId: string): void;
  dropBot(botId: string): void;
  forgetBot(botId: string): void;
  capture(batch: CaptureBatch): Promise<CaptureReport>;
  tidy(botId: string): Promise<TidyReport>;
  dream(botId: string): Promise<DreamReport>;
  /** The last dream's ideas while they are fresh, with how many chats it read. */
  ideas(botId: string): { ideas: string[]; conversations: number };
  status(botId: string): { lastTidy?: TidyReport; lastCapture?: CaptureReport; lastDream?: DreamReport; modelSteps: boolean };
  consolidateGeneral(): Promise<GeneralReport>;
  generalStatus(): { last?: GeneralReport };
  tick(): Promise<void>;
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  idle(): Promise<void>;
}

export function createMemoryUpkeep(deps: UpkeepDeps): MemoryUpkeep {
  const now = () => deps.now?.() ?? new Date();
  const log = (line: string) => deps.log?.(line);
  const inflight = new Set<Promise<unknown>>();
  const tidying = new Map<string, Promise<TidyReport>>();
  const dreaming = new Map<string, { generation: number; promise: Promise<DreamReport> }>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let first: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let paused = false;
  const cancelled = (started: number) => started !== generation || paused;
  // Flushed chats wait here, also through a backup; one worker drains it, one capture call at a time.
  const queue: Waiting[] = [];
  let worker: Promise<void> | null = null;

  // The reports this process knows about: read once, written when the batch that recorded them ends,
  // so a tick over a large workspace writes once however many bots it touches. A capture's batch also
  // writes while an outer tick batch is open: its report must outlive a restart mid-tick, and the tick
  // can be minutes away from its own write.
  let known: UpkeepState | null = null;
  let unsaved = false;
  const open: { dirty: boolean; flushWhileOpen: boolean }[] = [];

  const loaded = (): UpkeepState => (known ??= loadState());

  function flush(): void {
    if (!unsaved || !known) return;
    if (!saveState(known)) return;
    unsaved = false;
    for (const batch of open) batch.dirty = false;
  }

  /** One write for everything recorded inside `work`, however many bots it touches. */
  function batched<T>(work: () => Promise<T>, flushWhileOpen = false): Promise<T> {
    const batch = { dirty: false, flushWhileOpen };
    open.push(batch);
    const end = () => {
      const at = open.lastIndexOf(batch);
      if (at >= 0) open.splice(at, 1);
      if (batch.dirty && (batch.flushWhileOpen || !open.length)) flush();
    };
    let promise: Promise<T>;
    try {
      promise = work();
    } catch (error) {
      end();
      throw error;
    }
    return promise.finally(end);
  }

  const record = (botId: string, patch: { lastTidy?: TidyReport; lastCapture?: CaptureReport; topicCursor?: string; lastDream?: DreamReport; dreamedTo?: number; core?: string[] }) => {
    // a capture or tidy that was out when its bot was deleted leaves nothing behind
    if (!deps.bot(botId)) return;
    const state = loaded();
    state.bots[botId] = { ...state.bots[botId], ...patch };
    unsaved = true;
    if (!open.length) {
      flush();
      return;
    }
    for (const batch of open) batch.dirty = true;
  };

  const track = <T>(promise: Promise<T>): Promise<T> => {
    inflight.add(promise);
    void promise.finally(() => inflight.delete(promise)).catch(() => undefined);
    return promise;
  };

  const writing = deps.writing ?? (<T>(_botId: string, write: () => T): T => write());

  /** The general memory's facts as the capture step reads them, one per line; nothing on a Team Cloud. */
  function generalFacts(): string | undefined {
    if (!deps.general) return undefined;
    const lines = parseGeneral(deps.general.read()).map((entry) => `- ${entry.fact}`);
    return lines.length ? lines.join("\n") : undefined;
  }

  /** Strikes through, as superseded, the live entries of MEMORY.md and the topic files that `olds` name. */
  function supersedeInNotes(botId: string, olds: readonly string[], filed: { via: string; threadId?: string }): number {
    const names = namesFact(olds);
    const today = memoryDate(now());
    let struck = 0;
    const paths = ["MEMORY.md", ...listMemoryTopics(botId).filter((topic) => !isArchiveTopic(topic.name)).map((topic) => `memory/${topic.name}`)];
    for (const path of paths) {
      const before = readRaw(botId, path);
      if (!before) continue;
      const entries = parseMemoryEntries(before);
      const hits = entries.filter((entry) => !entry.struck && names(entry.body));
      if (!hits.length) continue;
      const change: NotebookChange = { drop: new Set(), strike: new Map(hits.map((entry) => [entry.line, undefined])), moved: 0 };
      const after = applyNotebookChange(before, entries, change, today);
      try {
        if (path === "MEMORY.md") writeMemoryFile(botId, after);
        else writeMemoryTopic(botId, path.slice("memory/".length), after);
      } catch (error) {
        log(`memory upkeep: could not mark a replaced note in ${path}: ${(error as Error).message}`);
        continue;
      }
      recordMemoryChange(botId, { path, actor: "upkeep", via: filed.via, threadId: filed.threadId, before, after: readRaw(botId, path) });
      struck += hits.length;
    }
    return struck;
  }

  /** Files items under one source label, with the step and thread (when there is one) on every journal row. */
  function fileCandidates(botId: string, candidates: readonly Candidate[], filed: { source: string; via: string; threadId?: string }): { added: number; topics: number; kept: { text: string; where: string }[] } {
    const before = readRaw(botId, "MEMORY.md");
    const archiveBefore = readRaw(botId, ARCHIVE_PATH);
    const fresh = newCandidates(candidates, before ?? "").filter((candidate) => !isForgotten(candidate.text) && !looksLikeInstruction(candidate.text));
    const { source, via, threadId } = filed;
    const kept: { text: string; where: string }[] = [];
    let added = 0;
    const byTopic = new Map<string, Candidate[]>();
    for (const candidate of fresh) {
      if (candidate.topic) {
        byTopic.set(candidate.topic, [...(byTopic.get(candidate.topic) ?? []), candidate]);
        continue;
      }
      if (updateMemory(botId, { action: "append", text: candidate.text, ...(candidate.until ? { until: candidate.until } : {}) }, { source, now: now() }).ok) {
        added += 1;
        kept.push({ text: candidate.text, where: "MEMORY.md" });
      }
    }
    // The archive is journaled before MEMORY.md, so undoing the newest row brings moved entries back.
    recordMemoryChange(botId, { path: ARCHIVE_PATH, actor: "upkeep", via, threadId, before: archiveBefore, after: readRaw(botId, ARCHIVE_PATH) });
    if (added) recordMemoryChange(botId, { path: "MEMORY.md", actor: "upkeep", via, threadId, before, after: readRaw(botId, "MEMORY.md") });
    const existing = new Map(listMemoryTopics(botId).map((topic) => [topic.name.toLowerCase(), topic.name]));
    let topics = 0;
    for (const [wanted, group] of byTopic) {
      const name = existing.get(wanted) ?? wanted;
      const path = `memory/${name}`;
      const full = readRaw(botId, path);
      if (full !== null && Buffer.byteLength(full, "utf8") > TOPIC_MAX_BYTES) {
        const archiveBefore = readRaw(botId, ARCHIVE_PATH);
        if (compactMemoryTopic(botId, name, TOPIC_MAX_BYTES, memoryDate(now()))) {
          recordMemoryChange(botId, { path: ARCHIVE_PATH, actor: "upkeep", via, threadId, before: archiveBefore, after: readRaw(botId, ARCHIVE_PATH) });
          recordMemoryChange(botId, { path, actor: "upkeep", via, threadId, before: full, after: readRaw(botId, path) });
        }
      }
      const current = readRaw(botId, path);
      if (current !== null && Buffer.byteLength(current, "utf8") > TOPIC_MAX_BYTES) continue;
      const seen = notebookIdentities(current ?? "");
      const unseen = group.filter((candidate) => !seen.has(factIdentity(candidate.text)));
      const lines = unseen.map((candidate) => memoryEntry(candidate.text, { source, now: now(), ...(candidate.until ? { until: candidate.until } : {}) }));
      if (!lines.length) continue;
      const title = name.replace(/\.md$/, "").replace(/-/g, " ");
      const aliases = [...new Set(group.flatMap((candidate) => candidate.topicAliases ?? []))];
      try {
        writeMemoryTopic(botId, name, mergeTopicText(current, { title, aliases, lines }));
      } catch {
        continue;
      }
      recordMemoryChange(botId, { path, actor: "upkeep", via, threadId, before: current, after: readRaw(botId, path) });
      existing.set(name.toLowerCase(), name);
      topics += lines.length;
      kept.push(...unseen.map((candidate) => ({ text: candidate.text, where: path })));
    }
    return { added, topics, kept };
  }

  /**
   * Which conversation each item came from. With several in one call and no valid "from", the guess is the
   * one with the most said, and a guess is used only where it cannot matter: the item is kept only if every
   * conversation still feeds memory, and reaches About me only if every one is the owner's own.
   */
  function attribute(candidates: readonly Candidate[], conversations: readonly CaptureBatch[], still: readonly boolean[]) {
    const owner = conversations.map((conversation) => conversation.turns.every((turn) => turn.owner !== false));
    const sizes = conversations.map((conversation) => captureSize(conversation.turns).said);
    const guess = sizes.indexOf(Math.max(...sizes));
    return candidates.flatMap((candidate) => {
      const named = conversations.length === 1 ? 0 : candidate.from !== undefined && candidate.from <= conversations.length ? candidate.from - 1 : -1;
      const sure = named >= 0;
      const at = sure ? named : guess;
      if (!still[at] || (!sure && !still.every(Boolean))) return [];
      // Only the owner's own words reach About me: another person's facts are not the owner's profile.
      return [{ candidate, at, aboutMe: candidate.aboutUser && owner[at]! && (sure || owner.every(Boolean)) }];
    });
  }

  /** The facts a capture call is shown, keyed F1…: those its conversations bring to mind, from the bot's notes and About me. */
  async function knownFacts(botId: string, conversations: readonly CaptureBatch[], today: string): Promise<Array<KnownFact & { fact: FactRow }>> {
    const said = conversations
      .flatMap((conversation) => conversation.turns.flatMap((turn) => turn.room ? turn.room.filter((line) => line.by === "person").map((line) => line.text) : [turn.person]))
      .join("\n")
      .slice(0, 1_500);
    if (!said.trim()) return [];
    try {
      const about = deps.general ? { owner: aboutOwner(), text: deps.general.read() } : undefined;
      const { facts } = await recallFacts({ memoryIds: [botId], ...(about ? { about } : {}), query: said, today, wide: true });
      return facts.slice(0, KNOWN_FACTS).map((item, i) => ({
        key: `F${i + 1}`,
        text: item.fact.text,
        where: item.fact.file === ABOUT_FILE ? "general memory" : item.fact.file === "MEMORY.md" ? "notebook" : item.fact.file,
        date: item.fact.validFrom,
        fact: item.fact,
      }));
    } catch (error) {
      log(`memory upkeep: could not look up known facts for capture: ${(error as Error).message}`);
      return [];
    }
  }

  /** Where a captured fact came from: the words quoted, and the message they were said in. */
  function noteProvenance(owner: string, file: string, candidate: Candidate, conversation: CaptureBatch): void {
    const quote = candidate.evidence ?? "";
    const folded = foldForMatch(quote);
    const said = (entry: CaptureTurn) => (candidate.kind === "outcome" ? entry.bot : entry.room ? entry.room.map((line) => line.text).join("\n") : entry.person);
    const turn = conversation.turns.find((entry) => folded && foldForMatch(said(entry)).includes(folded));
    const byOther = Boolean(turn?.room) && !turn!.room!.some((line) => line.by === "person" && foldForMatch(line.text).includes(folded));
    const source: FactSource = candidate.kind === "outcome" ? "bot-verified" : byOther ? "other-person" : "person-said";
    try {
      annotateFact(owner, file, candidate.text, {
        source,
        ...(quote ? { quote } : {}),
        refs: { threadId: conversation.threadId, ...(turn?.messageId ? { messageIds: [turn.messageId] } : {}) },
        ...(candidate.happened ? { happened: candidate.happened, kind: "event" as const } : {}),
      }, now().getTime());
    } catch (error) {
      log(`memory upkeep: could not record where a fact came from: ${(error as Error).message}`);
    }
  }

  /** One model call for one bot's waiting chats, each read as its own conversation. */
  async function captureCall(batches: readonly CaptureBatch[]): Promise<CaptureReport> {
    const started = generation;
    // The batch names where the facts go (a bot's own memory, or one of its layers on a Team Cloud); the bot record says whose.
    const id = batches[0]!.botId;
    const bot = deps.bot(id);
    const at = now().getTime();
    const off: CaptureReport = { at, added: 0, topics: 0, aboutMe: 0, note: "upkeep is off" };
    if (!upkeepEnabled(bot)) return off;
    const byThread = new Map<string, CaptureBatch>();
    for (const batch of batches) {
      const same = byThread.get(batch.threadId);
      if (same) same.turns.push(...batch.turns);
      else byThread.set(batch.threadId, { ...batch, turns: [...batch.turns] });
    }
    const allowed = (threadId: string) => deps.mayCapture?.(id, threadId) ?? true;
    const refused: CaptureReport = { at, added: 0, topics: 0, aboutMe: 0, note: "this conversation no longer feeds the bot's memory" };
    const conversations = [...byThread.values()].filter((conversation) => allowed(conversation.threadId));
    if (!conversations.length) return refused;
    const engine = deps.engine(id);
    if (!engine?.generateText) {
      const report = { at, added: 0, topics: 0, aboutMe: 0, note: NO_TEXT_ENGINE };
      record(id, { lastCapture: report });
      return report;
    }
    ensureWorkspace(id);
    const today = memoryDate(now());
    const known = await knownFacts(id, conversations, today);
    const answer = await askModel(engine, capturePrompt({
      botName: bot.name,
      conversations: conversations.map((conversation) => conversation.turns),
      notebook: readRaw(id, "MEMORY.md") ?? "",
      today,
      topics: memoryTopicIndex(id),
      general: generalFacts(),
      known: known.map(({ fact: _fact, ...shown }) => shown),
    }));
    if (started !== generation) return { ...off, note: "upkeep stopped" };
    if (answer === null) {
      const report = { at, added: 0, topics: 0, aboutMe: 0, note: "The capture call did not answer in time." };
      record(id, { lastCapture: report });
      return report;
    }
    if (paused) {
      queue.unshift(...conversations.map((batch) => ({ batch })));
      return { at, added: 0, topics: 0, aboutMe: 0, note: "deferred until the backup finishes" };
    }
    // Re-read after the await; from here to the journal rows there is no await, so no write interleaves.
    if (!upkeepEnabled(deps.bot(id))) return off;
    const still = conversations.map((conversation) => allowed(conversation.threadId));
    if (!still.some(Boolean)) return refused;
    const byKey = new Map(known.map((entry) => [entry.key, entry.fact]));
    const ended: FactRow[] = [];
    const parsed = parseCandidates(answer, today, captureItemLimit(conversations.length));
    const duplicate = await nearDuplicateOf(parsed.filter((candidate) => !candidate.verdict || candidate.verdict === "new").map((candidate) => candidate.text), known.map((entry) => entry.fact));
    type Filed = { candidate: Candidate; at: number; aboutMe: boolean; onlyAboutMe: boolean; moves?: FactRow };
    const filed = attribute(parsed, conversations, still).flatMap((item): Filed[] => {
      const turns = conversations[item.at]!.turns;
      if (isForgotten(item.candidate.text) || looksLikeInstruction(item.candidate.text) || !statedInConversation(item.candidate, turns, false)) return [];
      const aboutMe = item.aboutMe && statedInConversation(item.candidate, turns, true);
      const target = item.candidate.target ? byKey.get(item.candidate.target) : undefined;
      const verdict = item.candidate.verdict ?? "new";
      const same = target && verdict === "repeat" ? target : duplicate.get(item.candidate.text);
      if (same) {
        // already known: only a fact about the person kept in one bot's notes still belongs in About me
        return aboutMe && same.file !== ABOUT_FILE && deps.general ? [{ ...item, aboutMe, onlyAboutMe: true, moves: same }] : [];
      }
      if (target && verdict === "end") {
        ended.push(target);
        return [];
      }
      const candidate = target && verdict === "change" ? { ...item.candidate, replaces: target.text } : item.candidate;
      return [{ ...item, candidate, aboutMe, onlyAboutMe: false }];
    });
    const { added, topics } = writing(id, () => {
      let added = 0;
      let topics = 0;
      conversations.forEach((conversation, i) => {
        const mine = filed.filter((item) => item.at === i);
        // what changed an older note strikes that note first, so the new line is never mistaken for the old one
        const replaced = mine.flatMap((item) => item.candidate.replaces ? [item.candidate.replaces] : []);
        if (replaced.length) supersedeInNotes(id, replaced, { via: "capture", threadId: conversation.threadId });
        // a fact about the person lives once, in the general memory every bot reads, not again in each bot's notes
        const own = mine.filter((item) => !item.aboutMe && !item.onlyAboutMe).map((item) => item.candidate);
        if (!own.length) return;
        const result = fileCandidates(id, own, { source: `${deps.sourceLabel(id, conversation.threadId)} (noticed)`, via: "capture", threadId: conversation.threadId });
        added += result.added;
        topics += result.topics;
        for (const kept of result.kept) {
          const item = own.find((candidate) => candidate.text === kept.text);
          if (item) noteProvenance(id, kept.where, item, conversation);
        }
      });
      const endedNotes = ended.filter((fact) => fact.file !== ABOUT_FILE).map((fact) => fact.text);
      if (endedNotes.length) supersedeInNotes(id, endedNotes, { via: "capture" });
      return { added, topics };
    });
    const learned = filed.filter((item) => item.aboutMe).map((item) => item.candidate.text);
    const replacedAbout = [
      ...filed.filter((item) => item.aboutMe && item.candidate.replaces).map((item) => item.candidate.replaces!),
      ...ended.filter((fact) => fact.file === ABOUT_FILE).map((fact) => fact.text),
    ];
    const aboutMe = learned.length || replacedAbout.length ? deps.addToAboutMe({ botId: id, botName: bot.name }, learned, replacedAbout) : 0;
    // a fact about the person lives once, in About me: the copy in this bot's notes is struck as merged into it
    if (deps.general && filed.some((item) => item.onlyAboutMe && item.moves)) {
      const held = new Set(parseGeneral(deps.general.read()).map((line) => factIdentity(line.fact)));
      const copies = filed.filter((item) => item.onlyAboutMe && item.moves && held.has(factIdentity(item.candidate.text))).map((item) => item.moves!.text);
      if (copies.length) writing(id, () => supersedeInNotes(id, copies, { via: "capture" }));
    }
    if (aboutMe && deps.general) {
      for (const item of filed.filter((entry) => entry.aboutMe)) noteProvenance(aboutOwner(), ABOUT_FILE, item.candidate, conversations[item.at]!);
    }
    const organized = await organize(id);
    const report: CaptureReport = { at, added, topics, aboutMe, organized };
    if (cancelled(started)) return report;
    record(id, { lastCapture: report });
    if (added || topics || aboutMe) log(`memory upkeep: noticed ${added} fact(s) for MEMORY.md, ${topics} for topic files and ${aboutMe} for About me: ${bot.name} (${id}) from ${conversations.map((conversation) => conversation.threadId).join(", ")}`);
    return report;
  }

  /** The first waiting batch, with its bot's other waiting batches that fit in the same call. */
  function takeCall(): Waiting[] {
    const first = queue.shift()!;
    const call = [first];
    let turns = first.batch.turns.length;
    let bytes = callBytes(first.batch);
    for (let i = 0; i < queue.length;) {
      const next = queue[i]!;
      const size = callBytes(next.batch);
      if (next.batch.botId === first.batch.botId && turns + next.batch.turns.length <= CAPTURE_CALL_MAX_TURNS && bytes + size <= CAPTURE_CALL_MAX_BYTES) {
        call.push(...queue.splice(i, 1));
        turns += next.batch.turns.length;
        bytes += size;
      } else i += 1;
    }
    return call;
  }

  async function work(): Promise<void> {
    const started = generation;
    try {
      // chats flushed together are all queued before the first call takes its share
      await Promise.resolve();
      while (!cancelled(started) && queue.length) {
        const call = takeCall();
        try {
          const report = await batched(() => captureCall(call.map((entry) => entry.batch)), true);
          for (const entry of call) entry.done?.resolve(report);
        } catch (error) {
          log(`memory upkeep: capture failed for ${call[0]!.batch.botId}: ${(error as Error).message}`);
          for (const entry of call) entry.done?.reject(error);
        }
      }
    } finally {
      worker = null;
      kick();
    }
  }

  function kick(): void {
    if (!worker && !paused && queue.length) worker = track(work());
  }

  function enqueue(entry: Waiting): void {
    queue.push(entry);
    kick();
  }

  function dropQueued(botId: string): void {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i]!.batch.botId !== botId) continue;
      const [entry] = queue.splice(i, 1);
      entry!.done?.resolve({ at: now().getTime(), added: 0, topics: 0, aboutMe: 0, note: "upkeep is off" });
    }
  }

  const buffer = new CaptureBuffer({
    quietMs: deps.quietMs,
    maxTurns: CAPTURE_MAX_TURNS,
    gatherMs: CAPTURE_GATHER_MS,
    onFlush: (batch) => {
      // a test or a pleasantry has nothing to keep, so it costs no call
      if (worthCapturing(batch.turns)) enqueue({ batch });
    },
  });

  async function organize(botId: string): Promise<number> {
    const started = generation;
    const engine = deps.engine(botId);
    if (!engine?.generateText) return 0;
    const today = memoryDate(now());
    const core = new Set(loaded().bots[botId]?.core ?? []);
    const first = readRaw(botId, "MEMORY.md") ?? "";
    const candidates = organizeCandidates(first, today, core);
    if (!candidates.length) return 0;
    const answer = await askModel(engine, organizePrompt(candidates, memoryTopicIndex(botId)));
    if (answer === null || cancelled(started) || !upkeepEnabled(deps.bot(botId))) return 0;
    const before = readRaw(botId, "MEMORY.md") ?? "";
    if (before !== first) return 0;
    const proposed = parseMoves(answer, candidates);
    if (proposed === null) return 0;
    const moved = new Set(proposed.map((move) => move.entry.line));
    const moves = proposed.slice(0, MAX_MOVES);
    const judgedCore = candidates.filter((entry) => !moved.has(entry.line)).map((entry) => factIdentity(entry.body));
    record(botId, { core: [...new Set([...(loaded().bots[botId]?.core ?? []), ...judgedCore])].slice(-MAX_CORE) });
    if (!moves.length) return 0;
    return writing(botId, () => {
      const { byTopic } = applyMoves(before, moves);
      const written = new Set<string>();
      const existing = new Map(listMemoryTopics(botId).map((topic) => [topic.name.toLowerCase(), topic.name]));
      let count = 0;
      for (const [wanted, group] of byTopic) {
        const name = existing.get(wanted) ?? wanted;
        const path = `memory/${name}`;
        const current = readRaw(botId, path);
        const seen = notebookIdentities(current ?? "");
        const lines = group.lines.filter((line) => !seen.has(lineFactIdentity(line)));
        if (lines.length) {
          try {
            writeMemoryTopic(botId, name, mergeTopicText(current, { title: name.replace(/\.md$/, "").replace(/-/g, " "), aliases: group.aliases, lines }));
          } catch (error) {
            log(`memory upkeep: could not write ${path}; kept its entries in MEMORY.md: ${(error as Error).message}`);
            continue;
          }
          recordMemoryChange(botId, { path, actor: "upkeep", via: "organize", before: current, after: readRaw(botId, path) });
        }
        existing.set(name.toLowerCase(), name);
        written.add(wanted);
        count += group.lines.length;
      }
      if (!written.size) return 0;
      const { text } = applyMoves(before, moves.filter((move) => written.has(move.topic)));
      writeMemoryFile(botId, text);
      recordMemoryChange(botId, { path: "MEMORY.md", actor: "upkeep", via: "organize", before, after: readRaw(botId, "MEMORY.md") });
      log(`memory upkeep: moved ${count} entr${count === 1 ? "y" : "ies"} from MEMORY.md into topic files for ${deps.bot(botId)?.name ?? botId}`);
      return count;
    });
  }

  function appendArchive(botId: string, archived: readonly string[]): void {
    const archiveBefore = readRaw(botId, ARCHIVE_PATH);
    appendMemoryArchive(botId, archived);
    recordMemoryChange(botId, { path: ARCHIVE_PATH, actor: "upkeep", via: "tidy", before: archiveBefore, after: readRaw(botId, ARCHIVE_PATH) });
  }

  /** Topics whose live entries hold a close but not identical pair (a changed value often reads like this) go first,
   * so the few contradiction checks a night allows land where they are likely needed; the rest keep the cursor order. */
  async function likelyConflictsFirst<T extends { name: string }>(botId: string, topics: readonly T[], today: string): Promise<T[]> {
    if (!embedderReady() || topics.length <= MAX_TOPIC_CHECKS) return [...topics];
    const scored: Array<{ topic: T; score: number }> = [];
    for (const topic of topics.slice(0, CONFLICT_SCAN_TOPICS)) {
      const bodies = contradictionCandidates(readRaw(botId, `memory/${topic.name}`) ?? "", today).slice(-CONFLICT_SCAN_ENTRIES).map((entry) => entry.body);
      if (bodies.length < 2) continue;
      const vectors = await embedPassages(bodies);
      if (!vectors) return [...topics];
      let score = 0;
      for (let i = 0; i < vectors.length; i++) for (let j = i + 1; j < vectors.length; j++) {
        const sim = cosine(vectors[i]!, vectors[j]!);
        if (sim < SAME_FACT && sim > score) score = sim;
      }
      if (score >= LIKELY_CONFLICT) scored.push({ topic, score });
    }
    const first = scored.sort((a, b) => b.score - a.score).map((item) => item.topic);
    return [...first, ...topics.filter((topic) => !first.includes(topic))];
  }

  /** Every topic under its cap (old and replaced entries into the archive), and old daily logs folded by month. */
  function keepBounded(botId: string, today: string): void {
    for (const topic of listMemoryTopics(botId)) {
      const cap = topic.name === UNVERIFIED_TOPIC ? UNVERIFIED_MAX_BYTES : TOPIC_MAX_BYTES;
      if (isArchiveTopic(topic.name) || topic.bytes <= cap) continue;
      const path = `memory/${topic.name}`;
      const before = readRaw(botId, path);
      const archiveBefore = readRaw(botId, ARCHIVE_PATH);
      if (!compactMemoryTopic(botId, topic.name, cap, today)) continue;
      recordMemoryChange(botId, { path: ARCHIVE_PATH, actor: "upkeep", via: "tidy", before: archiveBefore, after: readRaw(botId, ARCHIVE_PATH) });
      recordMemoryChange(botId, { path, actor: "upkeep", via: "tidy", before, after: readRaw(botId, path) });
    }
    foldOldLogs(botId, today);
  }

  /** The pairs a model confirms state one fact; word-for-word pairs need no confirming. */
  async function confirmedPairs(pairs: readonly MergePair[], engine: UpkeepEngine | null, started: number): Promise<MergePair[]> {
    const exact = pairs.filter((pair) => pair.similarity === 1);
    const unsure = pairs.filter((pair) => pair.similarity < 1);
    if (!unsure.length || !engine?.generateText) return exact;
    const answer = await askModel(engine, mergePrompt(unsure));
    if (answer === null || cancelled(started)) return exact;
    return [...exact, ...parseMerge(answer, unsure.length).map((index) => unsure[index]!)];
  }

  /** Strikes through, as merged, the older line of each near-duplicate pair across MEMORY.md and the topic files. */
  async function mergeNotes(botId: string, engine: UpkeepEngine | null, started: number): Promise<number> {
    const today = memoryDate(now());
    const paths = ["MEMORY.md", ...listMemoryTopics(botId).filter((topic) => !isArchiveTopic(topic.name) && topic.name !== UNVERIFIED_TOPIC).map((topic) => `memory/${topic.name}`)];
    const read = new Map(paths.map((path) => [path, readRaw(botId, path) ?? ""]));
    const items: MergeItem[] = [];
    for (const [where, text] of read) {
      for (const entry of parseMemoryEntries(text)) if (!entry.struck && !isExpired(entry, today)) items.push({ where, line: entry.line, text: entry.body, date: entry.date });
    }
    const recent = items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, MERGE_ENTRIES);
    const pairs = await confirmedPairs(await mergePairs(recent), engine, started);
    if (!pairs.length || cancelled(started) || !upkeepEnabled(deps.bot(botId))) return 0;
    const losers = new Map<string, Set<number>>();
    for (const pair of pairs) {
      const loser = mergeLoser(pair);
      losers.set(loser.where, (losers.get(loser.where) ?? new Set()).add(loser.line));
    }
    let merged = 0;
    for (const [path, lines] of losers) {
      writing(botId, () => {
        const before = readRaw(botId, path) ?? "";
        if (before !== read.get(path)) return;
        const entries = parseMemoryEntries(before);
        const live = entries.filter((entry) => !entry.struck && !isExpired(entry, today)).length;
        const budget = path === "MEMORY.md" ? (live < MIN_ENTRIES_FOR_CONTRADICTIONS ? 0 : contradictionBudget(live)) : Math.max(1, contradictionBudget(live));
        const out = before.split("\n");
        let done = 0;
        for (const entry of entries) {
          if (done >= budget || !lines.has(entry.line) || entry.struck) continue;
          out[entry.line] = mergedLine(entry, today);
          done += 1;
        }
        if (!done) return;
        const after = out.join("\n");
        if (path === "MEMORY.md") writeMemoryFile(botId, after);
        else writeMemoryTopic(botId, path.slice("memory/".length), after);
        recordMemoryChange(botId, { path, actor: "upkeep", via: "merge", before, after: readRaw(botId, path) });
        merged += done;
      });
    }
    if (merged) log(`memory upkeep: merged ${merged} near-duplicate note(s) for ${deps.bot(botId)?.name ?? botId}`);
    return merged;
  }

  async function runTidy(botId: string): Promise<TidyReport> {
    const started = generation;
    const bot = deps.bot(botId);
    const at = now().getTime();
    const today = memoryDate(now());
    const stopped: TidyReport = { at, expired: 0, duplicates: 0, superseded: 0, deferred: 0, contradictionsChecked: false, note: "Memory upkeep is off or paused; no further changes were made." };
    if (cancelled(started) || !upkeepEnabled(bot)) return stopped;
    ensureWorkspace(botId);
    const organized = await organize(botId);
    if (cancelled(started) || !upkeepEnabled(deps.bot(botId))) return stopped;
    const first = readRaw(botId, "MEMORY.md") ?? "";
    const engine = deps.engine(botId);
    const candidates = contradictionCandidates(first, today);
    let contradictions: Contradiction[] = [];
    let contradictionsChecked = false;
    let note: string | undefined;
    if (!engine?.generateText) note = NO_TEXT_ENGINE;
    else if (candidates.length < MIN_ENTRIES_FOR_CONTRADICTIONS) note = `Contradictions are checked from ${MIN_ENTRIES_FOR_CONTRADICTIONS} notes on.`;
    else {
      const answer = await askModel(engine, contradictionPrompt(candidates));
      if (answer === null) note = "The contradiction check did not answer in time.";
      else {
        contradictions = parseContradictions(answer, candidates.length);
        contradictionsChecked = true;
      }
    }
    if (cancelled(started) || !upkeepEnabled(deps.bot(botId))) return stopped;
    // Re-read after the await: if the notes changed, the model's line numbers are stale.
    const before = readRaw(botId, "MEMORY.md") ?? "";
    if (before !== first && contradictions.length) {
      contradictions = [];
      note = "The notes changed during the check; contradictions wait for the next tidy-up.";
    }
    const plan = planTidy(before, today, contradictions);
    if (planChanges(plan)) {
      const { text, archived } = applyTidy(before, plan, today);
      // The archive is written first: a line is never out of MEMORY.md before it is in the archive.
      writing(botId, () => {
        if (archived.length) appendArchive(botId, archived);
        writeMemoryFile(botId, text);
      });
      recordMemoryChange(botId, { path: "MEMORY.md", actor: "upkeep", via: "tidy", before, after: readRaw(botId, "MEMORY.md") });
    }
    let topicExpired = 0;
    let topicDuplicates = 0;
    let topicSuperseded = 0;
    let topicDeferred = 0;
    let topicChecks = 0;
    let topicsDeferred = 0;
    let topicCursor = loaded().bots[botId]?.topicCursor;
    const deadline = Date.now() + MODEL_TIMEOUT_MS;
    const topics = listMemoryTopics(botId).filter(topic => !isArchiveTopic(topic.name)).sort((a, b) => a.name.localeCompare(b.name));
    const cursorAt = topics.findIndex(topic => topic.name === topicCursor) + 1;
    for (const topic of await likelyConflictsFirst(botId, [...topics.slice(cursorAt), ...topics.slice(0, cursorAt)], today)) {
      const path = `memory/${topic.name}`;
      const topicBefore = readRaw(botId, path);
      if (topicBefore === null) continue;
      const topicCandidates = contradictionCandidates(topicBefore, today);
      let topicContradictions: Contradiction[] = [];
      if (engine?.generateText && topicCandidates.length >= 2) {
        const remaining = deadline - Date.now();
        if (topicChecks >= MAX_TOPIC_CHECKS || remaining <= 0) topicsDeferred++;
        else {
          topicChecks++;
          topicCursor = topic.name;
          const answer = await askModel(engine, contradictionPrompt(topicCandidates), remaining);
          if (cancelled(started) || !upkeepEnabled(deps.bot(botId))) return stopped;
          if (readRaw(botId, path) !== topicBefore) {
            topicsDeferred++;
            continue;
          }
          if (answer !== null) {
            topicContradictions = parseContradictions(answer, topicCandidates.length);
            contradictionsChecked = true;
            if (note?.startsWith("Contradictions are checked from")) note = undefined;
          } else topicsDeferred++;
        }
      }
      const topicPlan = planTidy(topicBefore, today, topicContradictions, 1);
      topicSuperseded += topicPlan.superseded.length;
      topicDeferred += topicPlan.deferred;
      if (!planChanges(topicPlan)) continue;
      const tidied = applyTidy(topicBefore, topicPlan, today);
      writing(botId, () => {
        if (tidied.archived.length) appendArchive(botId, tidied.archived);
        writeMemoryTopic(botId, topic.name, tidied.text);
      });
      recordMemoryChange(botId, { path, actor: "upkeep", via: "tidy", before: topicBefore, after: readRaw(botId, path) });
      topicExpired += topicPlan.expired.length;
      topicDuplicates += topicPlan.duplicates.length;
    }
    if (topicsDeferred) note = [note, `${topicsDeferred} topic checks deferred because of the budget, a timeout or concurrent edits.`].filter(Boolean).join(" ");
    try {
      writing(botId, () => keepBounded(botId, today));
    } catch (error) {
      log(`memory upkeep: could not compact ${botId}'s notes: ${(error as Error).message}`);
    }
    void rotateMemoryJournal(botId).catch((error: unknown) => log(`memory upkeep: could not rotate ${botId}'s journal: ${(error as Error).message}`));
    let merged = 0;
    try {
      merged = await mergeNotes(botId, engine, started);
    } catch (error) {
      log(`memory upkeep: near-duplicate merge failed for ${botId}: ${(error as Error).message}`);
    }
    if (cancelled(started) || !upkeepEnabled(deps.bot(botId))) return stopped;
    const report: TidyReport = {
      at,
      expired: plan.expired.length + topicExpired,
      duplicates: plan.duplicates.length + topicDuplicates,
      superseded: plan.superseded.length + topicSuperseded,
      deferred: plan.deferred + topicDeferred,
      ...(organized ? { organized } : {}),
      ...(merged ? { merged } : {}),
      contradictionsChecked,
      topicChecks,
      topicsDeferred,
      ...(note ? { note } : {}),
    };
    record(botId, { lastTidy: report, topicCursor });
    if (report.expired || report.duplicates || report.superseded || organized) log(`memory upkeep: tidied ${bot?.name ?? botId}: ${report.expired} expired, ${report.duplicates} duplicate(s), ${report.superseded} contradicted`);
    return report;
  }

  function tidy(botId: string): Promise<TidyReport> {
    const running = tidying.get(botId);
    if (running) return running;
    const promise = track(batched(() => runTidy(botId))).finally(() => tidying.delete(botId));
    tidying.set(botId, promise);
    return promise;
  }

  /** Reads the chats since the last dream that answered; the first one looks back a week. */
  function dreamSince(botId: string, at: number): number {
    return loaded().bots[botId]?.dreamedTo ?? at - DREAM_FIRST_LOOKBACK_MS;
  }

  async function runDream(botId: string): Promise<DreamReport> {
    const started = generation;
    const bot = deps.bot(botId);
    const at = now().getTime();
    const report = (note: string, conversations = 0): DreamReport => ({ at, conversations, learned: [], outdated: [], ideas: [], aboutMe: 0, note });
    if (cancelled(started) || !upkeepEnabled(bot)) return report("Memory upkeep is off or paused, so nothing was read.");
    if (!deps.conversations) return report("Dreaming is not available here.");
    const engine = deps.engine(botId);
    if (!engine?.generateText) {
      const off = report(NO_DREAM_ENGINE);
      record(botId, { lastDream: off });
      return off;
    }
    const conversations = deps.conversations(botId, dreamSince(botId, at));
    if (conversations.length < DREAM_MIN_CONVERSATIONS) {
      const few = report(`A dream needs at least ${DREAM_MIN_CONVERSATIONS} chats where you wrote since the last one; there ${conversations.length === 1 ? "is 1" : `are ${conversations.length}`}.`, conversations.length);
      record(botId, { lastDream: few });
      return few;
    }
    ensureWorkspace(botId);
    const today = memoryDate(now());
    const first = readRaw(botId, "MEMORY.md") ?? "";
    const notebook = contradictionCandidates(first, today);
    const answer = await askModel(engine, dreamPrompt({ botName: bot.name, today, conversations, notebook, topics: memoryTopicIndex(botId) }), DREAM_TIMEOUT_MS);
    if (cancelled(started) || !upkeepEnabled(deps.bot(botId))) return report("Memory upkeep was stopped, switched off or paused during the dream; no changes were made.", conversations.length);
    if (answer === null) {
      const late = report("The dream did not answer in time.", conversations.length);
      record(botId, { lastDream: late });
      return late;
    }
    const dreamt = parseDream(answer, conversations.length, notebook.length);
    const source = `dream across ${conversations.length} chats`;
    // Re-read inside the write: if the notes changed after the prompt, its line numbers are stale.
    const written = writing(botId, () => {
      const before = readRaw(botId, "MEMORY.md") ?? "";
      const outdated: DreamReport["outdated"] = [];
      const stale = dreamt.outdated.length > 0 && before !== first;
      if (!stale) {
        for (const item of dreamt.outdated) {
          const entry = notebook[item.line]!;
          if (updateMemory(botId, { action: "supersede", oldText: entry.body, text: item.now }, { source, now: now() }).ok) outdated.push({ was: entry.body, now: item.now });
        }
        if (outdated.length) recordMemoryChange(botId, { path: "MEMORY.md", actor: "upkeep", via: "dream", before, after: readRaw(botId, "MEMORY.md") });
      }
      // a pattern with no words of the Person behind it is kept as a topic note, never in always-loaded memory
      const candidates: Candidate[] = dreamt.learned.map((item) => dreamEvidenced(item, conversations) ? {
        text: item.text,
        kind: "preference",
        aboutUser: item.aboutUser,
        ...(item.topic ? { topic: item.topic } : {}),
        ...(item.topicAliases ? { topicAliases: item.topicAliases } : {}),
      } : { text: item.text, kind: "preference", aboutUser: false, topic: item.topic ?? "habits.md", topicAliases: item.topicAliases ?? ["patterns", "routine", "usually"] });
      for (const item of dreamt.declined) if (dreamNoticedEvidenced(item, conversations)) candidates.push({ text: `The person turned down this offer: ${item.text}`, kind: "preference", aboutUser: false, topic: "declined.md", topicAliases: ["offers", "turned down", "no thanks", "don't suggest"] });
      const { kept } = candidates.length ? fileCandidates(botId, candidates, { source, via: "dream" }) : { kept: [] };
      return { outdated, kept, stale };
    });
    const aboutUser = dreamt.learned.filter((item) => item.aboutUser && dreamEvidenced(item, conversations)).map((item) => item.text);
    const aboutMe = aboutUser.length ? deps.addToAboutMe({ botId, botName: bot.name }, aboutUser) : 0;
    const missed = deps.missed?.(botId, dreamt.missed.filter((item) => dreamNoticedEvidenced(item, conversations)).map((item) => item.text)) ?? 0;
    const done: DreamReport = {
      at,
      conversations: conversations.length,
      learned: written.kept,
      outdated: written.outdated,
      ideas: dreamt.ideas.map((idea) => idea.text),
      aboutMe,
      ...(written.stale ? { note: "The notes changed during the dream, so outdated notes wait for the next one." } : {}),
    };
    record(botId, { lastDream: done, dreamedTo: at });
    log(`memory upkeep: ${bot.name} (${botId}) dreamt over ${conversations.length} chats: ${done.learned.length} learned, ${done.outdated.length} updated, ${done.ideas.length} idea(s), ${missed} missed ask(s), ${aboutMe} for About me`);
    return done;
  }

  function dream(botId: string): Promise<DreamReport> {
    const started = generation;
    const running = dreaming.get(botId);
    if (running?.generation === started) return running.promise;
    const promise = track(batched(() => runDream(botId))).finally(() => {
      if (dreaming.get(botId)?.promise === promise) dreaming.delete(botId);
    });
    dreaming.set(botId, { generation: started, promise });
    return promise;
  }

  const recordGeneral = (report: GeneralReport) => {
    const state = loaded();
    state.general = { last: report };
    unsaved = true;
    if (!open.length) flush();
    else for (const batch of open) batch.dirty = true;
  };

  /** Up to `limit` notebook lines, shared out across bots in turn so every bot is read; within a bot, the lines most like
   * a general memory line first (when embeddings are ready), else the newest. */
  async function fairNotebookLines(perBot: readonly NotebookLine[][], general: readonly string[], limit: number): Promise<NotebookLine[]> {
    const ranked: NotebookLine[][] = [];
    for (const lines of perBot) {
      const newest = [...lines].sort((a, b) => b.entry.date.localeCompare(a.entry.date) || b.entry.line - a.entry.line);
      let order = newest;
      if (embedderReady() && general.length && newest.length) {
        const vectors = await embedPassages([...newest.map((line) => line.entry.body), ...general]);
        if (vectors) {
          const score = newest.map((_, i) => Math.max(...general.map((__, j) => cosine(vectors[i]!, vectors[newest.length + j]!))));
          order = newest.map((line, i) => ({ line, score: score[i]! })).sort((a, b) => b.score - a.score).map((item) => item.line);
        }
      }
      ranked.push(order);
    }
    const out: NotebookLine[] = [];
    for (let round = 0; out.length < limit && ranked.some((lines) => lines.length > round); round++) {
      for (const lines of ranked) if (lines[round] && out.length < limit) out.push(lines[round]!);
    }
    return out;
  }

  /** Learned About me lines that state one fact twice: the older leaves into the history, at most a third a pass. */
  async function mergeGeneral(general: NonNullable<UpkeepDeps["general"]>, engine: UpkeepEngine | null, started: number): Promise<number> {
    const text = general.read();
    const learned = parseGeneral(text).filter((entry) => entry.learned);
    const items: MergeItem[] = learned.map((entry) => ({ where: "about", line: entry.line, text: entry.fact, date: entry.date ?? "" }));
    const pairs = await confirmedPairs(await mergePairs(items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, MERGE_ENTRIES)), engine, started);
    if (!pairs.length || cancelled(started) || general.read() !== text) return 0;
    const budget = Math.max(learned.length < 6 ? 1 : 0, Math.floor(learned.length / 3));
    const gone = new Set(pairs.map((pair) => mergeLoser(pair).line).slice(0, budget));
    const removed = learned.filter((entry) => gone.has(entry.line));
    if (!removed.length) return 0;
    general.write(text.split("\n").filter((_, index) => !gone.has(index)).join("\n"));
    dropLearnedLines(removed.map((entry) => entry.raw));
    recordGeneralHistory(removed.map((entry) => ({ raw: entry.raw, fact: entry.fact, reason: "duplicate" as const })));
    general.changed();
    return removed.length;
  }

  /** One pass over the general memory and every bot's MEMORY.md, written by one bot's own engine. */
  async function runConsolidation(): Promise<GeneralReport> {
    const started = generation;
    const at = now().getTime();
    const today = memoryDate(now());
    const report = (note?: string, counts?: Partial<GeneralReport>): GeneralReport => ({ at, removed: 0, promoted: 0, notes: 0, ...counts, ...(note ? { note } : {}) });
    const general = deps.general;
    if (!general) return report("There is no single general memory here.");
    const bots = deps.bots().filter((bot) => upkeepEnabled(bot));
    const runner = bots.find((bot) => deps.engine(bot.id)?.generateText);
    if (!runner) {
      const done = report(NO_TEXT_ENGINE);
      recordGeneral(done);
      return done;
    }
    let merged = 0;
    try {
      // word-for-word repeats never reach About me, so without embeddings there is nothing to pair
      if (embedderReady()) merged = await mergeGeneral(general, deps.engine(runner.id), started);
    } catch (error) {
      log(`memory upkeep: About me near-duplicate merge failed: ${(error as Error).message}`);
    }
    if (cancelled(started)) return report("upkeep stopped");
    const textBefore = general.read();
    const parsedGeneral = parseGeneral(textBefore);
    const lines = [...parsedGeneral.filter((entry) => !entry.learned), ...parsedGeneral.filter((entry) => entry.learned).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))].slice(0, PROMPT_LINES);
    const before = new Map<string, string>();
    const perBot: NotebookLine[][] = [];
    for (const bot of bots) {
      const text = readRaw(bot.id, "MEMORY.md") ?? "";
      before.set(bot.id, text);
      perBot.push(parseMemoryEntries(text).filter((entry) => !entry.struck && !isExpired(entry, today)).map((entry) => ({ botId: bot.id, botName: bot.name, entry })));
    }
    const notebooks = await fairNotebookLines(perBot, lines.map((entry) => entry.fact), PROMPT_LINES);
    if (lines.filter((entry) => entry.learned).length + notebooks.length < 2) {
      const done = report("Nothing to consolidate yet.");
      recordGeneral(done);
      return done;
    }
    const promote = general.promote();
    const answer = await askModel(deps.engine(runner.id)!, consolidatePrompt({ general: lines, notebooks, promote, today }));
    if (cancelled(started)) return report("upkeep stopped");
    if (answer === null) {
      const done = report("The consolidation call did not answer in time.");
      recordGeneral(done);
      return done;
    }
    const parsed = parseConsolidation(answer, { general: lines.length, notebooks: notebooks.length });
    if (!parsed) {
      const done = report("The consolidation answer could not be read.");
      recordGeneral(done);
      return done;
    }
    // written by the person or a capture while the model thought: the next pass reads the new text
    if (general.read() !== textBefore) return report("General memory changed meanwhile; it is consolidated next time.");
    const removedByPerson = new Set(learnedState().removed);
    const plan = planConsolidation(lines, notebooks, parsed, {
      text: textBefore, today, promote,
      blocked: (fact) => isForgotten(fact) || removedByPerson.has(factIdentity(fact)),
    });
    // general memory first: a line moved out of a bot's notes is already in it if the notebook write fails
    if (plan.text !== textBefore) {
      general.write(plan.text);
      commitLearned(plan.added.filter((entry) => entry.botId).map((entry) => ({ id: randomUUID(), text: entry.fact, line: entry.line, botId: entry.botId, botName: entry.botName, at })));
      if (plan.removed.length) {
        dropLearnedLines(plan.removed.map((entry) => entry.raw));
        recordGeneralHistory(plan.removed, at);
      }
      general.changed();
    }
    let notes = 0;
    for (const [botId, change] of plan.notebooks) {
      writing(botId, () => {
        const current = readRaw(botId, "MEMORY.md") ?? "";
        if (current !== before.get(botId)) return;
        const next = applyNotebookChange(current, parseMemoryEntries(current), change, today);
        if (next === current) return;
        writeMemoryFile(botId, next);
        recordMemoryChange(botId, { path: "MEMORY.md", actor: "upkeep", via: "general", before: current, after: readRaw(botId, "MEMORY.md") });
        notes += change.drop.size + change.strike.size;
      });
    }
    const done = report(undefined, { removed: plan.removed.length + merged, promoted: plan.added.filter((entry) => entry.botId).length, notes });
    recordGeneral(done);
    if (done.removed || done.promoted || done.notes) log(`memory upkeep: general memory consolidated: ${done.removed} line(s) out (in its history), ${done.promoted} moved in from bots' notes, ${done.notes} bot note(s) tidied`);
    return done;
  }

  let consolidating: Promise<GeneralReport> | null = null;
  function consolidateGeneral(): Promise<GeneralReport> {
    consolidating ??= track(batched(() => runConsolidation())).finally(() => { consolidating = null; });
    return consolidating;
  }

  function generalDue(): boolean {
    const current = now();
    if (!deps.general || current.getHours() < deps.tidyHour()) return false;
    const last = loaded().general?.last?.at;
    return !last || memoryDate(new Date(last)) < memoryDate(current);
  }

  function dreamDue(botId: string): boolean {
    const current = now();
    const saved = loaded().bots[botId];
    if (deps.dreamer?.() !== botId || !deps.conversations || current.getHours() < deps.tidyHour()) return false;
    if (saved?.lastDream && memoryDate(new Date(saved.lastDream.at)) >= memoryDate(current)) return false;
    return deps.conversations(botId, dreamSince(botId, current.getTime())).length >= DREAM_MIN_CONVERSATIONS;
  }

  function due(botId: string): boolean {
    const current = now();
    if (current.getHours() < deps.tidyHour()) return false;
    const last = loaded().bots[botId]?.lastTidy?.at;
    return !last || memoryDate(new Date(last)) < memoryDate(current);
  }

  let prunedOn = "";
  async function tick(): Promise<void> {
    const started = generation;
    if (cancelled(started)) return;
    // One batch: the state file is written once at the end however many bots this tick touches.
    await batched(async () => {
      for (const bot of deps.bots()) {
        if (cancelled(started)) return;
        if (!upkeepEnabled(bot) || deps.busy(bot.id)) continue;
        if (due(bot.id)) {
          try {
            await tidy(bot.id);
          } catch (error) {
            log(`memory upkeep: tidy failed for ${bot.id}: ${(error as Error).message}`);
          }
        }
        if (cancelled(started)) return;
        try {
          if (deps.busy(bot.id) || !dreamDue(bot.id)) continue;
          await dream(bot.id);
        } catch (error) {
          log(`memory upkeep: dream failed for ${bot.id}: ${(error as Error).message}`);
        }
      }
      const today = memoryDate(now());
      if (prunedOn !== today) {
        prunedOn = today;
        try {
          pruneRetiredFacts(RETIRED_FACTS_KEEP_MS, now().getTime());
        } catch (error) {
          log(`memory upkeep: could not prune forgotten facts: ${(error as Error).message}`);
        }
      }
      // after each bot's own tidy-up, so it reads notes already free of exact duplicates and expired lines
      if (cancelled(started) || !generalDue()) return;
      try {
        await consolidateGeneral();
      } catch (error) {
        log(`memory upkeep: general memory consolidation failed: ${(error as Error).message}`);
      }
    });
  }

  return {
    noteTurn(botId, threadId, turn) {
      if (!upkeepEnabled(deps.bot(botId))) return;
      if (!turn.person.trim() && !turn.bot.trim()) return;
      buffer.add(botId, threadId, turn);
    },
    flushThread: (threadId) => buffer.flush(threadId),
    dropBot(botId) {
      buffer.dropBot(botId);
      dropQueued(botId);
    },
    forgetBot(botId) {
      buffer.dropBot(botId);
      dropQueued(botId);
      dropPending(botId);
      const state = loaded();
      if (!state.bots[botId]) return;
      delete state.bots[botId];
      unsaved = true;
      flush();
    },
    capture: (batch) => new Promise<CaptureReport>((resolve, reject) => enqueue({ batch, done: { resolve, reject } })),
    tidy,
    dream,
    ideas(botId) {
      const last = loaded().bots[botId]?.lastDream;
      return last && now().getTime() - last.at < IDEAS_FOR_MS ? { ideas: last.ideas, conversations: last.conversations } : { ideas: [], conversations: 0 };
    },
    status(botId) {
      const { lastTidy, lastCapture, lastDream } = loaded().bots[botId] ?? {};
      return { ...(lastTidy ? { lastTidy } : {}), ...(lastCapture ? { lastCapture } : {}), ...(lastDream ? { lastDream } : {}), modelSteps: Boolean(deps.engine(botId)?.generateText) };
    },
    consolidateGeneral,
    generalStatus: () => (loaded().general?.last ? { last: loaded().general!.last } : {}),
    tick,
    start() {
      if (timer) return;
      if (deps.restoreTurn) {
        try {
          for (const saved of takePending()) {
            if (!upkeepEnabled(deps.bot(saved.botId))) continue;
            for (const turnId of saved.turnIds) {
              const turn = deps.restoreTurn(saved.botId, saved.threadId, turnId);
              if (turn && (turn.person.trim() || turn.bot.trim())) buffer.add(saved.botId, saved.threadId, { ...turn, turnId });
            }
          }
        } catch (error) {
          log(`memory upkeep: could not queue turns saved at the last shutdown: ${(error as Error).message}`);
        }
      }
      const started = ++generation;
      const scheduledTick = () => { if (started === generation) void tick(); };
      timer = setInterval(scheduledTick, TIDY_CHECK_MS);
      timer.unref?.();
      first = setTimeout(scheduledTick, 60_000);
      first.unref?.();
    },
    stop() {
      generation++;
      if (timer) clearInterval(timer);
      timer = null;
      if (first) clearTimeout(first);
      first = null;
      const queued = queue.splice(0);
      for (const entry of queued) entry.done?.resolve({ at: now().getTime(), added: 0, topics: 0, aboutMe: 0, note: "kept for the next start" });
      const waiting = [...queued.map((entry) => entry.batch), ...buffer.drain()];
      if (deps.restoreTurn) savePending(waiting);
      // Whatever the last tick recorded is on disk before the timer stops carrying it.
      flush();
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      kick();
    },
    async idle() {
      while (inflight.size) await Promise.allSettled(inflight);
    },
  };
}
