import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { lookForGrokBot, lookForNotes, NOTES_FILE_MAX, readGrokChat, readGrokPhoto, readGrokProfile, removeOldCursorSignIn } from "./grok-local.ts";
import { GROK_EXPORT_MAX_CHARS } from "../shared/grok-import.ts";
import { GROK_CACHE, plantGrokProfile, sliceFile, SYNTHETIC_BOTS } from "./testing/grok-bot-profile.ts";
import { thisMachine, type SetupFs, type SetupMachine } from "./setup-import.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), "dusk-grok-home-"));
  homes.push(home);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text);
    return join(home, path);
  };
  return { home, put };
}

/** Records every file opened, for the pin that nothing else in Grok Bot's folders ever is. */
function machineAt(home: string, platform: NodeJS.Platform = "darwin"): SetupMachine & { opened: string[] } {
  const real = thisMachine();
  const opened: string[] = [];
  const fs: SetupFs = { ...real.fs, read: (path, ...rest) => {
    opened.push(path);
    return real.fs.read(path, ...rest);
  } };
  return { ...real, home, platform, env: {}, fs, opened };
}

const base32 = (text: string) => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, value = 0, out = "";
  for (const byte of Buffer.from(text)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return bits ? out + alphabet[(value << (5 - bits)) & 31] : out;
};
const CACHE = "Library/Application Support/Grok Bot/sand-client-persistence";
const slice = (kind: string) => `${CACHE}/${base32(`sand.client.slice.account.user%2E1.${kind}`)}.blob`;
const SECRET = "the-secret-chat-text-and-login";

function appCache(put: (path: string, text: string) => string) {
  put(slice("roster.last-roster"), JSON.stringify({ schemaVersion: 1, value: { rows: [
    { id: "b1", name: "Drew" }, { id: "b2", name: "dr eggbot" }, { id: "g1", name: "A group", isGroup: true },
  ] } }));
  // What must never be opened: chats, other slices and login material.
  return [
    put(slice("transcript.replicas.b1"), JSON.stringify({ schemaVersion: 1, value: { entries: [{ event: { type: "message", text: SECRET } }] } })),
    put(slice("settings.tokens"), SECRET),
    put(`${CACHE}/sand-secrets.json`, SECRET),
    put(`${CACHE}/${base32("sand-secrets")}.blob`, SECRET),
    put(`${CACHE}/notes.blob`, SECRET),
    put("Library/Application Support/Grok Bot/sand-secrets.json", SECRET),
    put("Library/Application Support/Grok Bot/Cookies", SECRET),
    put("Library/Application Support/Grok Bot/Local Storage/leveldb/000.log", SECRET),
    put(".grokbot/daemon.json", SECRET),
  ];
}

