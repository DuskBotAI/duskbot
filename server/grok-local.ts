// What the desktop app may read about Grok Bot on this computer. From the UI cache the Grok Bot app keeps, only these
// slices are opened: the roster (`roster.last-roster`), each bot's recent chat window (`transcript.replicas.<id>`) and
// the names of connected apps (`mcp.*`); beside the cache, only the bots' photos in `roster-avatars`; in Downloads, only
// the exports the Bots write (shared/grok-import.ts) and the notes another AI saved. Security: login material lives
// beside that cache (sand-secrets.json, cookies, Local Storage, sentry/, ~/.grokbot) and is never listed or opened, nor is
// any other slice; no path here is built from anything but the fixed names below and a folder's own listing, symlinks
// are refused, and every slice is checked for size and format version before it is used. Chat text never leaves the
// server through these readers' detection: only counts do.
//
// The cache's layout (Grok Bot desktop, recorded from a Windows install) and this reading of it adapt an MIT-licensed
// importer; see NOTICE.
import { rmSync } from "node:fs";
import { join } from "node:path";

import { GROK_EXPORT_FILE, GROK_EXPORT_MAX_CHARS, GrokImportError, parseGrokExport, type GrokBot, type GrokImportErrorCode } from "../shared/grok-import.ts";
import type { GrokSliceProblem } from "../shared/grok-move.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import type { SetupMachine } from "./setup-import.ts";

const USER_DATA_FOLDERS = [["Library", "Application Support", "Grok Bot"], ["AppData", "Roaming", "Grok Bot"], [".config", "Grok Bot"]];
const CACHE_FOLDER = "sand-client-persistence";
const PHOTO_FOLDER = "roster-avatars";
const SLICE_PREFIX = "sand.client.slice.account.";
const ROSTER_SLICE = "roster.last-roster";
const CHAT_SLICE = "transcript.replicas.";
const APPS_SLICE = "mcp.connect-logos";
/** The newest format each slice is read in; a newer one is skipped with a plain message. */
const KNOWN_VERSION: Record<"roster" | "chat" | "apps", number> = { roster: 4, chat: 1, apps: 1 };
const MAX_BYTES: Record<"roster" | "chat" | "apps", number> = { roster: 8 * 1024 * 1024, chat: 16 * 1024 * 1024, apps: 4 * 1024 * 1024 };
export const GROK_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const MAX_EXPORT_FILES = 20;
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
const MAX_LINE_CHARS = 32_000;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A slice's id from its file name: unpadded lowercase base32 of the id, plus `.blob`. */
function sliceId(fileName: string): string | null {
  if (!fileName.endsWith(".blob")) return null;
  const stem = fileName.slice(0, -".blob".length).toUpperCase();
  const bytes: number[] = [];
  let bits = 0, value = 0;
  for (const ch of stem) {
    const digit = BASE32.indexOf(ch);
    if (digit < 0) return null;
    value = ((value << 5) | digit) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/** The account id is URL-encoded, so a "." inside it cannot be mistaken for the separator. */
function sliceKind(id: string | null): string | null {
  if (!id?.startsWith(SLICE_PREFIX)) return null;
  const separator = id.indexOf(".", SLICE_PREFIX.length);
  if (separator < 0) return null;
  try {
    return decodeURIComponent(id.slice(separator + 1));
  } catch {
    return null;
  }
}

type SliceRead = { value: Record<string, unknown> } | { problem: GrokSliceProblem["code"] };

function readSlice(machine: SetupMachine, path: string, slice: keyof typeof KNOWN_VERSION): SliceRead {
  const stats = machine.fs.lstat(path);
  if (!stats?.isFile()) return { problem: "unreadable" };
  if (stats.size > MAX_BYTES[slice]) return { problem: "tooLarge" };
  const raw = machine.fs.read(path, MAX_BYTES[slice], false);
  if (!raw) return { problem: "unreadable" };
  try {
    const envelope = JSON.parse(raw.toString("utf8")) as { schemaVersion?: unknown; value?: unknown } | null;
    const version = envelope?.schemaVersion;
    if (typeof version === "number" && version > KNOWN_VERSION[slice]) return { problem: "newerFormat" };
    const value = envelope?.value;
    return value && typeof value === "object" && !Array.isArray(value) ? { value: value as Record<string, unknown> } : { problem: "unreadable" };
  } catch {
    return { problem: "unreadable" };
  }
}

const PROBLEM_WORDS: Record<GrokSliceProblem["slice"], Record<GrokSliceProblem["code"], string>> = {
  roster: {
    newerFormat: "Grok Bot keeps its bot list in a newer format than this version of dusk bot reads. Update dusk bot and look again.",
    tooLarge: "Grok Bot's bot list is larger than dusk bot reads.",
    unreadable: "Grok Bot's bot list could not be read.",
  },
  chat: {
    newerFormat: "This bot's recent chat is in a newer format than this version of dusk bot reads, so it stays in Grok Bot.",
    tooLarge: "This bot's recent chat is larger than dusk bot reads, so it stays in Grok Bot.",
    unreadable: "This bot's recent chat could not be read, so it stays in Grok Bot.",
  },
  apps: {
    newerFormat: "The list of apps connected in Grok Bot is in a newer format, so their names are not shown.",
    tooLarge: "The list of apps connected in Grok Bot is larger than dusk bot reads.",
    unreadable: "The list of apps connected in Grok Bot could not be read.",
  },
  photo: {
    newerFormat: "This bot's picture is in a format dusk bot does not read, so it gets its colour instead.",
    tooLarge: "This bot's picture is larger than dusk bot takes, so it gets its colour instead.",
    unreadable: "This bot's picture could not be read, so it gets its colour instead.",
  },
};

const problem = (slice: GrokSliceProblem["slice"], code: GrokSliceProblem["code"], rosterId?: string): GrokSliceProblem =>
  ({ slice, ...(rosterId ? { rosterId } : {}), code, message: PROBLEM_WORDS[slice][code] });

const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const oneLine = (value: string, max: number) => {
  let flat = "";
  for (const ch of redactSecretsInText(value)) {
    const code = ch.charCodeAt(0);
    flat += code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ? " " : ch;
  }
  flat = flat.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};
const rows = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row)) : [];

