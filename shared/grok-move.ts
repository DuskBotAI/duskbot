// The wire contract of "Move from Grok Bot" (docs/grok-bot-move.md), and the per-bot request that asks a Grok Bot for
// what only its cloud keeps. Security: no chat text and no export text is ever part of these types; the server reads
// both and the renderer sees names, descriptions, counts and pictures only.
import type { GrokImportErrorCode, GrokRoutineNote } from "./grok-import.ts";
import type { MausColor } from "./wire.ts";

export const GROK_MOVE_PATH = "/api/setup-import/grok/move";
export const GROK_MOVE_ROUTES = {
  /** GET → GrokDetection */
  detect: `${GROK_MOVE_PATH}/detect`,
  /** GET ?id=<roster id> → the bot's photo bytes (image/png, image/jpeg or image/webp) */
  photo: `${GROK_MOVE_PATH}/photo`,
  /** POST GrokMoveStartRequest → 202 GrokMoveProgress */
  start: `${GROK_MOVE_PATH}/start`,
  /** GET → GrokMoveProgress (the running move, else the last one); 404 when there has been none */
  progress: `${GROK_MOVE_PATH}/progress`,
  /** POST → GrokMoveProgress: the bot being moved finishes, the rest stay queued as stopped */
  stop: `${GROK_MOVE_PATH}/stop`,
  /** GET ?moveId= → GrokUndoPreview; POST GrokUndoRequest → GrokUndoResult */
  undo: `${GROK_MOVE_PATH}/undo`,
  /** GET → GrokWaitingList */
  waiting: `${GROK_MOVE_PATH}/waiting`,
  /** POST GrokRequestForBot → GrokRequestText (and the bot is marked as asked) */
  request: `${GROK_MOVE_PATH}/request`,
  /** POST GrokAcceptExportRequest → GrokAcceptExportResult */
  acceptExport: `${GROK_MOVE_PATH}/accept-export`,
} as const;

/** Where a moved bot came from, on its installed package: the same Grok Bot by any path is this one bot. */
export const GROK_ORIGIN_APP = "grok-bot";
/** InstalledPackageMetadata.origin: the bot this one is in the app it was moved from (Grok Bot: its roster id). The
 * same bot moved again, by any path, updates this one rather than making another. */
export interface PackageOrigin { app: typeof GROK_ORIGIN_APP; id: string }
/** The sidebar section moved bots land in. */
export const GROK_SECTION = "Grok Bot";
/** Grok Bot keeps at most this many recent chat entries per bot on the computer. */
export const GROK_CHAT_WINDOW = 200;

/** A slice of Grok Bot's cache that could not be used, and so what is missing: one item, never the whole move. */
export interface GrokSliceProblem {
  slice: "roster" | "chat" | "apps" | "photo";
  /** The bot it concerns, for chat and photo. */
  rosterId?: string;
  code: "newerFormat" | "tooLarge" | "unreadable";
  /** In plain words, English; the screen may show its own words for `code`. */
  message: string;
}

export interface GrokBotLook {
  color: MausColor;
  /** A pixel body id, the nearest to the mascot shape it had there. */
  body?: string;
  /** Served by GROK_MOVE_ROUTES.photo for this bot; absent when it had none or it could not be read. */
  photoUrl?: string;
}

/** One bot of the roster, as the preview shows it. No chat text. */
export interface GrokFoundBot {
  rosterId: string;
  name: string;
  /** `name`, told apart from another bot of the same name ("Nova (2)"). */
  label: string;
  /** One line, at most 200 characters, secrets redacted. */
  description: string;
  hasDescription: boolean;
  look: GrokBotLook;
  /** Removed or hidden from Grok Bot's sidebar: collapsed and unchecked in the preview. */
  removed: boolean;
  createdAt?: number;
  updatedAt?: number;
  chat: {
    /** User and bot messages and placeholder lines the recent chat would bring. */
    messages: number;
    /** Older messages stayed in Grok Bot (the window starts mid-history). */
    earlier: boolean;
    /** False when its chat slice could not be read (see problems). */
    readable: boolean;
  };
  /** Routines whose names appear in its chat (names only; their bodies are in Grok Bot's cloud). */
  routines: number;
  /** Connected apps this bot used in its recent chat (names only; their sign-ins stay in Grok Bot). */
  appsUsed: number;
  /** Moved before: the bot here. The preview unchecks it and offers "Update". */
  here?: { botId: string; name: string };
  /** Its export request was sent and is waiting, or arrived. */
  asked?: GrokWaitingState;
}

