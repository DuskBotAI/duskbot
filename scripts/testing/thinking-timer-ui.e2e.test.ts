// The working line is anchored to the server's turn-start stamp (for a group,
// its speaker's claim), not to when the conversation was last selected: back
// on a turn that has run a while, it says what is happening at once instead of
// starting the turn's opening quiet over. It never counts seconds.
// Needs the pinned agent-browser binary: runs when one resolves (tools
// directory, DUSK_AGENT_BROWSER_PATH or PATH) or DUSK_UI_E2E=1 asks for the
// verified download; otherwise skipped.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { runControlDusk } from "../control-dusk.ts";
import { UI_TOOLS_DIR } from "./control-dusk-ui.ts";
import { fixtureApi } from "./preview-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = join(ROOT, "scripts", "control-dusk.ts");
const forced = process.env.DUSK_UI_E2E === "1";
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = forced || Boolean(binary);
if (!enabled) {
  console.log(`skipping thinking-timer ui e2e: no agent-browser binary resolves (looked in ${UI_TOOLS_DIR}, DUSK_AGENT_BROWSER_PATH and PATH); set DUSK_UI_E2E=1 to install the pinned release`);
}
const run = enabled ? it : it.skip;
// A cold run downloads the binary and Chrome; a warm one launches in seconds.
const LAUNCH_TIMEOUT_MS = forced ? 600_000 : 180_000;

// DUSK_UI_EVIDENCE_DIR keeps the screenshot (CI uploads it); otherwise it is temporary.
const evidenceDir = process.env.DUSK_UI_EVIDENCE_DIR ? resolve(ROOT, process.env.DUSK_UI_EVIDENCE_DIR) : mkdtempSync(join(tmpdir(), "dusk-ui-evidence-"));
const ownsEvidenceDir = !process.env.DUSK_UI_EVIDENCE_DIR;

interface Launched {
  child: ReturnType<typeof spawn>;
  info: { ui: string; url: string; previewUrl: string; botId: string; dataDir: string; logPath: string };
  stderr: () => string;
}

