import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-dusk.ts";
import { waitForExit } from "./testing/cleanup.ts";

// The owner's "hi" to a bot with no AI chosen waited on every engine being read. It now starts on the first one found
// working, giving one that comes first and is still being read at most a second, and the bot moves to that one after.
it.each(["codex", "claude"] as const)("a first send with no AI chosen starts on the first working engine (%s slow)", async (SLOW) => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, ["codex"]);
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  const gate = join(dataDir, "release-slow-engine");
  try {
    const botsPath = join(dataDir, "bots.json"), configPath = join(dataDir, "config.json");
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const wrap = (name: string, target: string, onlyProbes: boolean) => {
      const path = join(dataDir, `${name}-slow.mjs`);
      writeFileSync(path, ["#!/usr/bin/env node", `import { existsSync } from "node:fs";`,
        `const probe = ${onlyProbes ? `process.argv.some((a) => a === "--version" || a === "--help" || a === "auth")` : "true"};`,
        `while (probe && !existsSync(${JSON.stringify(gate)})) await new Promise((r) => setTimeout(r, 20));`,
        `await import(${JSON.stringify(new URL(target, import.meta.url).href)});`].join("\n"), { mode: 0o700 });
      return path;
    };
    if (SLOW === "codex") config.instances.codex.config.cli = wrap("codex", "./testing/fake-codex-app-server.ts", false);
    else config.instances.claude = { ...config.instances.claude, config: { ...config.instances.claude.config, cli: wrap("claude", "./testing/fake-claude-cli.ts", true) } };
    writeFileSync(configPath, JSON.stringify(config));
    const bots = JSON.parse(readFileSync(botsPath, "utf8"));
    bots[0].modelSelection = { instanceId: "", model: "" };
    writeFileSync(botsPath, JSON.stringify(bots));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log] });
    closeSync(log);
    await expect.poll(async () => { try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; } }, { timeout: 20_000, interval: 50 }).toBe(true);
    const bot = bots[0];
    const t0 = Date.now();
    const res = await fetch(`${url}/api/bots/${bot.id}/messages`, { method: "POST", headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ text: "hi", threadId: bot.threadId, sendId: randomUUID() }), signal: AbortSignal.timeout(30_000) });
    const postMs = Date.now() - t0;
    let replyMs = -1;
    await expect.poll(async () => {
      const page = await (await fetch(`${url}/api/threads/${bot.threadId}/messages?limit=20`, { headers: { origin: url } })).json() as { messages?: Array<{ role: string; kind: string; at: number }> };
      const reply = page.messages?.findLast((m) => m.role === "bot" && m.kind === "text" && m.at >= t0);
      if (reply && replyMs < 0) replyMs = Date.now() - t0;
      return Boolean(reply);
    }, { timeout: 30_000, interval: 25 }).toBe(true);
    const chosenNow = async () => (await (await fetch(`${url}/api/bots`, { headers: { origin: url } })).json() as { bots: Array<{ id: string; modelSelection: { instanceId: string } }> })
      .bots.find((b) => b.id === bot.id)?.modelSelection.instanceId;
    const chosen = await chosenNow();
    if (process.env.MEASURE_OUT) appendFileSync(process.env.MEASURE_OUT, JSON.stringify({ slow: SLOW, status: res.status, postMs, firstReplyMs: replyMs, chosen }) + "\n");
    expect(res.status).toBe(202);
    // the slow engine is still held here: a send that waited on it would have answered nothing within the 30 s above,
    // while the engine read's own deadline is a minute
    if (SLOW === "codex") {
      expect(chosen).toBe("claude");
    } else {
      // Codex answers first; Claude, which comes first, gets a second and is still being read, so Codex takes the turn;
      // once Claude's probes are done, the bot moves to Claude
      expect(chosen).toBe("codex");
      writeFileSync(gate, "go");
      await expect.poll(chosenNow, { timeout: 20_000, interval: 100 }).toBe("claude");
    }
  } finally {
    writeFileSync(gate, "go");
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);
