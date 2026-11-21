import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { skillCommandTurnText } from "../../shared/skill-command.ts";
import { agentsServerEnv } from "../agents-turn.ts";
import type { AppConfig } from "../config.ts";
import { availableTools } from "../drivers/agents-catalog.ts";
import { catalogProfileFromEnv } from "../drivers/agents-catalog-profile.ts";
import { learnSource } from "../skill-learn.ts";
import { applyStagedSkillWrite, setSkillEnabled, stageSkillWrite } from "../skills.ts";
import type { BotRecord, Store } from "../store.ts";
import { workspaceDir } from "../workspace.ts";
import { createSkillsLibraryHost } from "./skills-library.ts";

const SKILL = (name: string) => `---\nname: ${name}\ndescription: Does ${name}.\n---\n\n# ${name}\n\n## Procedure\n1. Do the thing.\n`;
const bots: string[] = [];
afterEach(() => {
  for (const id of bots.splice(0)) rmSync(workspaceDir(id), { recursive: true, force: true });
});

function botWith(...skills: Array<{ name: string; references?: Array<{ path: string; content: string }> }>): BotRecord {
  const id = `skill-reading-${Math.random().toString(36).slice(2, 10)}`;
  bots.push(id);
  for (const skill of skills) {
    const staged = stageSkillWrite(id, { action: "create", files: [{ path: "SKILL.md", content: SKILL(skill.name) }, ...(skill.references ?? [])], source: learnSource("conversation") });
    if ("error" in staged) throw new Error(staged.error);
    const applied = applyStagedSkillWrite(id, staged.id, { expectedSha256: staged.sha256, expectedReferencesSha256: staged.referencesSha256 ?? null });
    if ("error" in applied) throw new Error(applied.error);
  }
  return { id, threadId: `${id}-thread`, name: "Ledger", modelSelection: { instanceId: "api" } } as unknown as BotRecord;
}

const host = () => createSkillsLibraryHost({
  store: { bot: () => undefined, messagesFor: () => [], taskByThread: () => undefined } as unknown as Store,
  cfg: {} as AppConfig,
  appendSkillRequestCard: () => ({ requestId: "", summary: "" }),
});
const API = { instanceId: "api", driverKind: "openai-compat" };

describe("skills for engines with no file tools", () => {
  it("lists skills without paths and tells the bot to load them with read_skill", () => {
    const bot = botWith({ name: "weekly-report" });
    const index = host().skillsIndex(bot, undefined, API);
    expect(index).toContain("- weekly-report: Does weekly-report.\n");
    expect(index).not.toContain("SKILL.md");
    expect(index).toContain("you must load it with read_skill (its name) first");
    expect(host().skillsIndex(bot, undefined, { instanceId: "claude", driverKind: "claudeAgent" })).toContain("weekly-report/SKILL.md");
  });

  it("read_skill returns an enabled skill and its files, one file on request, and nothing it may not read", () => {
    const bot = botWith({ name: "weekly-report", references: [{ path: "references/format.md", content: "Use a table." }] }, { name: "off-skill" });
    setSkillEnabled(bot.id, "off-skill", false);
    const reading = host();
    const full = reading.readForTool(bot, bot.threadId, "weekly-report");
    expect(full.text).toContain("# weekly-report");
    expect(full.text).toContain("Other files in this skill (read one with read_skill and file): references/format.md");
    expect(reading.readForTool(bot, bot.threadId, "weekly-report", "references/format.md")).toEqual({ text: "Use a table." });
    expect(reading.readForTool(bot, bot.threadId, "weekly-report", "../../config.json")).toEqual(expect.objectContaining({ isError: true }));
    expect(reading.readForTool(bot, bot.threadId, "off-skill")).toEqual({ text: 'No enabled skill named "off-skill". Enabled: weekly-report.', isError: true });
    expect(reading.readForTool(bot, bot.threadId, "../weekly-report")).toEqual(expect.objectContaining({ isError: true }));
  });

  it("/name tells the engine to load the skill with read_skill", () => {
    const text = skillCommandTurnText("/weekly-report for week 3", new Map([["weekly-report", "/x/SKILL.md"]]), "", true, true);
    expect(text).toContain('Load "weekly-report" with read_skill and follow it for this turn.');
    expect(text).not.toContain("/x/SKILL.md");
  });

  it("mounts read_skill only for an engine with no file tools", () => {
    const conversation = (engine: string) => ({ bot: { id: "b", memoryEnabled: true }, host: { skillAuthoring: true, cloudHome: false, team: false, voiceNotes: false, x: false, research: false }, threadId: "t", room: false, engine });
    const tools = (engine: string) => availableTools(catalogProfileFromEnv(agentsServerEnv(conversation(engine) as never, { generation: "g", depth: 0, skillAuthoring: true }, () => "token", "http://127.0.0.1:1"))).map((tool) => tool.name);
    expect(tools("openai-compat")).toContain("read_skill");
    expect(tools("claudeAgent")).not.toContain("read_skill");
  });
});
