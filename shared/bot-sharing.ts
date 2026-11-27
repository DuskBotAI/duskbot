import { levelRank, type BotAccess } from "./bot-access.ts";

/** Sharing a bot with other people (who can use it, a preset file for others to add) is off for now. Flip to true to bring it back. */
export const BOT_SHARING_ENABLED = false;

export const BOT_SHARING_OFF_ERROR = "Sharing bots is turned off for now. Nothing was changed.";

/** Whether `next` lets anyone do more with the bot than `before` did; taking access away never counts. */
export function widensAccess(before: BotAccess, next: BotAccess): boolean {
  if (levelRank(next.everyone) > levelRank(before.everyone)) return true;
  return Object.entries(next.people).some(([entry, level]) => levelRank(level) > levelRank(before.people[entry]));
}
