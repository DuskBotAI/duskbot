// The stale/archive clock for agent-written skills comes from Hermes Agent's curator (MIT, Copyright (c) 2025 Nous Research);
// the code here is dusk bot's own.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { REVIEW_SKILL_SOURCE } from "./skill-learn.ts";

const DAY_MS = 24 * 60 * 60_000;
export const STALE_AFTER_MS = 14 * DAY_MS;
export const ARCHIVE_AFTER_MS = 30 * DAY_MS;

interface Clock {
  /** When the curator first saw the skill, or the review last wrote it. */
  seenAt: number;
  usedAt?: number;
  /** Set when the curator switched the skill off; switching it back on in Skills restores it. */
  archivedAt?: number;
}

export interface CuratedSkill {
  name: string;
  enabled: boolean;
  source: string;
}

export interface CuratePlan {
  archive: string[];
  restored: string[];
}

export interface SkillCurator {
  written(botId: string, name: string): void;
  used(botId: string, names: readonly string[]): void;
  /** Learned-by-review skills idle long enough to sit at the end of the index. */
  stale(botId: string): Set<string>;
  /** Moves the clocks forward and says which skills to switch off; the caller switches them off. */
  curate(botId: string, skills: readonly CuratedSkill[]): CuratePlan;
  dropBot(botId: string): void;
}

export function createSkillCurator(options: { statePath: string; now?: () => number }): SkillCurator {
  const now = () => options.now?.() ?? Date.now();
  let bots: Record<string, Record<string, Clock>> | null = null;

  const state = () => {
    if (bots) return bots;
    try {
      const parsed = JSON.parse(readFileSync(options.statePath, "utf8")) as { bots?: unknown };
      bots = parsed.bots && typeof parsed.bots === "object" ? (parsed.bots as Record<string, Record<string, Clock>>) : {};
    } catch {
      bots = {};
    }
    return bots;
  };
  const save = () => {
    try {
      mkdirSync(dirname(options.statePath), { recursive: true, mode: 0o700 });
      writeFileAtomic(options.statePath, `${JSON.stringify({ version: 1, bots: state() })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`skill curator: could not save its clocks: ${(error as Error).message}`);
    }
  };
  const clocks = (botId: string) => (state()[botId] ??= {});
  const idleSince = (clock: Clock) => Math.max(clock.seenAt, clock.usedAt ?? 0);

  return {
    written(botId, name) {
      clocks(botId)[name] = { seenAt: now() };
      save();
    },
    used(botId, names) {
      const own = state()[botId];
      if (!own) return;
      let changed = false;
      for (const name of names) {
        const clock = own[name];
        if (!clock || clock.archivedAt) continue;
        clock.usedAt = now();
        changed = true;
      }
      if (changed) save();
    },
    stale(botId) {
      const own = state()[botId] ?? {};
      return new Set(Object.entries(own)
        .filter(([, clock]) => !clock.archivedAt && now() - idleSince(clock) >= STALE_AFTER_MS)
        .map(([name]) => name));
    },
    curate(botId, skills) {
      const own = clocks(botId);
      const plan: CuratePlan = { archive: [], restored: [] };
      const learned = new Map(skills.filter((skill) => skill.source === REVIEW_SKILL_SOURCE).map((skill) => [skill.name, skill]));
      let changed = false;
      for (const name of Object.keys(own)) {
        if (learned.has(name)) continue;
        delete own[name];
        changed = true;
      }
      for (const skill of learned.values()) {
        const clock = own[skill.name];
        if (!clock) {
          own[skill.name] = { seenAt: now() };
          changed = true;
          continue;
        }
        if (clock.archivedAt) {
          if (!skill.enabled) continue;
          own[skill.name] = { seenAt: now() };
          plan.restored.push(skill.name);
          changed = true;
          continue;
        }
        if (skill.enabled && now() - idleSince(clock) >= ARCHIVE_AFTER_MS) {
          clock.archivedAt = now();
          plan.archive.push(skill.name);
          changed = true;
        }
      }
      if (!Object.keys(own).length) delete state()[botId];
      if (changed) save();
      return plan;
    },
    dropBot(botId) {
      if (!state()[botId]) return;
      delete state()[botId];
      save();
    },
  };
}

export const skillCurator = createSkillCurator({ statePath: join(DATA_DIR, "skill-curator.json") });

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Skills a turn read: a tool call that opened `<name>/SKILL.md`, read_skill, or a `/name` the person typed. */
export function skillsReadInTurn(
  messages: ReadonlyArray<{ role?: string; kind?: string; turnId?: string; text?: string; tool?: { name?: string; input?: string; summary?: string } }>,
  turnId: string,
  names: readonly string[],
): string[] {
  if (!names.length) return [];
  const tools = messages.filter((message) => message.kind === "activity" && message.turnId === turnId && message.tool)
    .map((message) => `${message.tool!.input ?? ""}\n${message.tool!.summary ?? ""}`).join("\n");
  const firstReply = messages.findIndex((message) => message.turnId === turnId && message.role !== "user");
  const asked = (firstReply >= 0 ? messages.slice(0, firstReply) : messages)
    .findLast((message) => message.role === "user" && message.kind === "text")?.text ?? "";
  const loaded = messages.filter((message) => message.kind === "activity" && message.turnId === turnId && message.tool?.name?.endsWith("read_skill"))
    .map((message) => message.tool!.input ?? "").join("\n");
  return names.filter((name) => tools.includes(`${name}/SKILL.md`) || loaded.includes(JSON.stringify(name)) || new RegExp(`(^|\\s)/${escape(name)}(?![\\w-])`).test(asked));
}
