// Background jobs in a real bot box, where one can run: Linux with an unprivileged bubblewrap (a Cloud home). The job
// gets a box of its own that outlives the turn's, sees what a turn sees, and its dusk-notify reaches the server through
// the harness gate and becomes a run. Elsewhere the suite says so and skips, like the box's own self-check.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { BotBox } from "../bot-box/box.ts";
import { detectBox } from "../bot-box/detect.ts";
import { jobsFixture } from "./testing.ts";

const detection = detectBox({ env: { ...process.env, DUSK_BOT_BOX: "1" } });
const available = detection.box === "bwrap" && detection.tools !== null;
const root = mkdtempSync(join(tmpdir(), "dusk-box-jobs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, "home"), dataDir = join(home, ".duskbot");
const lines = (path: string) => { try { return readFileSync(path, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };

describe.skipIf(!available)(`background jobs in a real box (${available ? "bubblewrap works here" : `skipped: ${detection.reason}`})`, () => {
  it("keeps running after the turn's box ends, stays inside its own box, and its notify becomes a run", async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), "server secret");
    const box = new BotBox();
    let started = false;
    const fixture = await jobsFixture({ root, dataDir, wrap: (request) => (started ? box.wrap(request) : null), secrets: { "Deals token": "tok-abcdefgh" } });
    try {
      await box.start({ dataDir, home, port: fixture.port, denyEnv: new Set(), env: { ...process.env, DUSK_BOT_BOX: "1" }, log: () => {} });
      started = true;
      expect(box.enabled()).toBe(true);

      const turnCwd = join(dataDir, "task-workspaces", "bot-a", "t-1");
      mkdirSync(turnCwd, { recursive: true });
      const turnBox = box.wrap({ command: "sleep", args: ["30"], cwd: turnCwd, env: { PATH: "/usr/bin:/bin" } })!;
      const turn = spawn(turnBox.command, turnBox.args, { env: turnBox.env, stdio: ["ignore", "ignore", "ignore", ...turnBox.extraFds], detached: true });

      const beat = join(fixture.workspace, "beats.txt");
      writeFileSync(join(fixture.workspace, "watch.sh"), [
        `cat ${join(dataDir, "config.json")} >/dev/null 2>&1 && echo "SAW SERVER DATA" || echo "server data hidden"`,
        'echo "proxy=$HTTPS_PROXY home=$HOME token=${DEALS_TOKEN:+set}"',
        'dusk-notify "deal with Acme moved to contract" && echo notified',
        `while true; do date +%s%N >> ${beat}; sleep 0.2; done`,
      ].join("\n"));
      const made = await fixture.call({ action: "start", label: "Deal watch", command: "sh watch.sh", secrets: { DEALS_TOKEN: "Deals token" } });
      expect(made.status, JSON.stringify(made.body)).toBe(201);

      await expect.poll(() => lines(beat), { timeout: 15_000 }).toBeGreaterThan(2);
      process.kill(-turn.pid!, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const after = lines(beat);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(lines(beat)).toBeGreaterThan(after + 3);

      await expect.poll(() => fixture.runs.length, { timeout: 15_000 }).toBe(1);
      expect(fixture.runs[0]).toMatchObject({ botId: "bot-a", eventSource: "job", webhookName: "Deal watch" });
      expect(fixture.runs[0]!.prompt).toContain("deal with Acme moved to contract");
      const log = String((await fixture.call({ action: "logs", id: made.body.id })).body.text);
      expect(log).toContain("server data hidden");
      expect(log).toContain("proxy=http://127.0.0.1:3128");
      expect(log).toContain("token=set");
      expect(log).toContain("notified");
      expect(log).not.toContain("SAW SERVER DATA");

      expect((await fixture.call({ action: "stop", id: made.body.id })).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      const stoppedAt = lines(beat);
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(lines(beat)).toBe(stoppedAt);
    } finally {
      await fixture.close();
      await box.stop();
    }
  }, 90_000);
});
