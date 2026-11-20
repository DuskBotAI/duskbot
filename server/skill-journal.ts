// Kept outside the workspace on purpose: a version history the bot can rewrite is not a history.
// A journal write must never fail the change it records.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export type SkillJournalKind = "created" | "updated" | "undone" | "archived" | "restored";
export type SkillJournalActor = "review" | "person" | "curator";

export interface SkillJournalEntry {
  id: string;
  at: number;
  botId: string;
  name: string;
  kind: SkillJournalKind;
  actor: SkillJournalActor;
  threadId?: string;
  /** The SKILL.md before and after the change; null where there was none. */
  before: string | null;
  after: string | null;
}

export const SKILL_JOURNAL_DIR = join(DATA_DIR, "skill-journal");
/** Past this the oldest half of a bot's rows go. */
export const SKILL_JOURNAL_MAX_BYTES = 2 * 1024 * 1024;

export function skillJournalFile(botId: string, dir = SKILL_JOURNAL_DIR): string {
  return join(dir, `${botId}.ndjson`);
}

export function appendSkillJournal(row: Omit<SkillJournalEntry, "id" | "at"> & { at?: number }, dir = SKILL_JOURNAL_DIR): void {
  const entry: SkillJournalEntry = { id: randomUUID(), at: row.at ?? Date.now(), ...row };
  const file = skillJournalFile(row.botId, dir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    if (statSync(file).size > SKILL_JOURNAL_MAX_BYTES) {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      writeFileAtomic(file, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`, { mode: 0o600 });
    }
  } catch (error) {
    console.warn(`skill journal: could not record a change to "${row.name}": ${(error as Error).message}`);
  }
}

/** Newest last. */
export function readSkillJournal(botId: string, dir = SKILL_JOURNAL_DIR): SkillJournalEntry[] {
  let text: string;
  try {
    text = readFileSync(skillJournalFile(botId, dir), "utf8");
  } catch {
    return [];
  }
  const rows: SkillJournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as SkillJournalEntry;
      if (row && typeof row.name === "string" && typeof row.kind === "string") rows.push(row);
    } catch {
    }
  }
  return rows;
}
