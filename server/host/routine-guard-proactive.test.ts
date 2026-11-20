import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Routine, RoutineRun } from "../routines.ts";
import { reconnectCard, signedOutApps } from "./routine-auth.ts";
import { createRoutineGuard, RECONNECT_KEY } from "./routine-guard.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NOW = Date.parse("2026-11-20T10:00:00Z");
const DAY = 24 * 60 * 60_000;

function fakes(prompt = "Summarize my Gmail") {
  const dir = mkdtempSync(join(tmpdir(), "dusk-guard-proactive-"));
  dirs.push(dir);
  let now = NOW;
  const routine = {
    id: "r1", name: "Mail digest", prompt, botId: "b1", enabled: true, target: "bot", sourceThreadId: "t1",
    schedule: { type: "interval", everyMinutes: 60 }, createdAt: NOW, updatedAt: NOW, nextRunAt: NOW,
  } as unknown as Routine;
  const runs: RoutineRun[] = [];
  const told: Array<{ text: string; quiet?: boolean }> = [];
  const cards: string[] = [];
  const signedOut = new Map<string, string[]>();
  const guard = createRoutineGuard({
    dataDir: dir, now: () => now,
    routine: (id) => (id === routine.id ? routine : undefined),
    runs: () => runs,
    pause: () => { routine.enabled = false; },
    resume: () => { routine.enabled = true; },
    recheck: () => {},
    tell: (_bot, _thread, text, quiet) => told.push({ text, quiet }),
    language: () => undefined,
    spendOver: () => null,
    signedOut: (run) => signedOut.get(run.id) ?? [],
    reconnect: (_routine, _thread, slug) => cards.push(slug),
  });
  let n = 0;
  const finish = (status: "completed" | "failed", apps: string[] = [], over: Partial<RoutineRun> = {}) => {
    const run = { id: `run-${++n}`, routineId: routine.id, routineName: routine.name, botId: "b1", target: "bot", runOn: "maus", manual: false,
      scheduledFor: now, status, createdAt: now + n, finishedAt: now + n, ...(status === "failed" ? { error: `failed ${n}` } : {}), ...over } as RoutineRun;
    runs.push(run);
    signedOut.set(run.id, apps);
    if (status === "failed") guard.failed(run); else guard.changed(run);
    return run;
  };
  return { guard, routine, told, cards, finish, later: (ms: number) => { now += ms; } };
}

describe("routine guard: sign-ins, one-off watches", () => {
  it("pauses after three runs in a row find the same app signed out, with one reconnect card", () => {
    const { routine, cards, finish, guard, told } = fakes();
    finish("failed", ["gmail"]);
    finish("completed", ["gmail", "slack"]);
    expect(routine.enabled).toBe(true);
    finish("failed", ["gmail"]);
    expect(routine.enabled).toBe(false);
    expect(cards).toEqual(["gmail"]);
    expect(told).toEqual([]);
    expect(guard.pausedFor(routine)).toEqual({ pausedFor: expect.objectContaining({ by: "failures", error: "gmail is signed out" }) });
    expect(guard.reconnected(`${RECONNECT_KEY}r1`, false)).toBe(true);
    expect(routine.enabled).toBe(false);
    guard.reconnected(`${RECONNECT_KEY}r1`, true);
    expect(routine.enabled).toBe(true);
    expect(guard.reconnected("other-key", true)).toBe(false);
  });

  it("does not pause when a run in between was fine", () => {
    const { routine, finish } = fakes();
    finish("failed", ["gmail"]);
    finish("completed", []);
    finish("failed", ["gmail"]);
    expect(routine.enabled).toBe(true);
  });

  it("stops a one-off watch once it reported, quietly", () => {
    const { routine, finish, told } = fakes("Check the store and tell me when the new iPad ships.");
    finish("completed", [], { report: { state: "quiet" }, output: "NOTHING NEW" });
    expect(routine.enabled).toBe(true);
    finish("completed", [], { report: { state: "posted", threadId: "t1", messageId: "m1" }, output: "It shipped today." });
    expect(routine.enabled).toBe(false);
    expect(told).toEqual([expect.objectContaining({ quiet: true, text: expect.stringContaining("Mail digest") })]);
  });

  it("keeps an ongoing routine after it reports", () => {
    const { routine, finish } = fakes("Tell me every time a new iPad ships.");
    finish("completed", [], { report: { state: "posted", threadId: "t1", messageId: "m1" }, output: "One shipped." });
    expect(routine.enabled).toBe(true);
  });

  it("ends a one-off watch after 30 days without news", () => {
    const { routine, guard, later, told } = fakes("Tell me when the new iPad ships.");
    const run = { id: "x", routineId: "r1", botId: "b1", target: "bot", manual: false } as RoutineRun;
    expect(guard.held(run)).toBeNull();
    later(30 * DAY);
    expect(guard.held(run)).toMatch(/ended after 30 days/);
    expect(routine.enabled).toBe(false);
    expect(told[0]!.text).toContain("30 days");
  });
});

describe("signed-out apps of a run", () => {
  it("reads the proxy's note and reconnect cards inside the run's own time", () => {
    const run = { threadId: "t1", startedAt: 100, finishedAt: 200 };
    const messages = [
      { at: 50, tool: { output: "dusk bot note: slack is signed out (its sign-in expired or was revoked), so this call did not run." } },
      { at: 120, tool: { output: "error\ndusk bot note: gmail, googlecalendar is signed out (its sign-in expired or was revoked), so" } },
      { at: 150, kind: "connector", connector: { slug: "notion", status: "required" as const } },
      { at: 160, kind: "connector", connector: { slug: "linear", status: "connected" as const } },
    ];
    expect(signedOutApps(messages, run)).toEqual(["gmail", "googlecalendar", "notion"]);
    expect(signedOutApps(messages, { threadId: "t1" })).toEqual([]);
  });

  it("makes a card whose Connect resumes the routine", () => {
    expect(reconnectCard("r1", "google_drive", "Paused")).toMatchObject({ kind: "connector", connector: { slug: "google_drive", label: "Google Drive", status: "required", resumeKey: `${RECONNECT_KEY}r1` } });
  });
});
