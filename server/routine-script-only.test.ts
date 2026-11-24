import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoutineProbe } from "../shared/routines.ts";
import { CHECK_BOOT_HOLD_MS } from "./routine-check-pacing.ts";
import { createRoutineProbes } from "./routine-probe.ts";
import { scriptRunOptions, SCRIPT_TIMEOUT_MS, type ScriptResult } from "./routine-script.ts";
import { RoutineManager, type Routine, type RoutineChecks, type RoutineManagerOptions } from "./routines.ts";

const HOUR = 60 * 60_000;
const START = new Date(2026, 10, 20, 9, 0, 0).getTime();
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "dusk-script-only-")); dirs.push(dir); return dir; };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

const postingProbe: RoutineProbe = { kind: "script", url: "", command: "report", post: true };
const posting = { id: "r1", probe: postingProbe, checks: ["probe"], prompt: "p" } as Routine;

function probesPrinting(result: () => ScriptResult) {
  return createRoutineProbes({ dataDir: tempDir(), now: () => START, script: async () => result() });
}

describe("a posting script check", () => {
  it("starts a run that carries the output as printed, even when it is the same as last time", async () => {
    const probes = probesPrinting(() => ({ ok: true, output: "  BTC 97,000\nETH 3,400\n{\"wakeAgent\": true}\n" }));
    for (const id of ["run-1", "run-2"]) {
      const result = await probes.check(posting, { manual: false });
      expect(result.run?.post).toBe("BTC 97,000\nETH 3,400");
      probes.settled({ id, status: "completed", checkKey: result.run!.key } as never);
    }
  });

  it("holds the next read while a run is in flight", async () => {
    const probes = probesPrinting(() => ({ ok: true, output: "news" }));
    expect((await probes.check(posting, { manual: false })).run?.post).toBe("news");
    expect(await probes.check(posting, { manual: false })).toEqual({ held: true });
  });

  it("is quiet on empty output and on {\"wakeAgent\": false}", async () => {
    for (const output of ["", "  \n", "nothing today\n{\"wakeAgent\": false}"]) {
      expect(await probesPrinting(() => ({ ok: true, output })).check(posting, { manual: false })).toEqual({});
    }
  });

  it("is a failed check when the script fails, never quiet", async () => {
    const probes = probesPrinting(() => ({ ok: false, error: "The script stopped with exit code 2." }));
    expect(await probes.check(posting, { manual: false })).toEqual({ trouble: "Couldn't check its script: The script stopped with exit code 2." });
  });
});

describe("a run with a post", () => {
  function manager(options: Partial<RoutineManagerOptions> = {}) {
    let now = START;
    const startTurn = vi.fn(async () => {});
    const checks: RoutineChecks = { check: async () => ({ run: { key: "probe:k", prompt: "p", post: "Line one\n\nLine two" } }), release: () => {}, settled: () => {} };
    const routines = new RoutineManager({
      file: join(tempDir(), "routines.json"), now: () => now, botState: () => "ready",
      createTask: () => ({ threadId: "thread-1" }), startTurn, checks, ...options,
    });
    routines.create({ name: "Prices", prompt: "p", botId: "b", schedule: { type: "interval", everyMinutes: 60, anchorAt: START + HOUR }, probe: { kind: "script", url: "", command: "report" } });
    return {
      routines, startTurn,
      async hour() { now += CHECK_BOOT_HOLD_MS + HOUR; await routines.tick(); await settle(); },
    };
  }

  it("posts the text as the reply and completes with no AI turn", async () => {
    const posts: string[] = [];
    const h = manager({ postReply: (_botId, threadId, text, run) => { posts.push(`${threadId}|${text}|${run.status}`); } });
    await h.hour();
    expect(posts).toEqual(["thread-1|Line one\n\nLine two|completed"]);
    expect(h.startTurn).not.toHaveBeenCalled();
    expect(h.routines.listRuns()[0]).toMatchObject({ status: "completed", output: "Line one\n\nLine two" });
  });

  it("fails with a clear message when the server cannot post", async () => {
    const h = manager();
    await h.hour();
    expect(h.startTurn).not.toHaveBeenCalled();
    expect(h.routines.listRuns()[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/cannot post a script's output/) });
  });
});

describe("how a script check runs", () => {
  it("leaves the fence only with access full, and takes the routine's time limit", () => {
    expect(scriptRunOptions({ probe: postingProbe })).toEqual({ sandbox: true, timeoutMs: SCRIPT_TIMEOUT_MS });
    expect(scriptRunOptions({ probe: { ...postingProbe, access: "full" }, timeoutMinutes: 5 })).toEqual({ sandbox: false, timeoutMs: 5 * 60_000 });
  });
});
