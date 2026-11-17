import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { DATA_DIR } from "../config.ts";

export type TaskStatus = "queued" | "in_progress" | "paused" | "completed" | "failed" | "cancelled";

export interface TaskRecord {
  taskId: string;
  botId: string;
  threadId: string;
  title: string;
  status: TaskStatus;
  payloadJson: string;
  priority: number;
  error?: string | null;
  createdAt: number;
  updatedAt: number;
}

const DEFAULT_DB_PATH = join(DATA_DIR, "tasks.wal.sqlite");

export class PersistentTaskQueue {
  private db: DatabaseSync;
  private isOpen = true;

  constructor(dbPath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.initSchema();
    this.recoverIncompleteTasks();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_queue (
        task_id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        priority INTEGER DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_queue_lookup ON task_queue (bot_id, status, priority DESC);
    `);
  }

  private recoverIncompleteTasks(): void {
    const now = Date.now();
    this.db.exec(`
      UPDATE task_queue 
      SET status = 'paused', 
          error = 'Interrupted by application reboot or unexpected termination; paused for safety',
          updated_at = ${now}
      WHERE status = 'in_progress';
    `);
  }

  enqueue(task: {
    taskId: string;
    botId: string;
    threadId: string;
    title: string;
    payloadJson: string;
    priority?: number;
  }): TaskRecord {
    const now = Date.now();
    const priority = task.priority ?? 0;
    const stmt = this.db.prepare(`
      INSERT INTO task_queue (task_id, bot_id, thread_id, title, status, payload_json, priority, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, NULL, ?, ?)
    `);
    stmt.run(task.taskId, task.botId, task.threadId, task.title, task.payloadJson, priority, now, now);

    return {
      taskId: task.taskId,
      botId: task.botId,
      threadId: task.threadId,
      title: task.title,
      status: "queued",
      payloadJson: task.payloadJson,
      priority,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateStatus(taskId: string, status: TaskStatus, error?: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE task_queue
      SET status = ?, error = ?, updated_at = ?
      WHERE task_id = ?
    `);
    stmt.run(status, error ?? null, now, taskId);
  }

  getNextPending(botId: string): TaskRecord | null {
    const stmt = this.db.prepare(`
      SELECT task_id as taskId, bot_id as botId, thread_id as threadId, title,
             status, payload_json as payloadJson, priority, error, created_at as createdAt, updated_at as updatedAt
      FROM task_queue
      WHERE bot_id = ? AND status = 'queued'
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `);
    const row = stmt.get(botId) as TaskRecord | undefined;
    return row ?? null;
  }

  listTasks(botId: string, status?: TaskStatus): TaskRecord[] {
    if (status) {
      const stmt = this.db.prepare(`
        SELECT task_id as taskId, bot_id as botId, thread_id as threadId, title,
               status, payload_json as payloadJson, priority, error, created_at as createdAt, updated_at as updatedAt
        FROM task_queue
        WHERE bot_id = ? AND status = ?
        ORDER BY priority DESC, created_at ASC
      `);
      return stmt.all(botId, status) as unknown as TaskRecord[];
    }
    const stmt = this.db.prepare(`
      SELECT task_id as taskId, bot_id as botId, thread_id as threadId, title,
             status, payload_json as payloadJson, priority, error, created_at as createdAt, updated_at as updatedAt
      FROM task_queue
      WHERE bot_id = ?
      ORDER BY priority DESC, created_at ASC
    `);
    return stmt.all(botId) as unknown as TaskRecord[];
  }

  close(): void {
    if (this.isOpen) {
      this.isOpen = false;
      this.db.close();
    }
  }
}