describe("what the desktop app finds about Grok Bot", () => {
  it("reads only the roster slice, never a chat or login material", () => {
    const { home, put } = fixtureHome();
    const never = appCache(put);
    const machine = machineAt(home);
    const look = lookForGrokBot(machine);
    expect(look.bots).toEqual(["Drew", "dr eggbot"]);
    expect(JSON.stringify(look)).not.toContain(SECRET);
    expect(machine.opened).toEqual([join(home, slice("roster.last-roster"))]);
    for (const path of never) expect(machine.opened).not.toContain(path);
  });

  it("works without the app, and with an unreadable or foreign cache", () => {
    const empty = fixtureHome();
    expect(lookForGrokBot(machineAt(empty.home))).toEqual({ exports: [], bots: [] });
    const broken = fixtureHome();
    broken.put(slice("roster.last-roster"), "not json");
    expect(lookForGrokBot(machineAt(broken.home))).toEqual({ exports: [], bots: [] });
    const foreign = fixtureHome();
    foreign.put(slice("roster.last-roster"), JSON.stringify({ value: { rows: "nope" } }));
    expect(lookForGrokBot(machineAt(foreign.home)).bots).toEqual([]);
  });

  it("finds only grok-bot-export files in Downloads, real files only, newest first", () => {
    const { home, put } = fixtureHome();
    const older = put("Downloads/grok-bot-export-drew.json", "older");
    put("Downloads/grok-bot-export (1).md", "newest");
    utimesSync(older, new Date(1_000), new Date(1_000));
    const other = put("Downloads/bank-statement.json", SECRET);
    const elsewhere = put("Documents/grok-bot-export-x.json", SECRET);
    const target = put("private.txt", SECRET);
    symlinkSync(target, join(home, "Downloads", "grok-bot-export-link.json"));
    put("Downloads/grok-bot-export-binary.exe", SECRET);
    const machine = machineAt(home);
    const look = lookForGrokBot(machine);
    expect(look.exports.map((file) => file.name)).toEqual(["grok-bot-export (1).md", "grok-bot-export-drew.json"]);
    expect(look.exports.map((file) => file.refused?.code)).toEqual(["notExport", "notExport"]);
    expect(JSON.stringify(look)).not.toContain("newest");
    for (const path of [other, elsewhere, target]) expect(machine.opened).not.toContain(path);
  });

  it("deletes an old Cursor sign-in, and minds nothing when there is none", () => {
    const { home, put } = fixtureHome();
    const token = put("data/cursor-session.json", SECRET);
    const kept = put("data/config.json", "{}");
    removeOldCursorSignIn(join(home, "data"));
    expect(existsSync(token)).toBe(false);
    expect(existsSync(kept)).toBe(true);
    expect(() => removeOldCursorSignIn(join(home, "data"))).not.toThrow();
  });
});

describe("notes another AI saved to Downloads", () => {
  it("reads only dusk-bot-notes*.json saved after the prompt was copied, small, real files, oldest first", () => {
    const { home, put } = fixtureHome();
    const copiedAt = Date.now() - 60_000;
    const at = (path: string, ms: number) => utimesSync(join(home, path), ms / 1000, ms / 1000);
    put("Downloads/dusk-bot-notes.json", '{"format":"dusk-bot-notes","from":"ChatGPT"}');
    at("Downloads/dusk-bot-notes.json", copiedAt + 20_000);
    put("Downloads/dusk-bot-notes (1).json", '{"format":"dusk-bot-notes","from":"Claude"}');
    at("Downloads/dusk-bot-notes (1).json", copiedAt + 10_000);
    put("Downloads/dusk-bot-notes-old.json", "{}");
    at("Downloads/dusk-bot-notes-old.json", copiedAt - 10_000);
    const big = put("Downloads/dusk-bot-notes-big.json", "x".repeat(NOTES_FILE_MAX + 1));
    const other = put("Downloads/bank-statement.json", "{}");
    const secret = put("secret.json", "{}");
    symlinkSync(secret, join(home, "Downloads", "dusk-bot-notes-link.json"));
    const machine = machineAt(home);
    expect(lookForNotes(machine, copiedAt).map((file) => file.name)).toEqual(["dusk-bot-notes (1).json", "dusk-bot-notes.json"]);
    for (const path of [big, other, secret]) expect(machine.opened).not.toContain(path);
  });

  it("is nothing without a Downloads folder, and the first run's Grok look can leave Downloads unopened", () => {
    const { home, put } = fixtureHome();
    expect(lookForNotes(machineAt(home), 1)).toEqual([]);
    const exported = put("Downloads/grok-bot-export-desk.json", "{}");
    const machine = machineAt(home);
    expect(lookForGrokBot(machine, { downloads: false }).exports).toEqual([]);
    expect(machine.opened).not.toContain(exported);
  });
});

