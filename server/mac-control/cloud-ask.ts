// With "Ask before each command" on (the Mac's own choice), a dusk cloud's bot asks before each command, download,
// file change or open on the person's Mac, at every approval level, Full access included. Pending asks live in
// memory; a card a previous run left open is closed at startup.
import { posix } from "node:path";

import { newId } from "../contracts.ts";
import { optionCardsForTools } from "../message-db.ts";
import { buildNotification, type Notification } from "../notify.ts";
import type { BotRecord, Store } from "../store.ts";
import { serverLine, type ServerLineKey } from "../server-lines.ts";
import { turnWaitedOnPerson } from "../waiting-on-person.ts";
import { EVERY_ACTION, OUTSIDE_REASON } from "../../electron/cloud-mac-risk.mjs";
import { CLOUD_MAC_SCREEN_JOB, CLOUD_MAC_TOOL_NAMES, type CloudMacToolName } from "../../shared/cloud-mac.ts";

type AskTool = CloudMacToolName | typeof CLOUD_MAC_SCREEN_JOB;

export interface MacAskBus {
  store: Store;
  notify?: (notification: Notification | null) => void;
  /** The owner's language for the card; English when not given. */
  language?(): string | undefined;
}

/** allow-task: allowed, and the rest of this task's asks for outside content are too. */
export type MacAskAnswer = "allow" | "allow-task" | "deny" | "ended";

export const MAC_DENIED_TEXT = "The person said no to this on their Mac. It did not run. Do not ask again in chat; carry on without it or ask what they would like instead.";
export const MAC_ASK_ENDED_TEXT = "The request ended before the person answered. It did not run.";
export const MAC_ASK_WAIT_MS = 15 * 60_000;
export const DEFAULT_MAC_FOLDER = "~";
const KEY_MAX = 300;
const PLAIN_COMMAND = /^[A-Za-z0-9_@%+=:,./~-]+(?: [A-Za-z0-9_@%+=:,./~-]+)*$/;

const text = (value: unknown) => String(value ?? "").trim();
const keyed = (key: string) => (key.length <= KEY_MAX ? key : undefined);

/** What the card says (in `language`), with why it asks, and the narrow grant "Always allow" saves. `reason` is the
 * rule that matched (electron/cloud-mac-risk.mjs), or EVERY_ACTION under "Ask before every action". */
export function macAsk(tool: AskTool, args: Record<string, unknown>, name: string, reason: string, language?: string): { title: string; subtitle: string; allowKey?: string } | null {
  const line = (key: ServerLineKey, params: Record<string, string>) => serverLine(language, key, params);
  const why = reason === EVERY_ACTION ? line("server.cloudMac.why.every", {}) : line("server.cloudMac.why", { reason });
  const ask = what(tool, args, name, line);
  return ask ? { ...ask, subtitle: `${ask.subtitle}\n${why}` } : null;
}



function what(tool: AskTool, args: Record<string, unknown>, name: string, line: (key: ServerLineKey, params: Record<string, string>) => string): { title: string; subtitle: string; allowKey?: string } | null {
  switch (tool) {
    case "mac_read_file":
    case "mac_list":
    case "mac_send_file":
      return { title: line("server.cloudMac.title.read", { name }), subtitle: text(args.path) || "~", allowKey: keyed(`${tool}:${text(args.path)}`) };
    case "mac_exec": {
      const command = text(args.command).replace(/\s+/g, " ");
      const folder = text(args.cwd) || DEFAULT_MAC_FOLDER;
      return { title: line("server.cloudMac.title.exec", { name }), subtitle: line("server.cloudMac.where.exec", { command: text(args.command), folder }),
        ...(PLAIN_COMMAND.test(command) ? { allowKey: keyed(`mac_exec:${folder}:${command}`) } : {}) };
    }
    case "mac_download": {
      let host = "";
      try { host = new URL(text(args.url)).host; } catch { /* the Mac refuses it */ }
      return { title: line("server.cloudMac.title.download", { name }), subtitle: line("server.cloudMac.where.download", { url: text(args.url), folder: text(args.to) || "~/Downloads" }),
        ...(host ? { allowKey: keyed(`mac_download:${host}`) } : {}) };
    }
    case "mac_write_file":
      return { title: line("server.cloudMac.title.write", { name }),
        subtitle: args.append === true ? line("server.cloudMac.where.append", { path: text(args.path) }) : text(args.path),
        allowKey: keyed(`mac_write_file:${posix.dirname(text(args.path))}`) };
    case "mac_open":
      return { title: line("server.cloudMac.title.open", { name }),
        subtitle: text(args.app) ? line("server.cloudMac.where.openWith", { target: text(args.target), app: text(args.app) }) : text(args.target),
        allowKey: keyed(`mac_open:${text(args.app)}:${text(args.target)}`) };
    case "mac_screen": {
      const call = (args.arguments ?? {}) as Record<string, unknown>;
      const shown = ["text", "key", "keys", "app", "url", "urls"].filter((key) => call[key] !== undefined).map((key) => `${key}: ${typeof call[key] === "string" ? call[key] : JSON.stringify(call[key])}`);
      return { title: line("server.cloudMac.title.screen", { name }), subtitle: [text(args.name), ...shown].join("\n").slice(0, 600), allowKey: keyed(`mac_screen:${text(args.name)}`) };
    }
    default:
      return null;
  }
}

