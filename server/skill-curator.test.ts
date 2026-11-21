import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ARCHIVE_AFTER_MS, createSkillCurator, skillsReadInTurn, STALE_AFTER_MS } from "./skill-curator.ts";
import { appendSkillJournal, readSkillJournal } from "./skill-journal.ts";
import { REVIEW_SKILL_SOURCE } from "./skill-learn.ts";

const DAY = 24 * 60 * 60_000;

describe("the skill curator", () => {
  let dir: string;
  let clock: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dusk-skill-curator-"));
    clock = 1_000 * DAY;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const curator = () => createSkillCurator({ statePath: join(dir, "curator.json"), now: () => clock });
  const learned = (name: string, enabled = true) => ({ name, enabled, source: REVIEW_SKILL_SOURCE });

  it("marks a learned skill stale after 14 idle days and archives it at 30, never the person's own", () => {
    const first = curator();
    expect(first.curate("bot", [learned("weekly-report"), { name: "mine", enabled: true, source: "learn:conversation" }])).toEqual({ archive: [], restored: [] });
    clock += STALE_AFTER_MS;
    expect([...first.stale("bot")]).toEqual(["weekly-report"]);
    clock += ARCHIVE_AFTER_MS - STALE_AFTER_MS;
    const later = curator();
    expect(later.curate("bot", [learned("weekly-report"), { name: "mine", enabled: true, source: "learn:conversation" }])).toEqual({ archive: ["weekly-report"], restored: [] });
    expect(later.stale("bot").size).toBe(0);
  });

  it("starts the clock afresh when a skill is used or rewritten", () => {
    const c = curator();
    c.curate("bot", [learned("a"), learned("b")]);
    clock += 20 * DAY;
    c.used("bot", ["a"]);
    c.written("bot", "b");
    clock += 20 * DAY;
    expect(c.curate("bot", [learned("a"), learned("b")]).archive).toEqual([]);
    expect(c.stale("bot")).toEqual(new Set(["a", "b"]));
  });

  it("restores an archived skill the person switched back on, and leaves one they switched off alone", () => {
    const c = curator();
    c.curate("bot", [learned("a"), learned("off", false)]);
    clock += ARCHIVE_AFTER_MS;
    expect(c.curate("bot", [learned("a"), learned("off", false)]).archive).toEqual(["a"]);
    expect(c.curate("bot", [learned("a", false), learned("off", false)])).toEqual({ archive: [], restored: [] });
    expect(c.curate("bot", [learned("a", true), learned("off", false)])).toEqual({ archive: [], restored: ["a"] });
    clock += 10 * DAY;
    expect(c.curate("bot", [learned("a", true)]).archive).toEqual([]);
  });

  it("counts a skill as used when a tool read its SKILL.md or the person called it", () => {
    const messages = [
      { role: "user", kind: "text", text: "do the /weekly-report please" },
      { role: "bot", kind: "activity", turnId: "t1", tool: { name: "Read", input: "/data/bot/skills/invoice-export/SKILL.md" } },
      { role: "bot", kind: "text", turnId: "t1", text: "Done" },
    ];
    expect(skillsReadInTurn(messages, "t1", ["weekly-report", "invoice-export", "weekly"])).toEqual(["weekly-report", "invoice-export"]);
    expect(skillsReadInTurn(messages, "t2", ["invoice-export"])).toEqual([]);
    const viaTool = [{ role: "bot", kind: "activity", turnId: "t3", tool: { name: "agents_read_skill", input: '{ "name": "weekly-report" }' } }];
    expect(skillsReadInTurn(viaTool, "t3", ["weekly-report", "weekly"])).toEqual(["weekly-report"]);
  });
});

describe("the skill journal", () => {
  it("keeps every version, newest last, and never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "dusk-skill-journal-"));
    try {
      appendSkillJournal({ botId: "bot", name: "a", kind: "created", actor: "review", before: null, after: "v1" }, dir);
      appendSkillJournal({ botId: "bot", name: "a", kind: "updated", actor: "review", before: "v1", after: "v2" }, dir);
      appendSkillJournal({ botId: "bot", name: "a", kind: "undone", actor: "person", before: "v2", after: "v1" }, dir);
      expect(readSkillJournal("bot", dir).map((row) => [row.kind, row.after])).toEqual([["created", "v1"], ["updated", "v2"], ["undone", "v1"]]);
      expect(() => appendSkillJournal({ botId: "bot", name: "a", kind: "created", actor: "review", before: null, after: "x" }, join(dir, "bot.ndjson", "nope"))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