/** Grok Bot's folders on this computer: the cache and, beside it, the photos. Neither may be a link. */
function grokFolders(machine: SetupMachine): { cache: string; photos: string | null; listing: string[] } | null {
  for (const parts of USER_DATA_FOLDERS) {
    const root = join(machine.home, ...parts);
    const cache = join(root, CACHE_FOLDER);
    if (!machine.fs.lstat(cache)?.isDirectory()) continue;
    const listing = machine.fs.readdir(cache);
    if (!listing) continue;
    const photos = machine.fs.readdir(root)?.includes(PHOTO_FOLDER) && machine.fs.lstat(join(root, PHOTO_FOLDER))?.isDirectory() ? join(root, PHOTO_FOLDER) : null;
    return { cache, photos, listing };
  }
  return null;
}

export interface GrokRosterBot {
  rosterId: string;
  name: string;
  title: string;
  /** Redacted, whole. */
  description: string;
  shape: string;
  color: string;
  photoKey?: string;
  removed: boolean;
  createdAt?: number;
  updatedAt?: number;
}

/** What a line that is not text stood for in Grok Bot; `detail` is a file's name or an app and its tool. */
export interface GrokPlaceholder { kind: "question" | "email" | "card" | "file" | "app" | "voice"; detail?: string }

export interface GrokChatLine {
  role: "user" | "bot";
  /** Redacted; empty for a placeholder, whose words the move writes in the person's language. */
  text: string;
  at: number;
  placeholder?: GrokPlaceholder;
}

export interface GrokChatWindow {
  lines: GrokChatLine[];
  /** Older messages exist only in Grok Bot. */
  earlier: boolean;
  /** Routines named in its chat, by their id there; deleted ones left out. */
  routines: Array<{ name: string; on: boolean }>;
}

export interface GrokProfile {
  found: boolean;
  bots: GrokRosterBot[];
  apps: string[];
  problems: GrokSliceProblem[];
  /** The slice file of each bot's chat, by roster id: opened only when asked. */
  chatFiles: Map<string, string>;
  photos: string | null;
  photoNames: Set<string>;
}

const EMPTY_PROFILE = (): GrokProfile => ({ found: false, bots: [], apps: [], problems: [], chatFiles: new Map(), photos: null, photoNames: new Set() });
const ROSTER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PHOTO_KEY = /^[0-9a-f]{32}$/;

