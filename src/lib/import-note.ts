// After something came in from other apps, the first bot says so in its chat, briefly (shared/import-note.ts).
import { api } from "@/state/store";
import type { ImportNoteFacts } from "../../shared/import-note";
import type { NotesOutcome } from "./assistant-notes";

/** Never throws: the note is a courtesy, what came in is already in. */
export async function postImportNote(botId: string, facts: ImportNoteFacts): Promise<void> {
  try {
    await api(`/api/bots/${encodeURIComponent(botId)}/import-note`, { method: "POST", body: JSON.stringify(facts), timeoutMs: 10_000 });
  } catch {}
}

export function notesNoteFacts(outcome: NotesOutcome): ImportNoteFacts {
  return {
    from: [outcome.from], bots: outcome.botNames ?? [], joined: outcome.joined ?? 0, facts: outcome.facts, aboutInMemory: outcome.aboutInMemory ?? 0, memories: outcome.memories, threads: outcome.threads ?? 0,
    routines: outcome.routines ?? 0, skills: outcome.skills ?? 0, failed: outcome.failed.length > 0 || Boolean(outcome.lost?.length), partial: outcome.partial,
  };
}
