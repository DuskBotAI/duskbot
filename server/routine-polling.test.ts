import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CHECK_BOOT_HOLD_MS } from "./routine-check-pacing.ts";
import { continuityCarry } from "./routine-execution.ts";
import { createRoutineProbes, NO_SCRIPTS, sectionOf, withProbes } from "./routine-probe.ts";
import { cleanProbe } from "./routine-quiet.ts";
import { bwrapArgs, runCheckScript, sandboxProfile, scriptCheckGate, setsFullAccess, setsScript, wakeAsked } from "./routine-script.ts";
import { RoutineManager, type RoutineRun } from "./routines.ts";
import type { PublicPage } from "./wait-probes.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const START = new Date(2026, 10, 20, 9, 0, 0).getTime();
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "dusk-polling-")); dirs.push(dir); return dir; };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

function polling(read: (tick: number) => { output?: string; page?: string; error?: string }) {
  const dir = tempDir();
  let now = START;
  let tick = 0;
  const prompts: string[] = [];
  const page = async (url: string): Promise<PublicPage> => {
    const found = read(tick);
    return found.error ? { ok: false, error: found.error, refused: false } as never : { ok: true, url: new URL(url), headers: {}, body: Buffer.from(found.page ?? "") };
  };
  const probes = createRoutineProbes({
    dataDir: dir, now: () => now, fetch: page,
    script: async () => { const found = read(tick); return found.error ? { ok: false, error: found.error } : { ok: true, output: found.output ?? "" }; },
  });
  let thread = 0;
  const manager = new RoutineManager({
    file: join(dir, "routines.json"), now: () => now, botState: () => "ready",
    createTask: () => ({ threadId: `thread-${++thread}` }),
    startTurn: async (_botId, _threadId, text) => { prompts.push(String(text)); },
    checks: withProbes(undefined, probes),
  });
  const finishRuns = () => {
    for (const run of manager.listRuns().filter((one) => one.status === "running")) {
      manager.handleRuntimeEvent({ eventId: `done-${run.id}`, provider: "fake", threadId: run.threadId!, createdAt: new Date(now).toISOString(), type: "turn.completed", ok: true } as never);
    }
  };
  return {
    manager, prompts,
    /** One scheduled hour: the check, then any run it started answers. */
    async hour() { now += HOUR; tick++; await manager.tick(); await settle(); finishRuns(); await settle(); },
    boot() { now += CHECK_BOOT_HOLD_MS; },
  };
}

describe("a polling routine with a plain check", () => {
  it("over 24 hourly checks with 2 changes makes exactly 2 model calls", async () => {
    const changesAt = new Set([7, 18]);
    let version = 0;
    const h = polling((tick) => { if (changesAt.has(tick)) version++; return { output: `last message id: ${100 + version}` }; });
    h.manager.create({ name: "Telegram watch", prompt: "Tell me about new messages in the group.", botId: "b", continuity: true,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: START + HOUR }, probe: { kind: "script", url: "", command: "tg-last-id" } });
    h.boot();
    for (let hour = 0; hour < 24; hour++) await h.hour();
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[0]).toContain("last message id: 101");
    expect(h.prompts[0]).toContain("What it printed at the last check");
    expect(h.prompts[0]).toContain("last message id: 100");
    expect(h.prompts[1]).toContain("last message id: 102");
  });

  it("stays asleep on {\"wakeAgent\": false} and always wakes on true", async () => {
    const h = polling((tick) => ({ output: tick === 5 ? "{\"wakeAgent\": true, \"why\": \"due\"}" : "{\"wakeAgent\": false}" }));
    h.manager.create({ name: "Due check", prompt: "Act on what is due.", botId: "b",
      schedule: { type: "interval", everyMinutes: 60, anchorAt: START + HOUR }, probe: { kind: "script", url: "", command: "due" } });
    h.boot();
    for (let hour = 0; hour < 10; hour++) await h.hour();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("asked for this run");
  });

  it("watches only the part a selector names", async () => {
    const h = polling((tick) => ({ page: `<html><p>ad ${tick}</p><div id="status" class="x"><b>Status:</b> ${tick < 4 ? "pending" : "shipped"}</div></html>` }));
    h.manager.create({ name: "Order", prompt: "Tell me when the order status changes.", botId: "b",
      schedule: { type: "interval", everyMinutes: 60, anchorAt: START + HOUR }, probe: { kind: "page", url: "https://shop.example/order", selector: "#status" } });
    h.boot();
    for (let hour = 0; hour < 8; hour++) await h.hour();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("shipped");
  });

  it("never reports a failing script as quiet", async () => {
    const failures: string[] = [];
    const dir = tempDir();
    const probes = createRoutineProbes({ dataDir: dir, failed: (_routine, sentence) => failures.push(sentence) });
    const routine = { id: "r1", probe: { kind: "script", url: "", command: "x" }, checks: ["probe"], prompt: "p" } as never;
    for (let i = 0; i < 3; i++) expect(await probes.check(routine, { manual: false })).toEqual({ trouble: `Couldn't check its script: ${NO_SCRIPTS}` });
    expect(failures).toHaveLength(1);
  });
});