function rosterOf(value: Record<string, unknown>): GrokRosterBot[] {
  return rows(value.rows).flatMap((row) => {
    const rosterId = str(row.id).trim();
    const name = oneLine(str(row.name), 100);
    if (!ROSTER_ID.test(rosterId) || !name || row.isGroup === true) return [];
    const photo = row.avatarPhoto && typeof row.avatarPhoto === "object" ? row.avatarPhoto as Record<string, unknown> : null;
    const photoKey = photo?.kind === "file" && PHOTO_KEY.test(str(photo.key)) ? str(photo.key) : undefined;
    const createdAt = num(row.createdAt), updatedAt = num(row.updatedAt);
    return [{
      rosterId, name,
      title: oneLine(str(row.title), 200),
      description: redactSecretsInText(str(row.description).trim()).slice(0, 8_000),
      shape: str(row.avatarShape).trim().toLowerCase(),
      color: str(row.avatarColor).trim().toLowerCase(),
      ...(photoKey ? { photoKey } : {}),
      removed: row.isHiddenFromSidebar === true || row.isRemovedFromSidebar === true,
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    }];
  });
}

function appNames(value: Record<string, unknown>): string[] {
  const names = rows(value.logos).map((logo) => oneLine(str(logo.name), 80)).filter(Boolean);
  return [...new Map(names.map((name) => [name.toLowerCase(), name])).values()];
}

/** The roster, the connected apps' names and where each chat is; chat text is not opened here. */
export function readGrokProfile(machine: SetupMachine): GrokProfile {
  const folders = grokFolders(machine);
  if (!folders) return EMPTY_PROFILE();
  const profile: GrokProfile = { ...EMPTY_PROFILE(), found: true, photos: folders.photos };
  let rosterFile: string | null = null;
  let appsFile: string | null = null;
  for (const name of folders.listing) {
    const kind = sliceKind(sliceId(name));
    if (kind === ROSTER_SLICE) rosterFile ??= name;
    else if (kind === APPS_SLICE) appsFile ??= name;
    else if (kind?.startsWith(CHAT_SLICE) && ROSTER_ID.test(kind.slice(CHAT_SLICE.length))) profile.chatFiles.set(kind.slice(CHAT_SLICE.length), join(folders.cache, name));
  }
  if (rosterFile) {
    const read = readSlice(machine, join(folders.cache, rosterFile), "roster");
    if ("value" in read) profile.bots = rosterOf(read.value);
    else profile.problems.push(problem("roster", read.problem));
  } else profile.problems.push(problem("roster", "unreadable"));
  if (appsFile) {
    const read = readSlice(machine, join(folders.cache, appsFile), "apps");
    if ("value" in read) profile.apps = appNames(read.value);
    else profile.problems.push(problem("apps", read.problem));
  }
  if (folders.photos) for (const name of machine.fs.readdir(folders.photos) ?? []) if (PHOTO_KEY.test(name)) profile.photoNames.add(name);
  return profile;
}

const clipLine = (text: string) => (text.length <= MAX_LINE_CHARS ? text : `${text.slice(0, MAX_LINE_CHARS - 1).trimEnd()}…`);

function sendLine(entry: Record<string, unknown>, at: number): GrokChatLine | null {
  const message = entry.message && typeof entry.message === "object" ? entry.message as Record<string, unknown> : {};
  const type = str(message.type);
  if (type === "text") {
    const text = str(message.content).trim();
    return text ? { role: "bot", text: clipLine(redactSecretsInText(text)), at } : null;
  }
  if (type === "attachment") return { role: "bot", text: "", at, placeholder: fileHolder(message.file_name) };
  return { role: "bot", text: "", at, placeholder: { kind: type === "widget" ? "question" : type === "email-draft" ? "email" : "card" } };
}

function fileHolder(name: unknown): GrokPlaceholder {
  const detail = oneLine(str(name), 120);
  return { kind: "file", ...(detail ? { detail } : {}) };
}

function chatLine(entry: Record<string, unknown>): GrokChatLine | null {
  const at = num(entry.timestampMs) ?? 0;
  switch (str(entry.kind)) {
    case "message": {
      const text = str(entry.content).trim();
      if (!text) return null;
      return { role: entry.role === "user" ? "user" : "bot", text: clipLine(redactSecretsInText(text)), at };
    }
    case "send-message":
      return sendLine(entry, at);
    case "user-attachment":
      return { role: "user", text: "", at, placeholder: fileHolder(entry.file_name) };
    case "mcp-app": {
      const used = [oneLine(str(entry.serverName), 60), oneLine(str(entry.toolName), 60)].filter(Boolean).join(" · ");
      return { role: "bot", text: "", at, placeholder: { kind: "app", ...(used ? { detail: used } : {}) } };
    }
    case "voice-call":
      return { role: "bot", text: "", at, placeholder: { kind: "voice" } };
    default:
      return null;
  }
}