export interface GrokDetection {
  /** False where the server cannot see the person's home folder (not the desktop app): `reason` says why. */
  available: boolean;
  reason?: "notDesktop";
  /** Grok Bot's cache was found on this computer. */
  found: boolean;
  bots: GrokFoundBot[];
  /** Names of the apps connected in Grok Bot: to connect again here, never carried. */
  apps: string[];
  problems: GrokSliceProblem[];
  /** A move is running now: the screen shows its progress rather than a second preview. */
  running: boolean;
  /** Bots asked for the rest whose files have not arrived yet. */
  waiting: number;
}

export interface GrokMoveChoice {
  rosterId: string;
  /** The recent chat as one conversation. Default true. */
  chat?: boolean;
  /** The description as its starting instructions. Default true. */
  instructions?: boolean;
}

export interface GrokMoveStartRequest {
  bots: GrokMoveChoice[];
}

export type GrokMoveStep = "profile" | "picture" | "chat" | "routines";

export type GrokMoveFailure = "notFound" | "botLimit" | "unusable" | "failed";

/** What one bot brought, in counts. */
export interface GrokMovedCounts {
  messages: number;
  earlier: boolean;
  picture: boolean;
  instructions: boolean;
  routineNames: number;
  /** Names of connected apps this bot used in its recent chat, noted for reconnecting here. */
  appsUsed: number;
}

export interface GrokMoveBotProgress {
  rosterId: string;
  name: string;
  state: "queued" | "moving" | "done" | "failed" | "stopped";
  step?: GrokMoveStep;
  /** An existing bot was updated rather than a new one made. */
  update: boolean;
  botId?: string;
  error?: GrokMoveFailure;
  /** In plain words, English. */
  message?: string;
  moved?: GrokMovedCounts;
}

export interface GrokMoveProgress {
  moveId: string;
  state: "running" | "stopping" | "done" | "stopped" | "interrupted" | "undone";
  startedAt: number;
  finishedAt?: number;
  /** Bots finished (done or failed) of `total`. */
  done: number;
  total: number;
  bots: GrokMoveBotProgress[];
  /** Once finished: what did not come over, on purpose. */
  result?: GrokMoveResult;
}

export interface GrokMoveResult {
  moved: number;
  failed: number;
  /** Connected app names to connect again here (Apps page). */
  apps: string[];
  /** Bots whose earlier chat stayed in Grok Bot. */
  earlierChats: number;
  /** Always true: full instructions, memory, skills and routine bodies are in Grok Bot's cloud. */
  restInGrokBot: true;
}

export interface GrokUndoPreview {
  moveId: string;
  /** Bots this move made, and how many messages each has had since. */
  bots: Array<{ botId: string; name: string; newMessages: number }>;
  /** Bots it updated: only the conversation and notes it added go. */
  updated: Array<{ botId: string; name: string }>;
}

export interface GrokUndoRequest {
  moveId: string;
  /** The person saw the preview and agreed. */
  confirm: true;
}

export interface GrokUndoResult {
  removedBots: number;
  removedConversations: number;
  /** Bots that could not be removed now (a routine running, say), with why. */
  kept: Array<{ botId: string; name: string; message: string }>;
}

export type GrokExportProblemCode = GrokImportErrorCode | "otherBot" | "unreadable";

/** A file that came back and could not be used, in plain words. */
export interface GrokExportProblem {
  file: string;
  code: GrokExportProblemCode;
  message: string;
  /** For "credentials": the key names that were refused (never their values). */
  keys?: string[];
}

/** What a bot's own export brought, in counts and names. */
export interface GrokExportApplied {
  at: number;
  file: string;
  instructions: boolean;
  memories: number;
  facts: number;
  skills: number;
  /** All skills land off until reviewed. */
  skillsOff: number;
  /** Routines made, paused, with the schedule and zone they had. */
  routines: Array<{ name: string; wasOn: boolean }>;
  /** Routines the person sets themselves: an unknown zone, a schedule in words, or an event. */
  routinesToSet: GrokRoutineNote[];
  /** App names to connect again: never carried as servers. */
  apps: string[];
}

export interface GrokWaitingState {
  state: "waiting" | "arrived" | "problem";
  askedAt: number;
  /** The file Grok Bot is asked to save in Downloads. */
  file: string;
  applied?: GrokExportApplied;
  problem?: GrokExportProblem;
}

