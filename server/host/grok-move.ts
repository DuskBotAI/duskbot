import { botAvatarUrlFromStoredPath } from "../../shared/bot-avatar.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import { saveImage } from "../attachments.ts";
import { GrokMover } from "../grok-bot-move.ts";
import { importPackageDocument, type PackageImportDeps } from "../package-import.ts";
import { recordProfileChange } from "../profile-versions.ts";
import { createGrokMoveRoutes } from "../routes/grok-move.ts";
import type { RouteHandler } from "../routes/table.ts";
import type { RoutineManager } from "../routines.ts";
import { thisMachine } from "../setup-import.ts";
import { installSkill, setSkillEnabled } from "../skills.ts";
import type { Store } from "../store.ts";
import { readMemoryTopic, writeMemoryTopic } from "../workspace.ts";

export interface GrokMoveHostDeps {
  /** The desktop app's own server, and not a Cloud home. */
  local: boolean;
  store: Store;
  routines: () => RoutineManager;
  packageImportDeps(selection: ModelSelection): PackageImportDeps;
  defaultSelection(): Promise<ModelSelection>;
  deleteBot(botId: string): Promise<{ status: number; body: { error?: string } }>;
  timeZone(): string;
  language(): string | undefined;
}

/** "Move from Grok Bot"'s routes, with the mover made the first time one is asked. */
export function grokMoveRoutes(deps: GrokMoveHostDeps): RouteHandler {
  let mover: GrokMover | null = null;
  return createGrokMoveRoutes({
    local: deps.local,
    mover: () => mover ??= new GrokMover({
      machine: thisMachine,
      store: deps.store,
      importPackage: async (document) => {
        const result = importPackageDocument(document, { trust: "file", mode: "add" }, deps.packageImportDeps(await deps.defaultSelection()));
        if (result.alreadyAdded) throw new Error("already added");
        return result;
      },
      routines: { create: (input) => deps.routines().create(input), listRoutines: () => deps.routines().listRoutines() },
      skills: { install: installSkill, setEnabled: setSkillEnabled },
      memory: { writeTopic: writeMemoryTopic, readTopic: readMemoryTopic },
      saveAvatar: (bytes, mime) => {
        const avatarUrl = botAvatarUrlFromStoredPath(saveImage(bytes, mime).path);
        if (!avatarUrl) throw new Error("the picture could not be stored");
        return avatarUrl;
      },
      deleteBot: deps.deleteBot,
      recordSoulChange: (botId, before, after) => recordProfileChange(botId, "import", "grok-bot", { soul: before }, { soul: after }),
      timeZone: deps.timeZone,
      language: deps.language,
    }),
  });
}