function routinesOf(entries: Array<Record<string, unknown>>): GrokChatWindow["routines"] {
  const byId = new Map<string, { name: string; on: boolean; gone: boolean }>();
  for (const entry of entries) {
    const event = entry.kind === "event" && entry.event && typeof entry.event === "object" ? entry.event as Record<string, unknown> : null;
    if (event?.type !== "automation-changed") continue;
    const id = str(event.automationId) || str(event.automationName);
    if (!id) continue;
    const held = byId.get(id) ?? { name: "", on: true, gone: false };
    const action = str(event.action);
    byId.set(id, {
      name: oneLine(str(event.automationName), 100) || held.name,
      on: action === "disabled" ? false : action === "enabled" || action === "created" ? true : held.on,
      gone: action === "deleted",
    });
  }
  return [...byId.values()].filter((routine) => routine.name && !routine.gone).map(({ name, on }) => ({ name, on }));
}

/** One bot's recent chat, normalised: user and bot text, one placeholder line for anything else shown there. */
export function readGrokChat(machine: SetupMachine, profile: GrokProfile, rosterId: string): GrokChatWindow | { problem: GrokSliceProblem } | null {
  const file = profile.chatFiles.get(rosterId);
  if (!file) return null;
  const read = readSlice(machine, file, "chat");
  if (!("value" in read)) return { problem: problem("chat", read.problem, rosterId) };
  const entries = rows(read.value.entries);
  const lines = entries.map(chatLine).filter((line): line is GrokChatLine => line !== null).sort((a, b) => a.at - b.at);
  const firstSeq = num(entries[0]?.seq);
  const earlier = num(read.value.precedingTimestampMs) !== undefined || (firstSeq !== undefined && firstSeq > 1);
  return { lines, earlier, routines: routinesOf(entries) };
}

const PHOTO_TYPES: Array<{ mime: "image/png" | "image/jpeg" | "image/webp"; test: (bytes: Buffer) => boolean }> = [
  { mime: "image/png", test: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", test: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { mime: "image/webp", test: (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP" },
];

/** A bot's photo, by the key its roster row names and only when that file is in the folder's listing. */
export function readGrokPhoto(machine: SetupMachine, profile: GrokProfile, bot: GrokRosterBot): { bytes: Buffer; mime: "image/png" | "image/jpeg" | "image/webp" } | { problem: GrokSliceProblem } | null {
  if (!bot.photoKey || !profile.photos || !profile.photoNames.has(bot.photoKey)) return null;
  const path = join(profile.photos, bot.photoKey);
  const stats = machine.fs.lstat(path);
  if (!stats?.isFile()) return { problem: problem("photo", "unreadable", bot.rosterId) };
  if (stats.size > GROK_PHOTO_MAX_BYTES) return { problem: problem("photo", "tooLarge", bot.rosterId) };
  const bytes = machine.fs.read(path, GROK_PHOTO_MAX_BYTES, false);
  if (!bytes) return { problem: problem("photo", "unreadable", bot.rosterId) };
  const type = PHOTO_TYPES.find((candidate) => candidate.test(bytes));
  return type ? { bytes, mime: type.mime } : { problem: problem("photo", "newerFormat", bot.rosterId) };
}

/** An export found in Downloads, parsed here: its text never leaves the server. */
export interface GrokExportFind {
  name: string;
  modifiedAt: number;
  /** Redacted, and only from a file that holds no credential-named key. */
  bots?: GrokBot[];
  refused?: { code: GrokImportErrorCode; keys: string[] };
}

export interface GrokLook {
  exports: GrokExportFind[];
  /** Live bots the Grok Bot app lists on this computer, each name once; empty when it is not here or could not be read. */
  bots: string[];
}

/** One export's text as bots, or why it was refused. */
export function parseExportText(text: string): Pick<GrokExportFind, "bots" | "refused"> {
  try {
    return { bots: parseGrokExport(text) };
  } catch (cause) {
    return cause instanceof GrokImportError ? { refused: { code: cause.code, keys: cause.keys } } : { refused: { code: "notExport", keys: [] } };
  }
}