describe("check parts", () => {
  it("finds the element a selector names, nested tags included", () => {
    const html = `<div class="a"><div id="inner">x <div>y</div> z</div></div><span class="price big">9.99</span><img class="price">`;
    expect(sectionOf(html, "#inner")).toBe("x <div>y</div> z");
    expect(sectionOf(html, "span.price")).toBe("9.99");
    expect(sectionOf(html, ".a")).toBe(`<div id="inner">x <div>y</div> z</div>`);
    expect(sectionOf(html, "#missing")).toBeNull();
  });

  it("cleans a script or selector probe and refuses a bad one", () => {
    expect(cleanProbe({ kind: "script", command: "  ./check.sh  " })).toEqual({ kind: "script", url: "", command: "./check.sh" });
    expect(cleanProbe({ kind: "page", url: "https://a.example/", selector: "div.status" })).toEqual({ kind: "page", url: "https://a.example/", selector: "div.status" });
    expect(() => cleanProbe({ kind: "script", command: "a\nb" })).toThrow(/one command line/);
    expect(() => cleanProbe({ kind: "feed", url: "https://a.example/", selector: "#x" })).toThrow(/only to a page/);
    expect(() => cleanProbe({ kind: "page", url: "https://a.example/", selector: "div > p" })).toThrow(/selector/);
  });

  it("reads wakeAgent only from a JSON last line", () => {
    expect(wakeAsked("{\"wakeAgent\": false}")).toBe(false);
    expect(wakeAsked("3 new\n{\"wakeAgent\":true}")).toBe(true);
    expect(wakeAsked("wakeAgent false")).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("runs a script with only the base environment", async () => {
    const result = await runCheckScript("echo \"$DUSK_SECRET_TEST:$HOME\"", { env: { DUSK_SECRET_TEST: "leak", HOME: "/tmp", PATH: process.env.PATH }, sandbox: false });
    expect(result).toEqual({ ok: true, output: ":/tmp\n" });
    expect(await runCheckScript("exit 3", { env: { PATH: process.env.PATH, HOME: "/tmp" }, sandbox: false })).toMatchObject({ ok: false, error: expect.stringMatching(/exit code 3/) });
  });

  it("lets only the owner's own request set a script check, through a card after outside content or at an ask-first level", () => {
    const turn = { owned: true, room: false, guest: false, depth: 0, handedOff: false, outsideDriven: false, routineRun: false, personStarted: true, asksFirst: false };
    const clean = { readOutside: false, fullAccess: false, unfenced: false };
    expect(scriptCheckGate(turn, false, clean)).toEqual({ apply: true });
    expect(scriptCheckGate(turn, true, clean)).toEqual({ refused: expect.stringMatching(/dusk cloud/) });
    expect(scriptCheckGate({ ...turn, routineRun: true }, false, clean)).toEqual({ refused: expect.stringMatching(/Only the person/) });
    expect(scriptCheckGate({ ...turn, outsideDriven: true }, false, clean)).toEqual({ refused: expect.stringMatching(/Only the person/) });
    expect(scriptCheckGate(turn, false, { ...clean, readOutside: true })).toEqual({ card: true });
    expect(scriptCheckGate(turn, false, { ...clean, readOutside: true, fullAccess: true })).toEqual({ apply: true });
    expect(scriptCheckGate(turn, false, { ...clean, fullAccess: true, unfenced: true })).toEqual({ card: true });
    expect(scriptCheckGate({ ...turn, asksFirst: true }, false, clean)).toEqual({ card: true });
    expect(setsScript({ action: "create", routine: { probe: { kind: "script" } } })).toBe(true);
    expect(setsScript({ action: "update", changes: { probe: { kind: "page" } } })).toBe(false);
    expect(setsFullAccess({ action: "update", changes: { probe: { kind: "script", access: "full" } } })).toBe(true);
    expect(setsFullAccess({ action: "create", routine: { probe: { kind: "script" } } })).toBe(false);
  });
});

describe("the script sandbox on macOS", () => {
  it("allows writes only to its scratch folder and no reads of the person's keys", () => {
    const profile = sandboxProfile("/private/tmp/scratch", "/Users/a");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(allow file-write* (subpath "/private/tmp/scratch")');
    expect(profile).toContain('(subpath "/Users/a/.ssh")');
    expect(profile).not.toContain("network");
  });

  it.runIf(process.platform === "darwin")("blocks a write to the home folder and a read of ~/.ssh, and lets the scratch folder and the network be used", async () => {
    const home = mkdtempSync(join(tmpdir(), "dusk-sbx-home-"));
    dirs.push(home);
    const env = { HOME: home, PATH: process.env.PATH };
    expect(await runCheckScript("echo ok > \"$TMPDIR/x\" && cat \"$TMPDIR/x\"", { env })).toEqual({ ok: true, output: "ok\n" });
    expect(await runCheckScript("echo no > \"$HOME/written\"", { env })).toMatchObject({ ok: false, error: expect.stringMatching(/not permitted/) });
    expect(await runCheckScript("mkdir -p \"$HOME/.ssh\"", { env })).toMatchObject({ ok: false });
  });
});

describe("the script fence on Linux", () => {
  it("binds the filesystem read-only, scratch writable, hides key folders and files, and keeps the network", () => {
    const kinds: Record<string, "dir" | "file"> = { "/home/a/.ssh": "dir", "/home/a/.netrc": "file" };
    const args = bwrapArgs("/tmp/dusk-script-checks", "/home/a", "echo hi", (path) => kinds[path] ?? null);
    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
    expect(args.join(" ")).toContain("--bind /tmp/dusk-script-checks /tmp/dusk-script-checks");
    expect(args.join(" ")).toContain("--tmpfs /home/a/.ssh");
    expect(args.join(" ")).toContain("--ro-bind /dev/null /home/a/.netrc");
    expect(args).toContain("--share-net");
    expect(args).not.toContain("--unshare-net");
    expect(args.slice(-3)).toEqual(["/bin/sh", "-c", "echo hi"]);
  });
});

describe("continuity", () => {
  it("carries the last run that said something, not a quiet one", () => {
    const base = { routineId: "r", botId: "b", target: "bot", runOn: "maus", status: "completed" } as const;
    const runs = [
      { ...base, id: "1", output: "3 new orders: A, B, C", finishedAt: 1, createdAt: 1 },
      { ...base, id: "2", output: "NOTHING NEW", report: { state: "quiet" }, finishedAt: 2, createdAt: 2 },
    ] as unknown as RoutineRun[];
    const carry = continuityCarry({ ...base, id: "3", createdAt: 3 } as unknown as RoutineRun, [{ id: "r", continuity: true }], runs);
    expect(carry?.output).toBe("3 new orders: A, B, C");
  });
});
