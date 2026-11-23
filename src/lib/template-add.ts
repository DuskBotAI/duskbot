import type { Routine } from "@/lib/routines";
import { api, type Action, type Bot, type Group } from "@/state/store";

export interface AddedTemplate {
  bots: Bot[];
  groups?: Group[];
  routines?: Routine[];
  connections?: unknown[];
  presets?: unknown[];
  /** The first visible bot, selected unless the caller asked otherwise. */
  first?: Bot;
  /** A bot moved in from another app that is here already: nothing was added. */
  alreadyAdded?: boolean;
}

/** Adds a previewed template alongside everything already here, and selects its first bot unless `select` is false (an
 * import, where the person stays in the chat they are in). The server keeps the rules: new records only, skills off,
 * routines paused. */
export async function addTemplate(manifest: unknown, dispatch: (action: Action) => void, options: { select?: boolean } = {}): Promise<AddedTemplate> {
  // SAFETY: this endpoint is owned by the app and returns the imported records.
  const response = (await api("/api/teams/import?mode=add", { method: "POST", body: JSON.stringify(manifest) })) as AddedTemplate;
  if (response.alreadyAdded) return { bots: [], alreadyAdded: true };
  for (const bot of response.bots) dispatch({ type: "botAdded", bot });
  for (const group of response.groups ?? []) dispatch({ type: "groupPatched", group });
  for (const routine of response.routines ?? []) dispatch({ type: "routinePatched", routine });
  const first = response.bots.find((bot) => !bot.hidden);
  if (first) {
    if (options.select !== false) dispatch({ type: "select", id: first.id });
    void api(`/api/bots/${first.id}/intro`, { method: "POST", body: JSON.stringify({ origin: "import" }) }).catch(() => {});
  }
  return { ...response, ...(first ? { first } : {}) };
}
