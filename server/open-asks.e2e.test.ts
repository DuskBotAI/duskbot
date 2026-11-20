// The fake engine only acknowledges the person's ask ("On it, checking now."): the server sends the turn back once with
// a note only the bot reads, shows the person no line for it, and the ask's row ends delivered once the result comes.
// Scripted, so this proves what the server does with an undelivered ask, not what a model chooses to say.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlDusk } from "../scripts/control-dusk.ts";
import { stopGateNote } from "./turn-stop-gates.ts";

it("sends an acknowledged-only ask back once, hidden, and marks it delivered when the result comes", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "dusk-open-asks-"));
  const prompts = join(scratch, "prompts.jsonl");
  const fixture = await launchVerificationServer({
    ...process.env,
    FAKE_CLAUDE_REPLIES: JSON.stringify(["On it, checking now.", "18% of 2450 is 441."]),
    FAKE_CLAUDE_REPLY_STATE: join(scratch, "replies.state"),
    FAKE_CLAUDE_TOOL_CALLS: "[]",
    FAKE_CLAUDE_PROMPTS: prompts,
  });
  const cli = (...args: string[]) => runControlDusk([...args, "--url", fixture.info.url]) as Promise<any>;
  const rows = async (threadId: string) => {
    const response = await fetch(`${fixture.info.url}/api/threads/${encodeURIComponent(threadId)}/messages?limit=100`);
    return (((await response.json()) as { messages: unknown }).messages as Array<{ role: string; kind: string; text?: string; tool?: { name: string }; ask?: { state: string; nudged?: boolean } }>);
  };
  try {
    const { bot } = await cli("new-bot", "--name", "Ledger");
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "what's 18% of 2450");
    await expect.poll(async () => (await rows(bot.activeTaskId)).some((row) => row.text === "18% of 2450 is 441."), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await rows(bot.activeTaskId)).find((row) => row.role === "user")?.ask, { timeout: 5_000 }).toEqual({ state: "delivered", nudged: true });
    const all = await rows(bot.activeTaskId);
    expect(all.filter((row) => row.kind === "activity" && row.tool?.name?.startsWith("recovery: "))).toEqual([]);
    expect(readFileSync(prompts, "utf8")).toContain(JSON.stringify(stopGateNote("open_items", { items: ["what's 18% of 2450"] })).slice(1, -1));
    // delivered: nothing is sent back a second time
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const after = await rows(bot.activeTaskId);
    expect(after.slice(after.findIndex((row) => row.role === "user")).filter((row) => row.role === "bot" && row.kind === "text").map((row) => row.text)).toEqual(["On it, checking now.", "18% of 2450 is 441."]);
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
