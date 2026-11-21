import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createImportDistill, distillTurn, importDistillFile, MAX_WAITING_CHUNKS } from "./import-distill.ts";
import type { CaptureBatch } from "./memory-capture.ts";
import { NO_TEXT_ENGINE } from "./memory-upkeep.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: { engine?: boolean; bots?: string[]; note?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dusk-import-distill-"));
  dirs.push(dir);
  const state = { engine: options.engine ?? true, bots: new Set(options.bots ?? ["ana"]) };
  const capture = vi.fn(async (_batch: CaptureBatch) => ({ at: 0, added: 2, topics: 0, aboutMe: 1, ...(options.note ? { note: options.note } : {}) }));
  const distill = createImportDistill({ file: importDistillFile(dir), capture, hasEngine: () => state.engine, botExists: (id) => state.bots.has(id), now: () => 1_000 });
  return { distill, capture, state };
}

describe("an import's memory, condensed by the bot's own engine", () => {
  it("goes through the capture step chunk by chunk, as the person's own words, and is gone once filed", async () => {
    const { distill, capture } = setup();
    distill.queue("ana", "OpenClaw", ["Daily notes, one", "Daily notes, two"]);
    await distill.run();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[0]![0]).toMatchObject({ botId: "ana", turns: [{ person: distillTurn("OpenClaw", "Daily notes, one"), bot: "", owner: true }] });
    expect(distill.waiting("ana")).toBe(0);
  });

  it("waits, keeping everything, while the bot has no engine that can make the call, then goes through once it has", async () => {
    const { distill, capture, state } = setup({ engine: false });
    distill.queue("ana", "Hermes Agent", ["A passage"]);
    await distill.run();
    expect(capture).not.toHaveBeenCalled();
    expect(distill.waiting("ana")).toBe(1);
    state.engine = true;
    await distill.run();
    expect(capture).toHaveBeenCalledOnce();
    expect(distill.waiting("ana")).toBe(0);
  });

  it("never sends the engine a chunk it already went through for that bot, when the same notes come in again", async () => {
    const { distill, capture } = setup();
    distill.queue("ana", "Grok Bot", ["Passage one", "Passage two"]);
    await distill.run();
    expect(distill.queue("ana", "Grok Bot", ["Passage one", "Passage two"]), "nothing new waits").toBe(0);
    distill.queue("ana", "Grok Bot", ["Passage two", "Passage three"]);
    await distill.run();
    expect(capture.mock.calls.map(([batch]) => batch.turns[0]!.person)).toEqual(["Passage one", "Passage two", "Passage three"].map((chunk) => distillTurn("Grok Bot", chunk)));
    const other = setup({ bots: ["ben"] });
    other.distill.queue("ben", "Grok Bot", ["Passage one"]);
    await other.distill.run();
    expect(other.capture, "another bot's are its own").toHaveBeenCalledOnce();
  });

  it("reads what an earlier version left waiting", async () => {
    const { distill, capture } = setup();
    writeFileSync(importDistillFile(dirs.at(-1)!), JSON.stringify({ ana: { from: "Claude", chunks: ["Left from before"], queuedAt: 5 } }));
    expect(distill.waiting("ana")).toBe(1);
    await distill.run();
    expect(capture).toHaveBeenCalledOnce();
  });

  it("keeps a chunk the engine turned out unable to read, drops a deleted bot's, and holds at most the cap", async () => {
    const stuck = setup({ note: NO_TEXT_ENGINE });
    stuck.distill.queue("ana", "Claude", ["Kept for later"]);
    await stuck.distill.run();
    expect(stuck.distill.waiting("ana")).toBe(1);
    const gone = setup({ engine: false });
    expect(gone.distill.queue("ana", "Claude", Array.from({ length: MAX_WAITING_CHUNKS + 5 }, (_, i) => `chunk ${i}`))).toBe(MAX_WAITING_CHUNKS);
    gone.state.bots.clear();
    await gone.distill.run();
    expect(gone.distill.waiting("ana")).toBe(0);
  });
});
