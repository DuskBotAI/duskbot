// Background jobs: a bot's own long-running program (a chat poller, a feed watcher) that keeps running after its turn
// ends. The supervisor keeps the list in the data folder, starts each job through `launch` (its own bot box where turns
// are boxed, docs/background-jobs.md), restarts one that exits with an error after a growing pause, starts every running
// job again after the server restarts, caps its memory, CPU and log, and hands what a job reports (`notify`) to the host.
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";

export type JobState = "running" | "stopped" | "done";

export interface JobSpec {
  botId: string;
  /** The chat the job was started in: where a `tell` lands and whose bot runs on a notify. */
  threadId: string;
  label: string;
  /** One shell command line, run with `sh -c` in `cwd`. */
  command: string;
  cwd: string;
  env: Record<string, string>;
  /** Environment name to the label of a secret in the person's Vault for this bot, read at every start. */
  secrets: Record<string, string>;
  /** What the bot's run does with a notify, in the bot's own words. */
  onNotify: string;
}

export interface JobRecord extends JobSpec {
  id: string;
  createdAt: number;
  state: JobState;
  starts: number;
  /** Exits with an error in a row, each within RAN_LONG_MS of its start. */
  crashes: number;
  lastStartAt?: number;
  lastExitAt?: number;
  /** "exit 1", "signal SIGKILL", or why the supervisor ended it ("memory", "cpu"). */
  lastExit?: string;
  stopReason?: string;
  pid?: number;
  pidStamp?: string;
  /** The crash streak was reported to the chat (once per streak). */
  crashReported?: boolean;
}

