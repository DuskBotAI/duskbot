// The real store, routines, skills, memory and package path over a throwaway home holding a synthetic Grok Bot profile,
// with a GrokMover wired as server/index.ts wires it. For the move's tests only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

import type { GrokMover } from "../grok-bot-move.ts";
import type { SetupMachine } from "../setup-import.ts";
import { plantGrokProfile } from "./grok-bot-profile.ts";

let root: string | null = null;

/** The store's last debounced writes can land in a test's home after it is removed, so every home sits under one
 * folder that goes once the suite has settled. */
export async function removeGrokMoveFixtures(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
}

export async function grokMoveFixture(options: { plant?: boolean } = {}) {
  root ??= mkdtempSync(join(tmpdir(), "dusk-grok-direct-"));
  const home = mkdtempSync(join(root, "home-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const never = options.plant === false ? [] : plantGrokProfile(home);
  const { Store } = await import("../store.ts");
  const { RoutineManager } = await import("../routines.ts");
  const skills = await import("../skills.ts");
  const workspace = await import("../workspace.ts");
  const importer = await import("../package-import.ts");
  const { GrokMover: Mover } = await import("../grok-bot-move.ts");
  const { thisMachine } = await import("../setup-import.ts");
  const store = new Store(() => ({ instanceId: "claude", model: "default-model" }));
  const routines = new RoutineManager({
    file: join(home, "routines.json"),
    botState: (id) => (store.bot(id) && !store.bot(id)!.hidden ? "ready" : "missing"),
    goalState: () => "missing",
    createTask: () => null,
    startTurn: async () => {},
  });
  const opened: string[] = [];
  const real = thisMachine();
  const machine = (): SetupMachine => ({ ...real, home, platform: "darwin", env: {}, fs: { ...real.fs, read: (path, ...rest) => {
    opened.push(path);
    return real.fs.read(path, ...rest);
  } } });
  const soulChanges: Array<{ botId: string; before: string; after: string }> = [];
  const deps = {
    store, routines,
    skills: { install: skills.installSkill, setEnabled: skills.setSkillEnabled },
    memory: { writeIndex: workspace.writeMemoryFile, writeTopic: workspace.writeMemoryTopic },
    mcp: { servers: () => ({}), refusal: () => undefined, persist: () => {} },
    images: { save: () => "" },
    defaultSelection: () => ({ instanceId: "claude", model: "default-model" }),
  };
  let avatars = 0;
  const create = (): GrokMover => new Mover({
    machine, store,
    importPackage: async (document) => {
      const result = importer.importPackageDocument(document, { trust: "file", mode: "add" }, deps);
      if (result.alreadyAdded) throw new Error("already added");
      return result;
    },
    routines,
    skills: { install: skills.installSkill, setEnabled: skills.setSkillEnabled },
    memory: { writeTopic: workspace.writeMemoryTopic, readTopic: workspace.readMemoryTopic },
    saveAvatar: () => `/api/attachments/avatar-${++avatars}.png`,
    deleteBot: async (botId) => {
      routines.removeForBot(botId);
      return store.deleteBot(botId) ? { status: 200, body: {} } : { status: 404, body: { error: "no such bot" } };
    },
    recordSoulChange: (botId, before, after) => soulChanges.push({ botId, before, after }),
    timeZone: () => "Europe/Lisbon",
    log: () => {},
    watchEveryMs: 60_000,
  });
  const mover = create();
  return {
    home, never, opened, store, routines, skills, workspace, mover, create, soulChanges,
    async close() {
      mover.close();
      const { closeMessageDb } = await import("../message-db.ts");
      closeMessageDb();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
