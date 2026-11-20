// Stop means stop, for threads too: the fake engine opens a thread on itself (start_thread) and keeps working; the
// person's Stop in the asking chat also stops the opened thread's turn, so nothing it started keeps running.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlDusk } from "../scripts/control-dusk.ts";
import { request } from "../scripts/mcp-server.ts";

it("stops the threads a request opened on itself when the person stops the chat that asked", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "dusk-stop-threads-"));
  const fixture = await launchVerificationServer({
    ...process.env,
    FAKE_CLAUDE_MCP_TOOLS: JSON.stringify([{ tool: "start_thread", arguments: { title: "Invoice sweep", message: "go through last quarter's invoices" } }]),
    FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([{ name: "Bash", input: { command: "sleep 600" }, hold: true }]),
    FAKE_CLAUDE_RELEASE: join(scratch, "never"),
    FAKE_CLAUDE_REPLIES: JSON.stringify(["Working on it."]),
  });
  const cli = (...args: string[]) => runControlDusk([...args, "--url", fixture.info.url]) as Promise<any>;
  const tasks = async (botId: string) => (((await request("/api/bots?messages=0", {}, fixture.info.url)) as any).bots as any[]).find((one) => one.id === botId)?.tasks as Array<{ threadId: string; busy?: boolean; title?: string }>;
  try {
    const { bot } = await cli("new-bot", "--name", "Sweeper");
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "sort out my invoices");
    await expect.poll(async () => (await tasks(bot.id)).some((task) => task.threadId !== bot.activeTaskId && task.busy), { timeout: 30_000 }).toBe(true);

    await cli("interrupt", "--bot", bot.id, "--task", bot.activeTaskId);
    await expect.poll(async () => (await tasks(bot.id)).filter((task) => task.busy).map((task) => task.title), { timeout: 15_000 }).toEqual([]);
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