/** A real file in Downloads named by `pattern`, at most `max` bytes: never a link, never a folder. */
export function readDownloadsFile(machine: SetupMachine, name: string, max: number): { text: string; modifiedAt: number } | { tooLarge: true; modifiedAt: number } | null {
  const path = join(machine.home, "Downloads", name);
  const stats = machine.fs.lstat(path);
  if (!stats?.isFile()) return null;
  if (stats.size > max) return { tooLarge: true, modifiedAt: stats.mtimeMs };
  const raw = machine.fs.read(path, max, false);
  return raw ? { text: raw.toString("utf8"), modifiedAt: stats.mtimeMs } : null;
}

export function downloadsListing(machine: SetupMachine): string[] {
  return machine.fs.readdir(join(machine.home, "Downloads")) ?? [];
}

/** The exports in Downloads, newest first, parsed and refused here. One over the size limit is named as too large. */
function readExportFiles(machine: SetupMachine): GrokExportFind[] {
  let budget = MAX_EXPORT_BYTES;
  return downloadsListing(machine).filter((name) => GROK_EXPORT_FILE.test(name)).flatMap((name) => {
    const stats = machine.fs.lstat(join(machine.home, "Downloads", name));
    return stats?.isFile() ? [{ name, modifiedAt: stats.mtimeMs, size: stats.size }] : [];
  }).sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, MAX_EXPORT_FILES).flatMap(({ name, modifiedAt, size }): GrokExportFind[] => {
    if (size > GROK_EXPORT_MAX_CHARS) return [{ name, modifiedAt, refused: { code: "tooLarge", keys: [] } }];
    if (size > budget) return [];
    const read = readDownloadsFile(machine, name, GROK_EXPORT_MAX_CHARS);
    if (!read || "tooLarge" in read) return [];
    budget -= size;
    return [{ name, modifiedAt, ...parseExportText(read.text) }];
  });
}

/** `downloads: false` leaves Downloads unopened, so macOS asks nothing (the first run looks for Grok Bot's roster only). */
export function lookForGrokBot(machine: SetupMachine, options: { downloads?: boolean } = {}): GrokLook {
  const live = readGrokProfile(machine).bots.filter((bot) => !bot.removed);
  const names = [...new Map(live.map((bot) => [bot.name.toLowerCase(), bot.name])).values()];
  return { exports: options.downloads === false ? [] : readExportFiles(machine), bots: names };
}

export interface GrokFoundFile { name: string; modifiedAt: number; text: string }

/** The notes another AI saved for dusk bot (NOTES_PROMPT asks for dusk-bot-notes.md in Downloads, an earlier prompt for
 * .json; a browser numbers a second copy "dusk-bot-notes (1).md", and an app that can only save text may add .txt).
 * Only real files of that name, changed after `since`, at most NOTES_FILE_MAX bytes each; nothing else in Downloads is
 * opened. */
export const NOTES_FILE = /^dusk-bot-notes[^/\\]{0,40}\.(?:md|markdown|json|txt)$/i;
export const NOTES_FILE_MAX = 2 * 1024 * 1024;
const MAX_NOTES_FILES = 10;

export function lookForNotes(machine: SetupMachine, since: number): GrokFoundFile[] {
  const folder = join(machine.home, "Downloads");
  const found = (machine.fs.readdir(folder) ?? []).filter((name) => NOTES_FILE.test(name)).flatMap((name) => {
    const stats = machine.fs.lstat(join(folder, name));
    return stats?.isFile() && stats.size <= NOTES_FILE_MAX && stats.mtimeMs > since ? [{ name, modifiedAt: stats.mtimeMs }] : [];
  }).sort((a, b) => a.modifiedAt - b.modifiedAt).slice(0, MAX_NOTES_FILES);
  return found.flatMap(({ name, modifiedAt }) => {
    const raw = machine.fs.read(join(folder, name), NOTES_FILE_MAX, false);
    return raw ? [{ name, modifiedAt, text: raw.toString("utf8") }] : [];
  });
}

/** Security: a Cursor sign-in saved by an older version may still be here. Nothing reads it, so no live token stays behind. */
export function removeOldCursorSignIn(dataDir: string): void {
  try {
    rmSync(join(dataDir, "cursor-session.json"), { force: true });
  } catch {
    // retried at the next start
  }
}