interface Pending {
  threadId: string;
  generation: string;
  messageId: string;
  botId: string;
  store: Store;
  resolve(answer: MacAskAnswer): void;
}

const pending = new Map<string, Pending>();

function settle(entry: Pending, answer: "allow" | "deny", source: "user" | "system"): void {
  const card = entry.store.messagesFor(entry.threadId).find((message) => message.id === entry.messageId)?.card;
  if (card && !card.answered) entry.store.patchMessage(entry.threadId, entry.messageId, { card: { ...card, answered: answer, dismissed: source !== "user" } });
  const task = entry.store.projectBotForTask(entry.botId, entry.threadId);
  if (turnWaitedOnPerson(task)) entry.store.setTaskActivity(task.id, entry.threadId, "working");
}

/** "allow" right away for a saved grant; otherwise one card and the person's answer. */
export function askToUseMac(
  bus: MacAskBus,
  bot: Pick<BotRecord, "id" | "name" | "color" | "avatarUrl" | "notifications" | "alwaysAllow">,
  owner: { threadId: string; generation: string },
  tool: AskTool,
  args: Record<string, unknown>,
  reason: string,
  waitMs = MAC_ASK_WAIT_MS,
): Promise<MacAskAnswer> {
  const ask = macAsk(tool, args, bot.name, reason, bus.language?.());
  if (!ask) return Promise.resolve("allow");
  if (ask.allowKey && bot.alwaysAllow?.includes(ask.allowKey)) return Promise.resolve("allow");
  const forTask = reason === OUTSIDE_REASON;
  const allowKey = forTask ? undefined : ask.allowKey;
  const { store } = bus;
  const room = store.groupByThread(owner.threadId);
  const requestId = newId();
  const { title } = ask;
  return new Promise<MacAskAnswer>((resolve) => {
    const message = store.appendMessage(owner.threadId, {
      role: "bot",
      kind: "options",
      ...(room ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
      card: {
        title,
        subtitle: ask.subtitle,
        options: allowKey ? ["Allow", "Deny", "Always allow"] : forTask ? ["Allow", "Deny", "Allow for this task"] : ["Allow", "Deny"],
        requestId,
        requestType: "permission",
        tool,
        ...(allowKey ? { allowKey } : {}),
        ...(forTask ? { allowTask: true } : {}),
        fixedOptions: true,
      },
    });
    const timer = setTimeout(() => {
      const entry = pending.get(requestId);
      if (!entry) return;
      pending.delete(requestId);
      settle(entry, "deny", "system");
      resolve("ended");
    }, waitMs);
    timer.unref?.();
    pending.set(requestId, { threadId: owner.threadId, generation: owner.generation, messageId: message.id, botId: bot.id, store,
      resolve: (answer) => { clearTimeout(timer); resolve(answer); } });
    const task = store.projectBotForTask(bot.id, owner.threadId);
    if (task?.busy) store.setTaskActivity(bot.id, owner.threadId, "waiting-on-you");
    bus.notify?.(buildNotification("approval", bot, owner.threadId, title, {
      avatarUrl: bot.avatarUrl, ...(room && !room.dm ? { group: { id: room.id, name: room.name } } : {}),
    }));
  });
}

/** True when it settled one of these asks; call before handing an answer to the engine. */
export function resolveMacAsk(requestId: string, behavior: string | undefined, forTask = false): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  pending.delete(requestId);
  const allowed = behavior === "allow";
  settle(entry, allowed ? "allow" : "deny", "user");
  entry.resolve(allowed ? (forTask ? "allow-task" : "allow") : "deny");
  return true;
}

/** Closes what a request left open: every ask in the thread, or only its own generation's. */
export function cancelMacAsks(threadId: string, generation?: string): void {
  for (const [requestId, entry] of pending) {
    if (entry.threadId !== threadId || (generation !== undefined && entry.generation !== generation)) continue;
    pending.delete(requestId);
    settle(entry, "deny", "system");
    entry.resolve("ended");
  }
}

export function dismissStaleMacCards(store: Store): number {
  let dismissed = 0;
  for (const { threadId, messageId } of optionCardsForTools([...CLOUD_MAC_TOOL_NAMES, CLOUD_MAC_SCREEN_JOB])) {
    const card = store.messagesFor(threadId).find((message) => message.id === messageId)?.card;
    if (!card?.requestId || card.answered || card.dismissed || pending.has(card.requestId)) continue;
    if (store.patchMessage(threadId, messageId, { card: { ...card, answered: "deny", dismissed: true } })) dismissed += 1;
  }
  return dismissed;
}
