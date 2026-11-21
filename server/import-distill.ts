// The second pass of an import's memory (shared/memory-distill.ts has the first): passages and what was over the
// caps go through the bot's own memory capture step, the one that files what a chat taught it, so its engine keeps
// only short dated notes of what lasts (facts about the person go to About me as capture files them). With no engine
// that can make the call yet, the material waits here and goes through once one is connected; nothing is lost and
// nothing is kept raw.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { DISTILL_CHUNK_CHARS } from "../shared/memory-distill.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { CaptureBatch } from "./memory-capture.ts";
import { NO_TEXT_ENGINE, type CaptureReport } from "./memory-upkeep.ts";

/** At most this many chunks wait per bot (DISTILL_MAX_CHARS of material). */
export const MAX_WAITING_CHUNKS = 10;
export const DISTILL_EVERY_MS = 10 * 60_000;
/** How many chunks a bot already went through are remembered, so the same notes again cost no engine call. */
export const MAX_DONE_CHUNKS = 500;

export const importDistillBody = z.object({
  from: z.string().trim().min(1).max(60),
  chunks: z.array(z.string().min(1).max(DISTILL_CHUNK_CHARS + 200)).min(1).max(MAX_WAITING_CHUNKS),
}).strict();

const waitingSchema = z.record(z.string(), z.object({ from: z.string(), chunks: z.array(z.string()), queuedAt: z.number(), done: z.array(z.string()).default([]) }));
type Waiting = z.infer<typeof waitingSchema>;

export interface ImportDistillDeps {
  file: string;
  capture(batch: CaptureBatch): Promise<CaptureReport>;
  /** The bot's engine can make the quick background call capture uses. */
  hasEngine(botId: string): boolean;
  botExists(botId: string): boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ImportDistill {
  queue(botId: string, from: string, chunks: readonly string[]): number;
  /** Chunks still waiting for this bot. */
  waiting(botId: string): number;
  run(): Promise<void>;
  start(): void;
  stop(): void;
}

export const importDistillFile = (dataDir: string) => join(dataDir, "import-distill.json");

const chunkHash = (chunk: string) => createHash("sha256").update(chunk).digest("hex").slice(0, 32);

/** The words the capture step reads as the person's own: what they had kept in the other app. */
export function distillTurn(from: string, chunk: string): string {
  return `Here is what I had kept in ${from}, my notes and what it remembered about me and my work. Keep only what still matters: lasting facts about me, my projects, preferences and people, and decisions. Skip logs, one-off tasks and anything out of date.\n\n${chunk}`;
}

export function createImportDistill(deps: ImportDistillDeps): ImportDistill {
  const now = deps.now ?? Date.now;
  let running: Promise<void> | null = null;
  let again: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const read = (): Waiting => {
    try {
      const parsed = waitingSchema.safeParse(JSON.parse(readFileSync(deps.file, "utf8")));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  };
  const save = (next: Waiting) => {
    try {
      writeFileAtomic(deps.file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    } catch (error) {
      deps.log?.(`import distill: could not save the waiting notes (${error instanceof Error ? error.message : "unknown"})`);
    }
  };

  async function pass(): Promise<void> {
    // each change re-reads the file, so what is queued meanwhile is never written over
    const settle = (botId: string, done?: string) => {
      const latest = read();
      const item = latest[botId];
      if (!item) return;
      if (done === undefined) delete latest[botId];
      else latest[botId] = { ...item, chunks: item.chunks.filter((chunk) => chunk !== done), done: [...item.done, chunkHash(done)].slice(-MAX_DONE_CHUNKS) };
      save(latest);
    };
    for (const [botId, item] of Object.entries(read())) {
      if (!deps.botExists(botId)) {
        settle(botId);
        continue;
      }
      if (!deps.hasEngine(botId)) continue;
      for (const [index, chunk] of item.chunks.entries()) {
        const report = await deps.capture({ botId, threadId: `import-${item.queuedAt}-${index}`, turns: [{ person: distillTurn(item.from, chunk), bot: "", owner: true }] })
          .catch(() => null);
        // no engine after all, or upkeep off or stopped: it stays for the next pass
        if (!report || report.note === NO_TEXT_ENGINE || /upkeep (?:is off|stopped)|deferred/.test(report.note ?? "")) break;
        deps.log?.(`import distill: ${botId} kept ${report.added} notes from ${item.from}`);
        settle(botId, chunk);
      }
    }
  }

  const api: ImportDistill = {
    queue(botId, from, chunks) {
      const waiting = read();
      const before = waiting[botId]?.chunks ?? [];
      const done = new Set(waiting[botId]?.done ?? []);
      const all = [...before, ...chunks.filter((chunk) => chunk.trim() && !before.includes(chunk) && !done.has(chunkHash(chunk)))].slice(0, MAX_WAITING_CHUNKS);
      waiting[botId] = { from, chunks: all, queuedAt: before.length ? waiting[botId]!.queuedAt : now(), done: [...done] };
      save(waiting);
      void api.run();
      return all.length;
    },
    waiting: (botId) => read()[botId]?.chunks.length ?? 0,
    run() {
      // asked again mid-pass (a new queue, a new engine): one more pass after this one
      if (running) {
        again ??= running.then(() => { again = null; return api.run(); });
        return again;
      }
      running = pass().finally(() => { running = null; });
      return running;
    },
    start() {
      if (timer) return;
      void api.run();
      timer = setInterval(() => void api.run(), DISTILL_EVERY_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return api;
}
