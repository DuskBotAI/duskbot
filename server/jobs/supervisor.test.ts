import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CRASH_STREAK, JOB_TOKEN_PREFIX, JobSupervisor, restartDelay, type JobNote, type JobRecord, type JobSpec, type SupervisorOptions } from "./supervisor.ts";

const roots: string[] = [];
const supervisors: JobSupervisor[] = [];
afterEach(() => {
  for (const supervisor of supervisors.splice(0)) supervisor.shutdown();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const alive = (pid: number | undefined) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

function harness(patch: Partial<SupervisorOptions> = {}, root = mkdtempSync(join(tmpdir(), "dusk-jobs-"))) {
  roots.push(root);
  const delivered: Array<{ job: JobRecord; note: JobNote }> = [], crashing: Array<{ job: JobRecord; tail: string }> = [], tokens: string[] = [];
  const options: SupervisorOptions = {
    file: join(root, "jobs.json"), logDir: join(root, "logs"),
    launch: (job, token) => {
      tokens.push(token);
      return { process: spawn("sh", ["-c", job.command], { cwd: job.cwd, env: { PATH: process.env.PATH, ...job.env, SECRET: "s3cr3t-value" }, stdio: ["ignore", "pipe", "pipe"], detached: true }), secrets: ["s3cr3t-value"] };
    },
    deliver: (job, note) => delivered.push({ job, note }),
    crashing: (job, tail) => crashing.push({ job, tail }),
    limits: { restartBaseMs: 20 },
    ...patch,
  };
  const supervisor = new JobSupervisor(options);
  supervisors.push(supervisor);
  return { root, supervisor, delivered, crashing, tokens, options };
}

const spec = (command: string, patch: Partial<JobSpec> = {}): JobSpec => ({
  botId: "bot-a", threadId: "t-1", label: "Deal watch", command, cwd: tmpdir(), env: {}, secrets: {}, onNotify: "", ...patch,
});

describe("background job supervisor", () => {
  it("starts a job, captures its output, and stops its whole process group", async () => {
    const { supervisor } = harness();
    const { job } = supervisor.start(spec("echo hello; sleep 30 & sleep 30"));
    expect(alive(job.pid)).toBe(true);
    await expect.poll(() => supervisor.logs(job.id, "bot-a")).toContain("hello");
    expect(supervisor.running()).toBe(1);
    const stopped = supervisor.stop(job.id, "bot-a");
    expect(stopped).toMatchObject({ state: "stopped" });
    await expect.poll(() => alive(job.pid)).toBe(false);
    expect(supervisor.running()).toBe(0);
    expect(supervisor.stop(job.id, "bot-b")).toBeNull();
  });

  it("restarts a crashing job with a doubling pause and reports the streak once", async () => {
    const { supervisor, crashing } = harness();
    const { job } = supervisor.start(spec("echo boom >&2; exit 3"));
    await expect.poll(() => supervisor.get(job.id, "bot-a")!.starts, { timeout: 5_000 }).toBeGreaterThanOrEqual(CRASH_STREAK + 1);
    expect(crashing).toHaveLength(1);
    expect(crashing[0]!.tail).toContain("boom");
    expect(supervisor.get(job.id, "bot-a")).toMatchObject({ state: "running", lastExit: expect.stringMatching(/exit 3|^$/) });
    expect(supervisor.logs(job.id, "bot-a")).toContain("exit 3; starting again in");
    expect([1, 2, 3, 10, 30].map((n) => restartDelay(n))).toEqual([1_000, 2_000, 4_000, 300_000, 300_000]);
  });

  it("ends what a run left in its process group when its main process exits", async () => {
    const { supervisor, root } = harness();
    const marker = join(root, "child-alive");
    const { job } = supervisor.start(spec(`(while true; do date > ${marker}; sleep 0.1; done) & sleep 0.3; exit 2`));
    await expect.poll(() => supervisor.get(job.id, "bot-a")!.starts, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
    supervisor.stop(job.id, "bot-a");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { readFileSync: read } = await import("node:fs");
    const last = read(marker, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(read(marker, "utf8")).toBe(last);
  });

  it("lets a job that ends cleanly stay done", async () => {
    const { supervisor } = harness();
    const { job } = supervisor.start(spec("echo finished"));
    await expect.poll(() => supervisor.get(job.id, "bot-a")!.state).toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(supervisor.get(job.id, "bot-a")!.starts).toBe(1);
    expect(supervisor.running()).toBe(0);
  });

  it("survives a server restart: the next supervisor starts running jobs again and ends what the last one left", async () => {
    const first = harness();
    const { job } = first.supervisor.start(spec("sleep 30"));
    const stoppedJob = first.supervisor.start(spec("sleep 30", { label: "Other" })).job;
    first.supervisor.stop(stoppedJob.id, "bot-a");
    first.supervisor.shutdown();
    await expect.poll(() => alive(job.pid)).toBe(false);

    const killed: number[] = [];
    const leftover = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    const saved = JSON.parse(readFileSync(first.options.file, "utf8"));
    saved.jobs[0].pid = leftover.pid;
    saved.jobs[0].pidStamp = "stamp-1";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(first.options.file, JSON.stringify(saved));

    const second = harness({ stamp: (pid) => (pid === leftover.pid ? "stamp-1" : "other"), kill: (pid, signal) => { killed.push(pid); process.kill(-pid, signal); } }, first.root);
    second.supervisor.restore();
    expect(killed).toContain(leftover.pid);
    const again = second.supervisor.get(job.id, "bot-a")!;
    expect(again).toMatchObject({ state: "running", starts: 2 });
    expect(again.pid).not.toBe(job.pid);
    expect(alive(again.pid)).toBe(true);
    expect(second.supervisor.get(stoppedJob.id, "bot-a")).toMatchObject({ state: "stopped", starts: 1 });
  });

  it("caps the log, keeping the newest output, and never shows a secret", async () => {
    const { supervisor, root } = harness({ limits: { logBytes: 2_000, restartBaseMs: 20 } });
    const { job } = supervisor.start(spec('i=0; while [ $i -lt 300 ]; do echo "line $i $SECRET"; i=$((i+1)); [ $((i % 30)) -eq 0 ] && sleep 0.05; done; sleep 30'));
    await expect.poll(() => supervisor.logs(job.id, "bot-a", 16_000), { timeout: 5_000 }).toContain("line 299");
    expect(statSync(join(root, "logs", `${job.id}.log`)).size).toBeLessThanOrEqual(2_000);
    expect(statSync(join(root, "logs", `${job.id}.log.1`)).size).toBeLessThanOrEqual(2_000);
    const tail = supervisor.logs(job.id, "bot-a", 16_000)!;
    expect(tail).not.toContain("line 0 ");
    expect(tail).not.toContain("s3cr3t-value");
    expect(readFileSync(join(root, "logs", `${job.id}.log`), "utf8")).not.toContain("s3cr3t-value");
  });

  it("hands a notify from the live run to the host, rate-limited, and refuses a stale token", async () => {
    const { supervisor, delivered, tokens } = harness({ limits: { notifiesPerHour: 2, restartBaseMs: 20 } });
    const { job } = supervisor.start(spec("sleep 30"));
    const token = tokens.at(-1)!;
    expect(token.startsWith(JOB_TOKEN_PREFIX)).toBe(true);
    expect(supervisor.notify(token, { text: " deal with s3cr3t-value moved to contract ", tell: false })).toEqual({ ok: true });
    expect(delivered).toMatchObject([{ job: { id: job.id, botId: "bot-a", threadId: "t-1" }, note: { text: "deal with [secret] moved to contract", tell: false } }]);
    expect(supervisor.notify(token, { text: "two", tell: true })).toEqual({ ok: true });
    expect(supervisor.notify(token, { text: "three", tell: false })).toMatchObject({ ok: false, status: 429 });
    expect(supervisor.notify(token, { text: "x".repeat(5_000), tell: false })).toMatchObject({ ok: false, status: 413 });
    supervisor.stop(job.id, "bot-a");
    expect(supervisor.notify(token, { text: "late", tell: false })).toMatchObject({ ok: false, status: 401 });
    expect(supervisor.notify("dusk_job_nope", { text: "x", tell: false })).toMatchObject({ ok: false, status: 401 });
  });

  it("ends a run that uses too much memory and starts it again", async () => {
    let rss = 10;
    const { supervisor } = harness({ usage: async (pids) => new Map(pids.map((pid) => [pid, { rssBytes: rss, cpuMs: 0 }])), limits: { memoryBytes: 1_000, restartBaseMs: 20 } });
    const { job } = supervisor.start(spec("sleep 30"));
    await supervisor.sample();
    expect(alive(job.pid)).toBe(true);
    rss = 5_000;
    await supervisor.sample();
    await expect.poll(() => supervisor.get(job.id, "bot-a")!.starts, { timeout: 5_000 }).toBe(2);
    expect(alive(job.pid)).toBe(false);
    expect(supervisor.logs(job.id, "bot-a")).toContain("stopped this run: memory");
  });

  it("caps jobs per bot, replaces one with the same label, and removes a deleted bot's jobs", () => {
    const { supervisor } = harness({ limits: { perBot: 2, restartBaseMs: 20 } });
    const first = supervisor.start(spec("sleep 30", { label: "A" })).job;
    supervisor.start(spec("sleep 30", { label: "B" }));
    expect(() => supervisor.start(spec("sleep 30", { label: "C" }))).toThrow(/already run 2 background jobs/);
    const replaced = supervisor.start(spec("sleep 31", { label: "a" }));
    expect(replaced.replaced).toBe(true);
    expect(supervisor.get(first.id, "bot-a")).toBeNull();
    expect(supervisor.list("bot-a").map((job) => job.label).sort()).toEqual(["B", "a"]);
    expect(supervisor.removeForBot("bot-a")).toBe(2);
    expect(supervisor.list()).toEqual([]);
  });
});