export interface GrokWaitingBot extends GrokWaitingState {
  rosterId: string;
  botId: string;
  name: string;
}

export interface GrokWaitingList {
  bots: GrokWaitingBot[];
  /** Bots still waiting: "Waiting for 3 bots". */
  waiting: number;
}

export interface GrokRequestForBot {
  rosterId: string;
}

export interface GrokRequestText {
  rosterId: string;
  /** Opens Grok Bot on that bot with `text` typed in an empty message box; it never sends. */
  url: string;
  /** The same request, to copy when the link is refused. */
  text: string;
  file: string;
}

export interface GrokAcceptExportRequest {
  /** A dropped or pasted export. At most GROK_EXPORT_MAX_CHARS. */
  text: string;
  /** The bot it is for; without it the export is matched by its name to a moved bot. */
  rosterId?: string;
  /** The dropped file's name, for problems. */
  file?: string;
}

export interface GrokAcceptExportResult {
  applied: GrokWaitingBot[];
  problems: GrokExportProblem[];
}

export const GROK_PROMPT_TEXT_MAX = 1000;
export const GROK_PROMPT_URL_MAX = 2048;
const ROSTER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NAME_MAX = 60;

export const isRosterId = (value: string): boolean => ROSTER_ID.test(value);

/** The tag a bot's file name carries: eight hex digits of the whole roster id (FNV-1a), so two ids that share a start
 * are never asked for the same file. */
export function grokShortId(rosterId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < rosterId.length; i += 1) hash = Math.imul(hash ^ rosterId.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

export function grokExportFileName(rosterId: string): string {
  return `grok-bot-export-${grokShortId(rosterId)}.md`;
}

/** A browser or app may number a second copy ("… (1).md") or keep .json or .txt. */
export function grokExportFilePattern(rosterId: string): RegExp {
  return new RegExp(`^grok-bot-export-${grokShortId(rosterId)}(?: ?\\(\\d{1,3}\\))?\\.(?:md|markdown|json|txt)$`, "i");
}

/** Printable ASCII only, without the characters Grok Bot's link parser refuses. */
function asciiName(name: string): string {
  const plain = name.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/[#\\"`]/g, "").replace(/\s+/g, " ").trim();
  return plain.slice(0, NAME_MAX).trim() || "there";
}

const SHAPE = `{"format":"grok-bot-export","version":1,"bots":[{"name":"","instructions":"","memories":[""],"user_facts":[""],`
  + `"skills":[{"name":"","description":"","instructions":""}],"routines":[{"name":"","instruction":"","schedule_cron":"",`
  + `"schedule_text":"","timezone":"","paused":false}],"apps":[{"name":""}]}]}`;

/** One line, printable ASCII, at most GROK_PROMPT_TEXT_MAX characters, asking the bot for the file parseGrokExport reads. */
export function grokExportRequest(bot: { rosterId: string; name: string }): string {
  const text = `Hi ${asciiName(bot.name)}. I am moving you to dusk bot and need a full copy of your setup. Change nothing. `
    + `Save one file named ${grokExportFileName(bot.rosterId)} in my Downloads folder holding one JSON block shaped like this: ${SHAPE} `
    + "with your full instructions word for word, every memory as written (one per string), every skill and routine in full, "
    + "each routine's 5-field cron and IANA time zone, and app names only. No passwords, tokens or keys; header names only. "
    + "If you cannot save files, reply with the block.";
  if (text.length > GROK_PROMPT_TEXT_MAX || /[^\x20-\x7e]|[#\\]/.test(text)) throw new Error("the request does not fit Grok Bot's limits");
  return text;
}

/** grokbot://app/v1/prompt for one bot, or null when its id or the URL breaks Grok Bot's rules (it would drop it). */
export function grokPromptUrl(rosterId: string, text: string): string | null {
  if (!isRosterId(rosterId) || !text.trim() || text.length > GROK_PROMPT_TEXT_MAX || /[\r\n]|[^\x20-\x7e]/.test(text)) return null;
  const url = `grokbot://app/v1/prompt?id=${rosterId}&text=${encodeURIComponent(text)}`;
  return url.length <= GROK_PROMPT_URL_MAX && /^[\x21-\x7e]+$/.test(url) && !/[#\\]/.test(url) ? url : null;
}
