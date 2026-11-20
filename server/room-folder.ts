import { basename } from "node:path";

import { pickedFolderLost, rebaseOwnFolder, settleFolder } from "./own-folders.ts";

/** A room keeps the folder it started in, so a pinned own folder from another data dir is re-pinned here, and a picked
 * folder that is gone gives way to the member's own folder (`fallback`) once: the room is re-pinned to no folder. */
export function roomTurnFolder(cwd: string | undefined, opts: { dataDir: string; isBot: (id: string) => boolean; fallback: string | undefined;
  repin: (cwd: string | null) => void }): { cwd: string | undefined; lost?: string } {
  if (!cwd) return { cwd };
  const settled = settleFolder(cwd, opts.dataDir, opts.isBot, opts.fallback);
  if (settled.cwd === cwd && !rebaseOwnFolder(cwd, opts.dataDir, opts.isBot) && pickedFolderLost(cwd, opts.dataDir)) {
    throw new Error(`This room's folder ${basename(cwd) || cwd} was moved or deleted. Pick a folder in the room's settings.`);
  }
  if (settled.changed) opts.repin(settled.lost ? null : settled.cwd);
  return settled.lost ? { cwd: settled.cwd, lost: settled.lost } : { cwd: settled.cwd };
}
