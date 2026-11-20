import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { readSkillJournal } from "../skill-journal.ts";
import { learnSource, REVIEW_SKILL_SOURCE } from "../skill-learn.ts";
import type { ReviewChange } from "../skill-review.ts";
import { applyStagedSkillWrite, listSkills, readSkillFile, stageSkillWrite } from "../skills.ts";
import { workspaceDir } from "../workspace.ts";
import { createSkillLearning } from "./skill-learning.ts";

const SKILL = (name: string, step = "Do the thing.") => `---\nname: ${name}\ndescription: Does ${name}.\n---\n\n# ${name}\n\n## Procedure\n1. ${step}\n`;
const bots: string[] = [];
const newBot = () => {
  const id = `skill-learning-${Math.random().toString(36).slice(2, 10)}`;
  bots.push(id);
  return id;
};
afterEach(() => {
  for (const id of bots.splice(0)) rmSync(workspaceDir(id), { recursive: true, force: true });
});

function install(botId: string, name: string, source: string, step?: string) {
  const staged = stageSkillWrite(botId, { action: "create", files: [{ path: "SKILL.md", content: SKILL(name, step) }], source });
  if ("error" in staged) throw new Error(staged.error);
  const applied = applyStagedSkillWrite(botId, staged.id, { expectedSha256: staged.sha256, expectedReferencesSha256: null });
  if ("error" in applied) throw new Error(applied.error);
}

describe("what the background review may change", () => {
  const learning = createSkillLearning({ enabled: () => true, botIds: () => [], withLibrary: (_botId, own) => own });

  it("shows only its own skills as editable, never one the person made with /learn", () => {
    const bot = newBot();
    install(bot, "weekly-report", REVIEW_SKILL_SOURCE);
    install(bot, "my-invoices", learnSource("conversation"));
    const skills = learning.reviewSkills(bot);
    expect(skills.find((skill) => skill.name === "weekly-report")).toEqual(expect.objectContaining({ editable: true, body: SKILL("weekly-report") }));
    expect(skills.find((skill) => skill.name === "my-invoices")).toEqual(expect.objectContaining({ editable: false }));
    expect(skills.find((skill) => skill.name === "my-invoices")!.body).toBeUndefined();
  });

  it("refuses to update the person's skill, and stages an update of its own with the text it replaces", () => {
    const bot = newBot();
    install(bot, "weekly-report", REVIEW_SKILL_SOURCE);
    install(bot, "my-invoices", learnSource("conversation"));
    const update = (name: string): ReviewChange => ({ action: "update", name, skillMd: SKILL(name, "Ask for the week first."), gist: "" });
    expect(learning.stage(bot, update("my-invoices"))).toEqual({ error: expect.stringContaining("only a skill the review wrote") });
    expect(readSkillFile(bot, "my-invoices")).toBe(SKILL("my-invoices"));
    const staged = learning.stage(bot, update("weekly-report"));
    expect(staged).toEqual(expect.objectContaining({ name: "weekly-report", before: SKILL("weekly-report") }));
  });

  it("journals every change it applies and every undo", () => {
    const bot = newBot();
    const change: ReviewChange = { action: "create", name: "weekly-report", skillMd: SKILL("weekly-report"), gist: "" };
    learning.applied(bot, "thread", change, null);
    learning.undone(bot, "thread", { name: "weekly-report", action: "create", preview: SKILL("weekly-report") });
    expect(readSkillJournal(bot).map((row) => [row.kind, row.actor])).toEqual([["created", "review"], ["undone", "person"]]);
  });

  it("archives a learned skill unused for 30 days by switching it off", () => {
    const bot = newBot();
    install(bot, "weekly-report", REVIEW_SKILL_SOURCE);
    install(bot, "my-invoices", learnSource("conversation"));
    const realNow = Date.now;
    const curating = createSkillLearning({ enabled: () => true, botIds: () => [bot], withLibrary: (_botId, own) => own });
    try {
      curating.curate();
      Date.now = () => realNow() + 31 * 24 * 60 * 60_000;
      curating.curate();
    } finally {
      Date.now = realNow;
    }
    expect(listSkills(bot).map((skill) => [skill.name, skill.enabled])).toEqual([["my-invoices", true], ["weekly-report", false]]);
    expect(readSkillJournal(bot).at(-1)).toEqual(expect.objectContaining({ kind: "archived", name: "weekly-report" }));
  });
});
