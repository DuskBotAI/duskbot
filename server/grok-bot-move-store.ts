// The Grok Bot move's records on this computer: each move and what it made (for progress after a restart and for
// "Undo this move"), the bots asked for the rest and what came back, and the conversation each moved bot's recent chat
// went to. User-side data, so it lives in the local database beside the messages (docs/mongodb.md), owner-only.
import type { DatabaseSync } from "node:sqlite";

import type { GrokMoveProgress, GrokWaitingBot } from "../shared/grok-move.ts";
import { moveStateDb } from "./message-db.ts";

/** What one bot's move made, so undo removes exactly that. */
export interface MovedBotRecord {
  rosterId: string;
  botId: string;
  /** The bot was made by this move; otherwise it was here already and updated. */
  created: boolean;
  /** The conversation this move made for its recent chat. */
  threadId?: string;
  /** The last message this move wrote into its recent chat: anything after it was said here. */
  chatEnd?: string;
}

export interface MoveRecord {
  progress: GrokMoveProgress;
  moved: MovedBotRecord[];
}

/** The file a waiting bot's export was last read from, so the same file is not applied twice. */
export interface WaitingRecord extends GrokWaitingBot {
  seen?: { name: string; modifiedAt: number };
}

const ready = new WeakSet<DatabaseSync>();

function db(): DatabaseSync {
  const database = moveStateDb();
  if (ready.has(database)) return database;
  database.exec(`
    CREATE TABLE IF NOT EXISTS grok_moves (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS grok_moves_started ON grok_moves(started_at);
    CREATE TABLE IF NOT EXISTS grok_waiting (
      roster_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS grok_bot_chats (
      bot_id TEXT PRIMARY KEY,
      roster_id TEXT NOT NULL,
      thread_id TEXT NOT NULL
    );
  `);
  ready.add(database);
  return database;
}

export function saveMove(record: MoveRecord): void {
  db().prepare("INSERT INTO grok_moves(id, started_at, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json")
    .run(record.progress.moveId, record.progress.startedAt, JSON.stringify(record));
}

export function loadMove(moveId: string): MoveRecord | null {
  const row = db().prepare("SELECT json FROM grok_moves WHERE id = ?").get(moveId) as { json: string } | undefined;
  return row ? JSON.parse(row.json) as MoveRecord : null;
}

export function lastMove(): MoveRecord | null {
  const row = db().prepare("SELECT json FROM grok_moves ORDER BY started_at DESC, rowid DESC LIMIT 1").get() as { json: string } | undefined;
  return row ? JSON.parse(row.json) as MoveRecord : null;
}

/** The last message the newest move wrote into this bot's recent chat. */
export function chatEndOf(botId: string): string | null {
  const rows = db().prepare("SELECT json FROM grok_moves ORDER BY started_at DESC, rowid DESC").all() as Array<{ json: string }>;
  for (const row of rows) {
    const end = (JSON.parse(row.json) as MoveRecord).moved.find((moved) => moved.botId === botId && moved.chatEnd)?.chatEnd;
    if (end) return end;
  }
  return null;
}

export function unfinishedMoves(): MoveRecord[] {
  return (db().prepare("SELECT json FROM grok_moves").all() as Array<{ json: string }>)
    .map((row) => JSON.parse(row.json) as MoveRecord)
    .filter((record) => record.progress.state === "running" || record.progress.state === "stopping");
}

export function saveWaiting(entry: WaitingRecord): void {
  db().prepare("INSERT INTO grok_waiting(roster_id, bot_id, json) VALUES (?, ?, ?) ON CONFLICT(roster_id) DO UPDATE SET bot_id = excluded.bot_id, json = excluded.json")
    .run(entry.rosterId, entry.botId, JSON.stringify(entry));
}

export function waitingEntries(): WaitingRecord[] {
  return (db().prepare("SELECT json FROM grok_waiting ORDER BY rowid").all() as Array<{ json: string }>).map((row) => JSON.parse(row.json) as WaitingRecord);
}

export function forgetWaitingForBot(botId: string): void {
  db().prepare("DELETE FROM grok_waiting WHERE bot_id = ?").run(botId);
}

export function chatThreadOf(botId: string): string | null {
  const row = db().prepare("SELECT thread_id FROM grok_bot_chats WHERE bot_id = ?").get(botId) as { thread_id: string } | undefined;
  return row?.thread_id ?? null;
}

export function saveChatThread(botId: string, rosterId: string, threadId: string): void {
  db().prepare("INSERT INTO grok_bot_chats(bot_id, roster_id, thread_id) VALUES (?, ?, ?) ON CONFLICT(bot_id) DO UPDATE SET roster_id = excluded.roster_id, thread_id = excluded.thread_id")
    .run(botId, rosterId, threadId);
}

export function forgetChatThread(botId: string): void {
  db().prepare("DELETE FROM grok_bot_chats WHERE bot_id = ?").run(botId);
}
