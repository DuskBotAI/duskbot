import { skillCurator } from "../skill-curator.ts";
import { appendSkillJournal } from "../skill-journal.ts";
import { REVIEW_SKILL_SOURCE } from "../skill-learn.ts";
import type { ReviewChange, ReviewSkill } from "../skill-review.ts";
import { listSkills, readSkillFile, setSkillEnabled, stageSkillWrite } from "../skills.ts";

export interface SkillLearningDeps {
  enabled: () => boolean;
  botIds: () => string[];
  /** The bot's own and team-library skills as the review may see them. */
  withLibrary: (botId: string, own: ReviewSkill[]) => ReviewSkill[];
}

export function createSkillLearning(deps: SkillLearningDeps) {
  const reviewOwns = (botId: string, name: string) => listSkills(botId).find((skill) => skill.name === name)?.source === REVIEW_SKILL_SOURCE;

  function curate(): void {
    if (!deps.enabled()) return;
    for (const botId of deps.botIds()) {
      try {
        const plan = skillCurator.curate(botId, listSkills(botId));
        for (const name of plan.archive) {
          const text = readSkillFile(botId, name);
          const result = setSkillEnabled(botId, name, false);
          if ("error" in result) console.warn(`skill curator: could not archive "${name}" for ${botId}: ${result.error}`);
          else appendSkillJournal({ botId, name, kind: "archived", actor: "curator", before: text, after: text });
        }
        for (const name of plan.restored) appendSkillJournal({ botId, name, kind: "restored", actor: "person", before: null, after: null });
      } catch (error) {
        console.warn(`skill curator: ${botId}: ${(error as Error).message}`);
      }
    }
  }

  return {
    /** Only skills a review wrote and nobody changed since are the review's to update: never the person's own or a team skill. */
    reviewSkills(botId: string): ReviewSkill[] {
      const own = listSkills(botId).map((skill) => {
        const editable = skill.editable && skill.enabled && skill.source === REVIEW_SKILL_SOURCE;
        return { name: skill.name, description: skill.description, editable, enabled: skill.enabled, sha256: skill.sha256,
          ...(editable ? { body: readSkillFile(botId, skill.name) } : {}) };
      });
      const ownNames = new Set(own.map((skill) => skill.name));
      return deps.withLibrary(botId, own).map((skill) => (ownNames.has(skill.name) ? skill : { ...skill, editable: false, body: null }));
    },

    /** Stages a review change as the review's own skill; `before` is the text an update replaces. */
    stage(botId: string, change: ReviewChange) {
      if (change.action === "update" && !reviewOwns(botId, change.name)) return { error: "only a skill the review wrote itself can be updated by it" };
      const before = change.action === "update" ? readSkillFile(botId, change.name) : null;
      const staged = stageSkillWrite(botId, {
        action: change.action,
        targetName: change.action === "update" ? change.name : undefined,
        files: [{ path: "SKILL.md", content: change.skillMd }],
        gist: change.gist || undefined,
        source: REVIEW_SKILL_SOURCE,
      });
      return "error" in staged ? staged : { ...staged, before };
    },

    applied(botId: string, threadId: string, change: ReviewChange, before: string | null): void {
      skillCurator.written(botId, change.name);
      appendSkillJournal({ botId, name: change.name, kind: change.action === "create" ? "created" : "updated", actor: "review", threadId,
        before, after: change.skillMd });
    },

    undone(botId: string, threadId: string, request: { name: string; action: "create" | "update"; preview?: string; previous?: { preview: string } }): void {
      appendSkillJournal({ botId, name: request.name, kind: "undone", actor: "person", threadId,
        before: request.preview ?? null, after: request.action === "update" ? request.previous?.preview ?? null : null });
    },

    start(): void {
      setTimeout(curate, 60_000).unref();
      setInterval(curate, 6 * 60 * 60_000).unref();
    },

    curate,
  };
}
