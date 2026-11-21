// The system prompt a new bot's one-on-one turn really gets, rendered by a fixture server and kept as a snapshot, so a
// change to it is a diff someone approved (UPDATE_PROMPT_SURFACE=1 rewrites it) and its size has a cap that only goes
// down: a prompt that shrank well under the cap fails until the cap is lowered to match.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlDusk } from "../scripts/control-dusk.ts";

const SNAPSHOT = join(import.meta.dirname, "prompt-surface", "personal-chat.txt");
const BUDGET_CHARS = 36_000;
const RATCHET_SLACK = 1_500;

function normalise(system: string, dataDir: string, scratch: string): string {
  return system
    .replaceAll(dataDir, "<data>")
    .replaceAll(scratch, "<scratch>")
    .replace(/\/(?:private\/)?(?:var\/folders|tmp)\/[^\s"')]*/g, "<tmp>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/g, "<date>");
}

it("keeps the one-on-one system prompt as approved and under its cap", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "dusk-prompt-surface-"));
  const fixture = await launchVerificationServer({ ...process.env, TZ: "Asia/Kolkata" }, undefined, undefined, undefined, { scripted: true });
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const evidence = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const cli = (...args: string[]) => runControlDusk([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    const { bot } = await cli("new-bot", "--name", "Sage");
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { steps: [], reply: "Sure." } }));
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Every weekday at 8am send me my top 3 priorities.");
    await expect.poll(() => evidence().length, { timeout: 30_000 }).toBeGreaterThan(0);
    const rendered = normalise(String(evidence().at(-1).system), fixture.info.dataDir, scratch);
    if (process.env.UPDATE_PROMPT_SURFACE === "1") writeFileSync(SNAPSHOT, rendered);
    expect(rendered.length, "the prompt grew past its cap: cut something before adding").toBeLessThanOrEqual(BUDGET_CHARS);
    expect(rendered.length, `the prompt is ${rendered.length} characters: lower BUDGET_CHARS to keep the saving`).toBeGreaterThan(BUDGET_CHARS - RATCHET_SLACK);
    expect(rendered, "the prompt changed: review the diff and rerun with UPDATE_PROMPT_SURFACE=1").toBe(readFileSync(SNAPSHOT, "utf8"));
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