/** A started job's process: its group is the job (`kill(-pid)`). */
export interface JobProcess {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface JobUsage { rssBytes: number; cpuMs: number }

export interface JobNote { text: string; tell: boolean }

export interface SupervisorOptions {
  file: string;
  logDir: string;
  /** Starts the job's process with this run's notify token; throws (with a message the bot can act on) when it can't.
   * `secrets`: the values it handed over, which the log and notes never carry. */
  launch(job: JobRecord, token: string): { process: JobProcess; secrets: readonly string[] };
  /** What the job reported, already rate-limited and size-checked. */
  deliver(job: JobRecord, note: JobNote): void;
  /** The job kept failing (CRASH_STREAK exits in a row): told once per streak. */
  crashing(job: JobRecord, tail: string): void;
  /** Ends a job's whole process group. */
  kill?(pid: number, signal: NodeJS.Signals): void;
  /** Memory and CPU time of each process group, by its leader's pid. */
  usage?(pids: readonly number[]): Promise<Map<number, JobUsage>>;
  /** When a process started (`ps` lstart): a pid an earlier server left is ended before a new start only while its stamp
   * still matches, so a reused pid is never killed. */
  stamp?(pid: number): string | null;
  now?: () => number;
  limits?: Partial<JobLimits>;
  log?: (line: string) => void;
}

export interface JobLimits {
  perBot: number;
  total: number;
  logBytes: number;
  memoryBytes: number;
  /** Share of one CPU a job may use on average over CPU_WINDOW_MS. */
  cpuShare: number;
  notifiesPerHour: number;
  /** The first restart pause; each crash in a row doubles it, up to RESTART_MAX_MS. */
  restartBaseMs: number;
}

export const DEFAULT_JOB_LIMITS: JobLimits = {
  perBot: 3, total: 12, logBytes: 1_000_000, memoryBytes: 1024 * 1024 * 1024, cpuShare: 0.9, notifiesPerHour: 60, restartBaseMs: 1_000,
};

/** Restart pauses double up to this. A run of RAN_LONG_MS resets the streak. */
export const RESTART_MAX_MS = 5 * 60_000;
export const RAN_LONG_MS = 60_000;
export const CRASH_STREAK = 5;
export const SAMPLE_MS = 30_000;
export const CPU_WINDOW_MS = 5 * 60_000;
const STOP_GRACE_MS = 3_000;
export const NOTE_MAX_CHARS = 4_000;

export const JOB_TOKEN_PREFIX = "dusk_job_";

const recordSchema = z.object({
  id: z.string().min(1), botId: z.string().min(1), threadId: z.string().min(1), label: z.string().min(1), command: z.string().min(1),
  cwd: z.string().min(1), env: z.record(z.string(), z.string()), secrets: z.record(z.string(), z.string()), onNotify: z.string(),
  createdAt: z.number(), state: z.enum(["running", "stopped", "done"]), starts: z.number().int(), crashes: z.number().int(),
  lastStartAt: z.number().optional(), lastExitAt: z.number().optional(), lastExit: z.string().optional(), stopReason: z.string().optional(),
  pid: z.number().int().optional(), pidStamp: z.string().optional(), crashReported: z.boolean().optional(),
});
const fileSchema = z.object({ version: z.literal(1), jobs: z.array(z.unknown()) });

export function restartDelay(crashes: number, base = DEFAULT_JOB_LIMITS.restartBaseMs): number {
  return Math.min(RESTART_MAX_MS, base * 2 ** Math.max(0, crashes - 1));
}

const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

interface Live {
  process: JobProcess;
  token: string;
  stopping: boolean;
  /** CPU samples: [at, cpuMs]. */
  cpu: Array<[number, number]>;
  secrets: string[];
}

export class JobSupervisor {
  private readonly options: SupervisorOptions;
  private readonly limits: JobLimits;
  private readonly now: () => number;
  private jobs: JobRecord[] = [];
  private readonly live = new Map<string, Live>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly tokens = new Map<string, string>();
  private readonly notes = new Map<string, number[]>();
  private sampler: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: SupervisorOptions) {
    this.options = options;
    this.limits = { ...DEFAULT_JOB_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(options.file, "utf8")));
      this.jobs = parsed.success ? parsed.data.jobs.flatMap((raw) => { const one = recordSchema.safeParse(raw); return one.success ? [one.data] : []; }) : [];
    } catch {
      this.jobs = [];
    }
  }

  /** Starts every job that was running when the server stopped, ending what an earlier server left behind first. */
  restore(): void {
    for (const job of this.jobs) {
      if (job.state !== "running") continue;
      if (job.pid && job.pidStamp && this.options.stamp?.(job.pid) === job.pidStamp) this.killGroup(job.pid, "SIGKILL");
      delete job.pid;
      delete job.pidStamp;
      this.spawn(job);
    }
    this.save();
    this.startSampler();
  }

  list(botId?: string): JobRecord[] {
    return this.jobs.filter((job) => !botId || job.botId === botId).map((job) => ({ ...job }));
  }

  get(id: string, botId: string): JobRecord | null {
    const job = this.jobs.find((candidate) => candidate.id === id && candidate.botId === botId);
    return job ? { ...job } : null;
  }

  /** Jobs that should be running now (including one waiting to restart): what keeps a sleeping Cloud awake. */
  running(): number {
    return this.jobs.filter((job) => job.state === "running").length;
  }

  /** Starts a job; one of this bot's with the same label is replaced. Throws a message for the bot when it can't. */
  start(spec: JobSpec): { job: JobRecord; replaced: boolean } {
    const earlier = this.jobs.find((job) => job.botId === spec.botId && sameLabel(job.label, spec.label));
    const others = this.jobs.filter((job) => job !== earlier && job.state === "running");
    if (others.filter((job) => job.botId === spec.botId).length >= this.limits.perBot) {
      throw new JobRefusal(`You already run ${this.limits.perBot} background jobs, the most one bot can. Stop one first (action list, then stop).`);
    }
    if (others.length >= this.limits.total) throw new JobRefusal("This computer already runs as many background jobs as it can. Stop one first.");
    if (earlier) this.remove(earlier, "replaced");
    const job: JobRecord = { ...spec, id: randomUUID(), createdAt: this.now(), state: "running", starts: 0, crashes: 0 };
    this.jobs.push(job);
    try {
      this.launchNow(job);
    } catch (error) {
      this.jobs = this.jobs.filter((candidate) => candidate !== job);
      this.save();
      throw error;
    }
    this.save();
    this.startSampler();
    return { job: { ...job }, replaced: Boolean(earlier) };
  }

  /** Stops a job for good (it is kept in the list as stopped). */
  stop(id: string, botId: string, reason = "stopped"): JobRecord | null {
    const job = this.jobs.find((candidate) => candidate.id === id && candidate.botId === botId);
    if (!job) return null;
    this.halt(job, reason);
    this.save();
    return { ...job };
  }

  /** Every job of a bot, ended and forgotten (the bot was deleted). */
  removeForBot(botId: string): number {
    const gone = this.jobs.filter((job) => job.botId === botId);
    for (const job of gone) this.remove(job, "bot deleted");
    if (gone.length) this.save();
    return gone.length;
  }

  /** The end of the job's output, newest last, at most `bytes`. */
  logs(id: string, botId: string, bytes = 4_000): string | null {
    const job = this.jobs.find((candidate) => candidate.id === id && candidate.botId === botId);
    if (!job) return null;
    const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
    const all = read(`${this.logFile(job.id)}.1`) + read(this.logFile(job.id));
    return redact(all.slice(-Math.max(200, Math.min(bytes, 16_000))), this.live.get(job.id)?.secrets ?? []);
  }

  /** The job a notify token belongs to, while that run of it lives. */
  byToken(token: string): JobRecord | null {
    if (!token.startsWith(JOB_TOKEN_PREFIX)) return null;
    const id = this.tokens.get(token);
    const job = id ? this.jobs.find((candidate) => candidate.id === id && candidate.state === "running") : undefined;
    return job ?? null;
  }

  /** What a job reported: checked, rate-limited, then delivered. */
  notify(token: string, note: JobNote): { ok: true } | { ok: false; status: number; error: string } {
    const job = this.byToken(token);
    if (!job) return { ok: false, status: 401, error: "This job's notify token is not valid: it ended or was restarted." };
    const text = note.text.trim();
    if (!text) return { ok: false, status: 400, error: "Send some text." };
    if (text.length > NOTE_MAX_CHARS) return { ok: false, status: 413, error: `Keep a notification under ${NOTE_MAX_CHARS} characters.` };
    const at = this.now(), recent = (this.notes.get(job.id) ?? []).filter((when) => at - when < 3_600_000);
    if (recent.length >= this.limits.notifiesPerHour) {
      this.notes.set(job.id, recent);
      return { ok: false, status: 429, error: `Too many notifications: at most ${this.limits.notifiesPerHour} an hour. Send fewer, each with more in it.` };
    }
    recent.push(at);
    this.notes.set(job.id, recent);
    this.options.deliver({ ...job }, { text: redact(text, this.live.get(job.id)?.secrets ?? []), tell: note.tell });
    return { ok: true };
  }

  /** The server is stopping: every job's process ends; running jobs start again with the next server (`restore`). */
  shutdown(): void {
    this.closed = true;
    if (this.sampler) clearInterval(this.sampler);
    this.sampler = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const [, live] of this.live) {
      live.stopping = true;
      if (live.process.pid) this.killGroup(live.process.pid, "SIGKILL");
    }
    this.live.clear();
    this.tokens.clear();
  }

  /** Samples memory and CPU now; the timer calls it every SAMPLE_MS. */
  async sample(): Promise<void> {
    if (!this.options.usage || !this.live.size) return;
    const pids = new Map<number, string>();
    for (const [id, live] of this.live) if (live.process.pid && !live.stopping) pids.set(live.process.pid, id);
    if (!pids.size) return;
    let usage: Map<number, JobUsage>;
    try { usage = await this.options.usage([...pids.keys()]); } catch { return; }
    const at = this.now();
    for (const [pid, id] of pids) {
      const live = this.live.get(id), job = this.jobs.find((candidate) => candidate.id === id), used = usage.get(pid);
      if (!live || !job || !used || live.stopping) continue;
      if (used.rssBytes > this.limits.memoryBytes) {
        this.endRun(job, live, `memory: used ${Math.round(used.rssBytes / 1_048_576)} MB, more than the ${Math.round(this.limits.memoryBytes / 1_048_576)} MB a job may`);
        continue;
      }
      live.cpu.push([at, used.cpuMs]);
      while (live.cpu.length > 1 && at - live.cpu[0]![0] > CPU_WINDOW_MS) live.cpu.shift();
      const [firstAt, firstCpu] = live.cpu[0]!;
      if (at - firstAt >= CPU_WINDOW_MS && (used.cpuMs - firstCpu) / (at - firstAt) > this.limits.cpuShare) {
        this.endRun(job, live, "cpu: kept a whole CPU busy for 5 minutes");
      }
    }
  }

  private endRun(job: JobRecord, live: Live, why: string): void {
    this.appendLog(job, `\n[dusk bot] stopped this run: ${why}. It starts again after a pause.\n`);
    job.lastExit = why.split(":")[0];
    if (live.process.pid) this.killGroup(live.process.pid, "SIGKILL");
  }

  private startSampler(): void {
    if (this.sampler || this.closed || !this.options.usage) return;
    this.sampler = setInterval(() => void this.sample(), SAMPLE_MS);
    this.sampler.unref?.();
  }

  private spawn(job: JobRecord): void {
    try {
      this.launchNow(job);
    } catch (error) {
      // A start that failed (a secret gone from the Vault, a folder removed) is tried again like a crash.
      this.appendLog(job, `\n[dusk bot] could not start: ${error instanceof Error ? error.message : String(error)}\n`);
      job.lastExit = "could not start";
      this.afterExit(job);
    }
  }

  private launchNow(job: JobRecord): void {
    const token = JOB_TOKEN_PREFIX + randomBytes(24).toString("base64url");
    const launched = this.options.launch(job, token), child = launched.process;
    const startedAt = this.now();
    const live: Live = { process: child, token, stopping: false, cpu: [], secrets: launched.secrets.filter((value) => value.length >= 6) };
    this.live.set(job.id, live);
    this.tokens.set(token, job.id);
    job.starts += 1;
    job.lastStartAt = startedAt;
    if (child.pid) {
      job.pid = child.pid;
      const stamp = this.options.stamp?.(child.pid);
      if (stamp) job.pidStamp = stamp; else delete job.pidStamp;
    }
    const write = (chunk: Buffer | string) => this.appendLog(job, redact(chunk.toString(), live.secrets));
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);
    let ended = false;
    const exited = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (ended) return;
      ended = true;
      this.tokens.delete(token);
      if (this.live.get(job.id) === live) this.live.delete(job.id);
      // What the job left running in its group would outlive it unsupervised, or run twice after the restart.
      if (child.pid) this.killGroup(child.pid, "SIGKILL");
      if (live.stopping || this.closed) return;
      const at = this.now();
      if (error) this.appendLog(job, `\n[dusk bot] could not run: ${error.message}\n`);
      job.lastExitAt = at;
      if (!job.lastExit || !["memory", "cpu"].includes(job.lastExit)) job.lastExit = error ? "could not run" : signal ? `signal ${signal}` : `exit ${code}`;
      delete job.pid;
      delete job.pidStamp;
      if (code === 0 && !signal && !error) {
        job.state = "done";
        job.crashes = 0;
        this.save();
        return;
      }
      if (at - startedAt >= RAN_LONG_MS) { job.crashes = 0; job.crashReported = false; }
      this.afterExit(job);
    };
    child.once("exit", (code, signal) => exited(code, signal));
    child.once("error", (error) => exited(null, null, error));
  }

  private afterExit(job: JobRecord): void {
    job.crashes += 1;
    const delay = restartDelay(job.crashes, this.limits.restartBaseMs);
    this.appendLog(job, `\n[dusk bot] ${job.lastExit}; starting again in ${Math.max(1, Math.round(delay / 1000))} s\n`);
    if (job.crashes >= CRASH_STREAK && !job.crashReported) {
      job.crashReported = true;
      try { this.options.crashing({ ...job }, this.logs(job.id, job.botId, 1_500) ?? ""); }
      catch (error) { this.options.log?.(`jobs: could not report a failing job: ${error instanceof Error ? error.message : String(error)}`); }
    }
    this.save();
    const timer = setTimeout(() => {
      this.timers.delete(job.id);
      if (this.closed || job.state !== "running" || !this.jobs.includes(job)) return;
      job.lastExit = undefined;
      this.spawn(job);
      this.save();
    }, delay);
    timer.unref?.();
    this.timers.set(job.id, timer);
  }

  private halt(job: JobRecord, reason: string): void {
    job.state = "stopped";
    job.stopReason = reason;
    const timer = this.timers.get(job.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(job.id);
    const live = this.live.get(job.id);
    if (live) {
      live.stopping = true;
      this.tokens.delete(live.token);
      this.live.delete(job.id);
      const pid = live.process.pid;
      if (pid) {
        this.killGroup(pid, "SIGTERM");
        const hard = setTimeout(() => this.killGroup(pid, "SIGKILL"), STOP_GRACE_MS);
        hard.unref?.();
      }
    }
    delete job.pid;
    delete job.pidStamp;
  }

  private remove(job: JobRecord, reason: string): void {
    this.halt(job, reason);
    this.jobs = this.jobs.filter((candidate) => candidate !== job);
    this.notes.delete(job.id);
    for (const path of [this.logFile(job.id), `${this.logFile(job.id)}.1`]) rmSync(path, { force: true });
  }

  private killGroup(pid: number, signal: NodeJS.Signals): void {
    const kill = this.options.kill ?? killProcessGroup;
    try { kill(pid, signal); } catch {}
  }

  private logFile(id: string): string {
    return join(this.options.logDir, `${id}.log`);
  }

  private appendLog(job: JobRecord, text: string): void {
    if (!text) return;
    const file = this.logFile(job.id);
    try {
      mkdirSync(this.options.logDir, { recursive: true, mode: 0o700 });
      let size = 0;
      try { size = statSync(file).size; } catch {}
      if (size + text.length > this.limits.logBytes) renameSync(file, `${file}.1`);
    } catch {}
    try { appendFileSync(file, text.length > this.limits.logBytes ? text.slice(-this.limits.logBytes) : text, { mode: 0o600 }); }
    catch (error) { this.options.log?.(`jobs: could not write a job's log: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.options.file), { recursive: true });
      writeFileAtomic(this.options.file, JSON.stringify({ version: 1, jobs: this.jobs }, null, 2), { mode: 0o600 });
    } catch (error) {
      this.options.log?.(`jobs: could not save the job list: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** A refusal whose message is for the bot. */
export class JobRefusal extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch { process.kill(pid, signal); }
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join("[secret]");
  return out;
}