describe("the exports in Downloads, parsed on the server (MIG-21, MIG-08)", () => {
  it("answers parsed bots and refusals, never the text, and names an oversized file", () => {
    const { home, put } = fixtureHome();
    put("Downloads/grok-bot-export-good.json", JSON.stringify({ format: "grok-bot-export", version: 1, bots: [{ name: "Drew", instructions: "Plan things." }] }));
    put("Downloads/grok-bot-export-keys.json", JSON.stringify({ format: "grok-bot-export", version: 1, bots: [{ name: "Key", api_key: SECRET }] }));
    put("Downloads/grok-bot-export-big.json", "x".repeat(GROK_EXPORT_MAX_CHARS + 1));
    const look = lookForGrokBot(machineAt(home));
    const byName = Object.fromEntries(look.exports.map((file) => [file.name, file]));
    expect(byName["grok-bot-export-good.json"]!.bots?.map((bot) => bot.name)).toEqual(["Drew"]);
    expect(byName["grok-bot-export-keys.json"]!.refused).toEqual({ code: "credentials", keys: ["bots[0].api_key"] });
    expect(byName["grok-bot-export-big.json"]!.refused?.code).toBe("tooLarge");
    expect(JSON.stringify(look)).not.toContain(SECRET);
  });
});

describe("the synthetic Grok Bot profile, read slice by slice", () => {
  it("reads the roster, chats, routine names, app names and photos, and nothing else", () => {
    const { home } = fixtureHome();
    const never = plantGrokProfile(home);
    const machine = machineAt(home);
    const profile = readGrokProfile(machine);
    expect(profile.bots.map((bot) => [bot.name, bot.removed])).toEqual(SYNTHETIC_BOTS.map((bot) => [bot.name, Boolean(bot.removed)]));
    expect(profile.apps).toEqual(["Calendar", "Notebook"]);
    const nova = profile.bots[0]!;
    const chat = readGrokChat(machine, profile, nova.rosterId);
    if (!chat || "problem" in chat) throw new Error("no chat");
    expect(chat.earlier).toBe(true);
    expect(chat.lines.length).toBe(201);
    expect(chat.lines.filter((line) => line.placeholder).map((line) => line.placeholder!.kind)).toContain("voice");
    expect(chat.lines.some((line) => line.text.includes("sk-live-not-real"))).toBe(false);
    expect(chat.routines).toEqual([{ name: "Monday plan", on: true }, { name: "Friday wrap", on: false }]);
    expect(chat.appsUsed, "connected apps the bot used in its recent chat, each once, from the mcp-app lines").toEqual(["Calendar"]);
    expect(readGrokChat(machine, profile, SYNTHETIC_BOTS[6]!.id)).toMatchObject({ problem: { slice: "chat", code: "newerFormat" } });
    const photo = readGrokPhoto(machine, profile, nova);
    expect(photo && "mime" in photo ? photo.mime : null).toBe("image/png");
    for (const path of never) expect(machine.opened).not.toContain(path);
    expect(machine.opened.every((path) => path.includes("sand-client-persistence") || path.includes("roster-avatars"))).toBe(true);
  });

  it("degrades one slice at a time: a newer roster names the problem, a missing photo costs only the photo", () => {
    const { home, put } = fixtureHome();
    plantGrokProfile(home);
    put(sliceFile("roster.last-roster"), JSON.stringify({ schemaVersion: 9, value: { rows: [] } }));
    const profile = readGrokProfile(machineAt(home));
    expect(profile.bots).toEqual([]);
    expect(profile.problems).toEqual([expect.objectContaining({ slice: "roster", code: "newerFormat" })]);
    expect(profile.apps).toEqual(["Calendar", "Notebook"]);
  });

  it("refuses a cache folder that is a link", () => {
    const { home } = fixtureHome();
    const real = join(home, "elsewhere");
    plantGrokProfile(real);
    mkdirSync(join(home, "Library", "Application Support", "Grok Bot"), { recursive: true });
    symlinkSync(join(real, GROK_CACHE), join(home, GROK_CACHE));
    expect(readGrokProfile(machineAt(home)).found).toBe(false);
  });

  it("lists live bots once each for the older bring step (MIG-13)", () => {
    const { home } = fixtureHome();
    plantGrokProfile(home);
    expect(lookForGrokBot(machineAt(home), { downloads: false }).bots).toEqual(["Nova", "Quill", "Rivet", "Tally", "Juno"]);
  });
});
