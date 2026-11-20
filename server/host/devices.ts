// The person's own devices behind the one device MCP server: their paired phones (server/host/phones.ts) and their Mac
// (server/mac-control/host.ts). Same shape as the phones alone, so a turn mounts, prompts and answers both through it.
import { mkdir, open } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { PhoneBot, PhonePlace } from "../phones/access.ts";
import { PHONE_INSTRUCTIONS } from "../phones/instructions.ts";
import { botFile, computerFile } from "../mac-control/files.ts";
import { createMacControl, type MacControl, type MacControlDeps } from "../mac-control/host.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { BotRecord } from "../store.ts";
import { PASS } from "../routes/table.ts";
import type { PromptPart } from "../system-prompt.ts";
import type { Phones } from "./phones.ts";

type Turn = { botId: string; threadId: string; generation: string };

export interface DevicesDeps extends Pick<MacControlDeps, "dataDir" | "offered" | "enabled" | "setEnabled" | "ownerOrAdmin" | "active" | "log" | "cloud"> {
  phones: Phones;
  sessions: Pick<SessionRegistry, "isLive">;
  bot(id: string): BotRecord | null | undefined;
  fileRoots(botId: string, threadId: string): string[];
  attachmentsDir: string;
  attachmentInThread(threadId: string, path: string): boolean;
  /** The bot's own files folder, where a file sent from the Mac is kept. */
  ownFolder(botId: string): string;
  /** Where the bot's cloud computer runs: the docker arguments that reach it and its container. */
  computer(bot: BotRecord): { dockerArgs(args: string[]): string[]; container: string } | null;
  run(args: string[], timeoutMs: number): Promise<{ stdout: string }>;
}

/** The phones with the owner's Mac beside them, wired from server/index.ts. */
export function createDevices(deps: DevicesDeps): Devices {
  const mac = createMacControl({
    ...deps, bot: deps.bot, turnOwner: deps.phones.turnOwner,
    live: (auth) => auth.kind !== "session" || deps.sessions.isLive(auth.session.id),
    openFile: (turn, source) => botFile({ roots: deps.fileRoots(turn.botId, turn.threadId), attachmentsDir: deps.attachmentsDir, attachmentInThread: (path) => deps.attachmentInThread(turn.threadId, path) }, source),
    computerFile: (botId, source) => {
      const bot = deps.bot(botId);
      const place = bot ? deps.computer(bot) : null;
      if (!place) return Promise.reject(new Error("this bot has no cloud computer"));
      return computerFile((args) => deps.run(place.dockerArgs(args), 90_000), place.container, source);
    },
    saveFile: (turn, name, bytes) => keepFromMac(join(deps.ownFolder(turn.botId), FROM_MAC), name, bytes),
  });
  return withMacControl(deps.phones, mac, deps.bot);
}

const FROM_MAC = "from-mac";

/** Writes the file under a name of its own in `folder`, never over another; the path it got. */
export async function keepFromMac(folder: string, name: string, bytes: Buffer): Promise<string> {
  const clean = [...basename(name)].map((char) => (char < " " || "/\\:".includes(char) ? "_" : char)).join("").replace(/^\.+/, "").slice(0, 200) || "file";
  const ext = extname(clean), stem = clean.slice(0, clean.length - ext.length) || "file";
  await mkdir(folder, { recursive: true, mode: 0o700 });
  for (let n = 1; n < 1000; n++) {
    const file = join(folder, n === 1 ? clean : `${stem} (${n})${ext}`);
    const handle = await open(file, "wx", 0o600).catch((error: NodeJS.ErrnoException) => { if (error.code === "EEXIST") return null; throw error; });
    if (!handle) continue;
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    return file;
  }
  throw new Error("too many files with that name");
}

export type Devices = Omit<Phones, "handle"> & { handle(body: unknown, capability: Turn, assertActive: () => void): Promise<unknown> };

export function withMacControl(phones: Phones, mac: MacControl, botById: (id: string) => BotRecord | null | undefined): Devices {
  return {
    ...phones,
    integration(bot: BotRecord, turn: { threadId: string; generation: string }) {
      return phones.integration(bot, turn) ?? (mac.mounts(bot, { botId: bot.id, ...turn }) ? phones.deviceMount(bot, turn) : null);
    },
    promptParts(bot: PhoneBot & { macControl?: boolean }, input: { mounted: boolean; offered: boolean; turn: Turn; place: PhonePlace }): PromptPart[] {
      const phoneParts = phones.promptParts(bot, { ...input, mounted: input.mounted && phones.mounts(bot, input.turn) });
      return [...phoneParts, input.mounted ? mac.promptPart(bot, input.turn) : input.offered ? mac.unlinkedPart(bot, input.turn) : { id: "mac", label: "Your Mac", text: "" }];
    },
    previewParts(bot: PhoneBot & { macControl?: boolean }, offered: boolean): PromptPart[] {
      return [...phones.previewParts(bot, offered), ...(offered ? [mac.previewPart(bot)] : [])];
    },
    async handle(body: unknown, capability: Turn, assertActive: () => void) {
      const request = (body ?? {}) as { method?: unknown; params?: unknown };
      if (request.method === "tools/list") {
        assertActive();
        const live = botById(capability.botId);
        const phone = live && phones.mounts(live, capability) ? await phones.handle(body, capability, assertActive) as { tools: unknown[] } : { tools: [] };
        await mac.screenReady();
        const macTools = mac.tools(capability);
        return { tools: [...phone.tools, ...macTools], instructions: [phone.tools.length ? PHONE_INSTRUCTIONS : "", macTools.length ? mac.instructions() : ""].filter(Boolean).join(" ") };
      }
      if (request.method === "tools/call" && mac.handles((request.params as { name?: unknown } | undefined)?.name)) {
        return mac.call(request.params, capability, assertActive);
      }
      return phones.handle(body, capability, assertActive);
    },
    routes: async (ctx) => {
      return await mac.routes(ctx) === PASS ? phones.routes(ctx) : undefined;
    },
    close() {
      mac.close();
      phones.close();
    },
  };
}