function launch(args: string[]): Promise<Launched> {
  return new Promise((done, fail) => {
    // Own process group: a timeout must also take down whatever it is running.
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, "ui", "launch", ...args], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, signal); return; } catch { /* group already gone */ }
      }
      child.kill(signal);
    };
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup("SIGINT");
      setTimeout(() => killGroup("SIGKILL"), 10_000).unref();
      fail(new Error(`ui launch printed no handle within ${LAUNCH_TIMEOUT_MS}ms\nstderr:\n${stderr}`));
    }, LAUNCH_TIMEOUT_MS);
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
      if (settled) return;
      // A tool printing on stdout before the handle still parses from the
      // first line that starts the object.
      const start = stdout.startsWith("{") ? 0 : stdout.indexOf("\n{") + 1;
      if (start <= 0 && !stdout.startsWith("{")) return;
      try {
        const info = JSON.parse(stdout.slice(start));
        settled = true;
        clearTimeout(timer);
        done({ child, info, stderr: () => stderr });
      } catch {
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      fail(new Error(`ui launch exited ${code} before printing a handle\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

const ui = (verb: string, handle: string, ...args: string[]) =>
  runControlDusk(["ui", verb, "--ui", handle, ...args]) as Promise<Record<string, any>>;

/** A seconds count as the old readout wrote it ("42s", "1m 05s"): the line and its tooltip never show one. */
const SECONDS = /\b\d+s\b|\b\d+m \d{2}s\b/;

/** In the page: clicks `click` (if given), then waits for the working line to have words, and says how long that took
 * and what the line and its tooltip read. A fresh turn's line is quiet for STATUS_QUIET_MS (1.8 s at least) first. */
const wordsAfter = (click: string | null) => `new Promise((done) => {
  ${click ? `document.querySelector(${JSON.stringify(click)}).click();` : ""}
  const start = performance.now();
  const read = () => {
    const line = document.querySelector('.turn-presence [data-turn-status]');
    const words = line?.textContent?.trim() ?? "";
    if (words || performance.now() - start > 15000) {
      const tip = document.querySelector('.turn-presence [title]')?.getAttribute('title') ?? "";
      done({ ms: Math.round(performance.now() - start), words, tip });
    } else setTimeout(read, 20);
  };
  read();
})`;

async function waitUntil<T>(probe: () => Promise<T>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await probe();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs}ms (last: ${JSON.stringify(last)})`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

describe("the thinking timer stays anchored across a thread switch", () => {
  let launched: Launched | undefined;

  afterEach(async () => {
    const current = launched;
    launched = undefined;
    if (!current) return;
    try {
      if (current.child.exitCode === null && current.child.signalCode === null) {
        const api = fixtureApi(current.info.url);
        const state = await api("GET", "/api/bots").catch(error => ({ error: String(error) }));
        const snapshot = await ui("snapshot", current.info.ui).catch(error => ({ error: String(error) }));
        writeFileSync(`${current.info.logPath}.thinking-timer.json`, JSON.stringify({ info: current.info, state, snapshot }, null, 2), { mode: 0o600 });
        console.log("Thinking timer fixture evidence saved.");
      }
    } finally {
      await waitForExit(current.child, { signal: "SIGINT", graceMs: 30_000 });
      expect(existsSync(current.info.dataDir)).toBe(false);
    }
  });

  afterAll(async () => {
    if (ownsEvidenceDir) await removeTempDir(evidenceDir);
  });

  run("keeps the working line on the server's turn-start stamp across a re-selection, and never counts seconds", async () => {
    launched = await launch(["--mode", "hang"]); // the turn never settles; the bot stays busy
    const { info } = launched;
    const api = fixtureApi(info.url);
    const evaluate = async (js: string) => (await ui("eval", info.ui, "--js", js)).result;
    // The simple sidebar lists bots, not threads: a person leaves Pepper's busy conversation by opening another bot
    // and comes back through Pepper's row, which reopens the same conversation.
    const rowOf = (botId: string) => `[data-sidebar-bot-row="${botId}"]`;
    const selectRow = (botId: string) => evaluate(`document.querySelector('${rowOf(botId)}')?.click(); true`);
    const isCurrent = (botId: string) => evaluate(`Boolean(document.querySelector('${rowOf(botId)}[aria-current="page"]'))`);
    const taskOf = async (threadId: string) =>
      (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === info.botId).tasks.find((task: any) => task.threadId === threadId);

    const { bots } = await api("GET", "/api/bots");
    const busyThread = bots.find((bot: any) => bot.id === info.botId).threadId;
    const otherBot = bots.find((bot: any) => bot.id !== info.botId && !bot.hidden).id;
    await waitUntil(() => evaluate(`Boolean(document.querySelector('${rowOf(otherBot)}'))`), 10_000, "the other bot's sidebar row to appear");
    await selectRow(info.botId);
    await waitUntil(() => isCurrent(info.botId), 10_000, "Pepper to become current");

    await ui("type", info.ui, "--name", "Message Pepper", "--text", "hello");
    await ui("press", info.ui, "--keys", "Enter");
    const sentAt = Date.now();

    const busy = await waitUntil(async () => {
      const task = await taskOf(busyThread);
      return task && task.busy && typeof task.turnStartedAt === "number" ? task : null;
    }, 60_000, "the task to go busy with a turnStartedAt stamp");
    const stamp = busy.turnStartedAt as number;
    expect(stamp).toBeGreaterThanOrEqual(sentAt - 2_000);
    expect(stamp).toBeLessThanOrEqual(Date.now() + 2_000);

    const first = await evaluate(wordsAfter(null)) as { ms: number; words: string; tip: string };
    expect(first.words, "the working line has words").not.toBe("");
    expect(`${first.words} ${first.tip}`).not.toMatch(SECONDS);
    await new Promise((done) => setTimeout(done, Math.max(0, stamp + 10_000 - Date.now())));

    await selectRow(otherBot);
    await waitUntil(() => isCurrent(otherBot), 10_000, "the other bot to become current");
    await new Promise((done) => setTimeout(done, 3_000));
    // A line that restarted at the re-selection would sit through a fresh turn's quiet (1.8 s at least) first.
    const resumed = await evaluate(wordsAfter(rowOf(info.botId))) as { ms: number; words: string; tip: string };
    await waitUntil(() => isCurrent(info.botId), 10_000, "Pepper's busy conversation to become current again");
    expect((await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === info.botId).threadId).toBe(busyThread);
    expect(resumed.words, "the working line has words again").not.toBe("");
    expect(resumed.ms, "words at once on a turn that has run a while").toBeLessThan(1_500);
    expect(`${resumed.words} ${resumed.tip}`).not.toMatch(SECONDS);

    expect(await taskOf(busyThread)).toMatchObject({ busy: true, turnStartedAt: stamp });

    mkdirSync(evidenceDir, { recursive: true });
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "thinking-timer-anchored.png"));
    const logs = await ui("console", info.ui);
    expect((logs.messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error")).toEqual([]);

    await waitForExit(launched.child, { signal: "SIGINT", graceMs: 30_000 });
    expect(launched.child.exitCode).toBe(0);
    expect(existsSync(info.dataDir)).toBe(false);
  }, LAUNCH_TIMEOUT_MS + 120_000);

  run("keeps a group's working line on the speaking member's claim after a switch away, and never counts seconds", async () => {
    launched = await launch(["--mode", "hang"]); // the group's turn never settles either
    const { info } = launched;
    const api = fixtureApi(info.url);
    const evaluate = async (js: string) => (await ui("eval", info.ui, "--js", js)).result;
    const botsState = () => api("GET", "/api/bots");
    const groupState = async () => (await botsState()).groups.find((row: any) => row.id === groupId);

    // With a single thread there is no thread list: the bot row is that
    // conversation, and the same holds for a one-thread room.
    const selectRow = (selector: string) => evaluate(`document.querySelector('${selector}')?.click(); true`);
    const isCurrentRow = (selector: string) => evaluate(`Boolean(document.querySelector('${selector}[aria-current="page"]'))`);
    const soloRow = `[data-sidebar-bot-row="${info.botId}"]`;
    // Setup completed at creation, so the composer is live at once and plain
    // messages route to Pepper on the same hang-mode fake.
    const group = (await api("POST", "/api/groups", {
      memberIds: [info.botId],
      name: "Timer group",
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: info.botId } },
    })).group;
    const groupId = group.id;

    const groupRow = `[data-sidebar-group-row="${groupId}"]`;
    await waitUntil(() => evaluate(`Boolean(document.querySelector('${groupRow}'))`), 10_000, "the group's sidebar row to appear");
    await selectRow(groupRow);
    await waitUntil(() => isCurrentRow(groupRow), 10_000, "the group to become current");

    await ui("type", info.ui, "--name", "Message Timer group", "--text", "hello group");
    await ui("press", info.ui, "--keys", "Enter");
    const sentAt = Date.now();

    const busy = await waitUntil(async () => {
      const claimed = await groupState();
      return claimed && claimed.busyBotId === info.botId && typeof claimed.turnStartedAt === "number" ? claimed : null;
    }, 60_000, "the group to claim Pepper with a turnStartedAt stamp");
    const stamp = busy.turnStartedAt as number;
    expect(stamp).toBeGreaterThanOrEqual(sentAt - 2_000);
    expect(stamp).toBeLessThanOrEqual(Date.now() + 2_000);

    const first = await evaluate(wordsAfter(null)) as { ms: number; words: string; tip: string };
    expect(first.words, "the group's working line has words").not.toBe("");
    expect(`${first.words} ${first.tip}`).not.toMatch(SECONDS);
    await new Promise((done) => setTimeout(done, Math.max(0, stamp + 10_000 - Date.now())));

    await selectRow(soloRow);
    await waitUntil(() => isCurrentRow(soloRow), 10_000, "the 1:1 thread to become current");
    await new Promise((done) => setTimeout(done, 3_000));
    // A line that restarted at the re-selection would sit through a fresh turn's quiet (1.8 s at least) first.
    const resumed = await evaluate(wordsAfter(groupRow)) as { ms: number; words: string; tip: string };
    await waitUntil(() => isCurrentRow(groupRow), 10_000, "the group to become current again");
    expect(resumed.words, "the group's working line has words again").not.toBe("");
    expect(resumed.ms, "words at once on a turn that has run a while").toBeLessThan(1_500);
    expect(`${resumed.words} ${resumed.tip}`).not.toMatch(SECONDS);

    expect(await groupState()).toMatchObject({ busyBotId: info.botId, turnStartedAt: stamp });

    mkdirSync(evidenceDir, { recursive: true });
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "thinking-timer-group.png"));
    const logs = await ui("console", info.ui);
    expect((logs.messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error")).toEqual([]);

    await waitForExit(launched.child, { signal: "SIGINT", graceMs: 30_000 });
    expect(launched.child.exitCode).toBe(0);
    expect(existsSync(info.dataDir)).toBe(false);
  }, LAUNCH_TIMEOUT_MS + 120_000);
});
