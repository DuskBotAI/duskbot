import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { z } from "zod";

import type { MacJob, MacJobOutcome, MacJobTool } from "../../shared/mac-control.ts";

export const MAC_POLL_MS = 25_000;
/** How long a job waits for a Mac seen polling just now to take it; a Mac not seen lately gets the short wait. */
export const MAC_PICKUP_MS = 10_000;
export const MAC_OFFLINE_PICKUP_MS = 3_000;
/** A Mac whose last long poll ended this recently is still online: its next poll is on the way. */
const BETWEEN_POLLS_MS = 6_000;
const MAC_BUSY_TEXT = "The Mac is busy with other bots' work and did not take this. It did not run; try again in a moment.";
export const MAC_RESULT_MAX_BYTES = 12 * 1024 * 1024;

export const macJobOutcome = z.union([
  z.object({ ok: z.literal(true), result: z.object({
    text: z.string().max(1_000_000),
    image: z.object({ data: z.string().max(MAC_RESULT_MAX_BYTES), mimeType: z.enum(["image/png", "image/jpeg"]) }).optional(),
    structured: z.record(z.string(), z.unknown()).optional(),
    isError: z.literal(true).optional(),
    outside: z.literal(true).optional(),
    file: z.object({ name: z.string().min(1).max(255), data: z.string().max(MAC_RESULT_MAX_BYTES) }).optional(),
  }) }),
  z.object({ ok: z.literal(false), error: z.string().max(4000), ask: z.string().max(300).optional() }),
]);

export interface MacDownload { name: string; bytes: number; open(): Readable }

type Job = {
  delivery: MacJob; active: () => boolean; sent: boolean; file?: MacDownload;
  resolve(outcome: MacJobOutcome & { code?: "offline" | "timeout" | "turn_ended" }): void;
  timer: NodeJS.Timeout; pickup: NodeJS.Timeout;
};

export type MacRequest = {
  tool: MacJobTool; args: Record<string, unknown>; bot: { id: string; name: string };
  timeoutMs: number; active(): boolean; offlineText: string; file?: MacDownload; approved?: true;
};

/** In-memory rendezvous between bot turns and the owner's Mac app: jobs wait in arrival order, every open long poll
 * takes the next one, and several may run on the Mac at once. Requests always resolve; none rejects. */
export class MacJobs {
  private queue: Job[] = [];
  private sent = new Map<string, Job>();
  private waiting = new Set<() => void>();
  private polls = 0;
  private lastPollAt = -Infinity;
  private closed = false;
  private now: () => number;
  private onSeen: () => void;
  constructor(now: () => number = Date.now, onSeen: () => void = () => {}) {
    this.now = now;
    this.onSeen = onSeen;
  }

  /** polling now, between two polls, or running jobs it took (it polls again once one finishes) */
  online(): boolean {
    return !this.closed && (this.polls > 0 || this.sent.size > 0 || this.now() - this.lastPollAt < BETWEEN_POLLS_MS);
  }

  request(input: MacRequest): Promise<MacJobOutcome & { code?: "offline" | "timeout" | "turn_ended" }> {
    if (this.closed) return Promise.resolve({ ok: false, code: "offline", error: input.offlineText });
    if (!input.active()) return Promise.resolve({ ok: false, code: "turn_ended", error: "The requesting turn ended." });
    const seconds = Math.round(input.timeoutMs / 1000);
    return new Promise((resolve) => {
      const id = randomUUID();
      const job: Job = {
        delivery: {
          id, tool: input.tool, arguments: input.args, bot: input.bot, expiresAt: this.now() + input.timeoutMs, ...(input.approved ? { approved: true as const } : {}),
          ...(input.file ? { download: { path: `/api/mac/self/jobs/${id}/file`, name: input.file.name, bytes: input.file.bytes } } : {}),
        },
        active: input.active, sent: false, file: input.file, resolve,
        timer: setTimeout(() => this.finish(job, { ok: false, code: "timeout", error: job.sent
          ? `${input.tool} did not finish on the Mac within ${seconds} seconds. It may still have run; check before repeating.`
          : `${input.tool} was never picked up by the Mac. It did not run.` }), input.timeoutMs),
        pickup: setTimeout(() => {
          if (job.sent) return;
          this.finish(job, this.sent.size > 0 ? { ok: false, code: "timeout", error: MAC_BUSY_TEXT } : { ok: false, code: "offline", error: input.offlineText });
        },
          this.online() ? MAC_PICKUP_MS : MAC_OFFLINE_PICKUP_MS),
      };
      this.queue.push(job);
      for (const wake of this.waiting) wake();
    });
  }

  /** The Mac app's long poll: the next job, or null after `waitMs` with none. */
  async poll(gone?: AbortSignal, waitMs = MAC_POLL_MS): Promise<MacJob | null> {
    if (this.closed) return null;
    this.polls += 1;
    this.onSeen();
    try {
      const take = (): MacJob | null => {
        while (this.queue.length) {
          const job = this.queue.shift()!;
          if (!job.active()) { this.finish(job, { ok: false, code: "turn_ended", error: "The requesting turn ended." }); continue; }
          job.sent = true;
          this.sent.set(job.delivery.id, job);
          return job.delivery;
        }
        return null;
      };
      const ready = take();
      if (ready || gone?.aborted) return ready;
      await new Promise<void>((resolve) => {
        const wake = () => { clearTimeout(timer); gone?.removeEventListener("abort", wake); this.waiting.delete(wake); resolve(); };
        const timer = setTimeout(wake, waitMs);
        gone?.addEventListener("abort", wake, { once: true });
        this.waiting.add(wake);
      });
      return gone?.aborted || this.closed ? null : take();
    } finally {
      this.polls -= 1;
      this.lastPollAt = this.now();
    }
  }

  /** The bytes a mac_save_from_cloud job writes, while that job is in the Mac's hands. */
  file(id: string): MacDownload | null {
    const job = this.sent.get(id);
    return job?.file && job.active() ? job.file : null;
  }

  complete(id: string, outcome: MacJobOutcome): boolean {
    const job = this.sent.get(id);
    if (!job) return false;
    this.finish(job, job.active() ? outcome : { ok: false, code: "turn_ended", error: "The requesting turn ended." });
    return true;
  }

  close(): void {
    this.closed = true;
    for (const wake of this.waiting) wake();
    for (const job of [...this.queue, ...this.sent.values()]) this.finish(job, { ok: false, code: "offline", error: "This server is restarting." });
  }

  private finish(job: Job, outcome: MacJobOutcome & { code?: "offline" | "timeout" | "turn_ended" }) {
    clearTimeout(job.timer);
    clearTimeout(job.pickup);
    this.queue = this.queue.filter((queued) => queued !== job);
    this.sent.delete(job.delivery.id);
    job.resolve(outcome);
  }
}
