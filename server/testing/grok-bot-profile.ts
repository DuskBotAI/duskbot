// A synthetic Grok Bot profile laid out as a fake home, in the shape Grok Bot 1.1 keeps on a Mac: invented bots with
// pictures, chats over and under the 200-entry window, routine events, connected app names, a removed bot, a duplicate
// name and a chat slice in a format newer than dusk bot reads. Login material beside it holds GROK_SENTINEL, so a test
// can prove it is never opened. Every name and line here is invented.
// Run: node --experimental-strip-types server/testing/grok-bot-profile.ts <home>
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

export const GROK_SENTINEL = "never-open-this-grok-login-material";
export const GROK_CACHE = join("Library", "Application Support", "Grok Bot", "sand-client-persistence");
const ACCOUNT = "user%2E1";

export function base32Name(id: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, value = 0, out = "";
  for (const byte of Buffer.from(id)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return `${bits ? out + alphabet[(value << (5 - bits)) & 31] : out}.blob`;
}

export const sliceFile = (kind: string) => join(GROK_CACHE, base32Name(`sand.client.slice.account.${ACCOUNT}.${kind}`));

/** A small solid PNG: real image bytes for the photo path. */
export function solidPng(rgb: [number, number, number], size = 16): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from(rgb))]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

export interface SyntheticBot {
  id: string;
  name: string;
  description: string;
  shape: string;
  color: string;
  photo?: [number, number, number];
  removed?: boolean;
  /** Chat entries written (the window Grok Bot keeps is at most 200). */
  entries: number;
  earlier?: boolean;
  chatVersion?: number;
  routines?: Array<{ id: string; name: string; actions: string[] }>;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const SYNTHETIC_BOTS: SyntheticBot[] = [
  { id: uuid(1), name: "Nova", description: "Plans the week and keeps the calendar honest.", shape: "blob", color: "violet", photo: [120, 80, 200], entries: 200, earlier: true,
    routines: [{ id: "r1", name: "Monday plan", actions: ["created", "updated"] }, { id: "r2", name: "Friday wrap", actions: ["created", "disabled"] }, { id: "r3", name: "Old digest", actions: ["created", "deleted"] }] },
  { id: uuid(2), name: "Quill", description: "Drafts newsletters in a warm voice.\nKeeps a style sheet.", shape: "cloud", color: "magenta", photo: [220, 60, 140], entries: 24 },
  { id: uuid(3), name: "Rivet", description: "", shape: "teardrop", color: "black", entries: 6, routines: [{ id: "r4", name: "Stand-up note", actions: ["created"] }] },
  { id: uuid(4), name: "Tally", description: "Counts receipts for the shared flat.", shape: "pumpkin", color: "orange", entries: 0 },
  { id: uuid(5), name: "Echo", description: "A bot that was removed from the sidebar.", shape: "blob", color: "cyan", removed: true, entries: 4 },
  { id: uuid(6), name: "Nova", description: "A second bot with the same name.", shape: "", color: "", entries: 3 },
  { id: uuid(7), name: "Juno", description: "Reads the garden forecast.", shape: "blob", color: "green", entries: 12, chatVersion: 99 },
];

function entriesFor(bot: SyntheticBot): unknown[] {
  const start = Date.UTC(2026, 9, 1, 9, 0, 0);
  const out: unknown[] = [];
  for (let i = 0; i < bot.entries; i += 1) {
    const at = start + i * 60_000;
    const seq = (bot.earlier ? 400 : 1) + i;
    const base = { id: `${bot.id}-e${i}`, seq, timestampMs: at, requestId: `q${i}` };
    const kind = i % 10;
    if (kind === 7) out.push({ ...base, kind: "send-message", message: { type: "widget", prompt: "Pick one", options: [{ label: "A", value: "a" }] } });
    else if (kind === 8) out.push({ ...base, kind: "user-attachment", file_name: `receipt-${i}.png`, file_path: "/home/box/x.png", byteSize: 10 });
    else if (kind === 9) out.push({ ...base, kind: "mcp-app", serverName: "Calendar", toolName: "list_events", toolArgumentsJson: "{}", toolResultJson: "{\"token\":\"sk-live-not-real\"}" });
    else if (i % 2 === 0) out.push({ ...base, kind: "message", role: "user", content: `Invented question ${i} for ${bot.name}` });
    else out.push({ ...base, kind: "send-message", message: { type: "text", content: `Invented answer ${i} from ${bot.name}` } });
  }
  if (bot.entries > 3) out.splice(2, 0, { id: `${bot.id}-v`, kind: "voice-call", seq: 0, timestampMs: start + 90_000, call: { callId: "c", durationMs: 1000 }, conversation: { turns: [{ speaker: "user", text: "a spoken line" }] } });
  for (const routine of bot.routines ?? []) {
    for (const action of routine.actions) {
      out.push({ id: `${bot.id}-${routine.id}-${action}`, kind: "event", seq: 0, timestampMs: start, event: { type: "automation-changed", action, automationId: routine.id, automationName: routine.name } });
    }
  }
  return out;
}

const photoKey = (bot: SyntheticBot) => bot.id.replace(/-/g, "");

/** Lays the profile out under `home`; answers the paths that must never be opened. */
export function plantGrokProfile(home: string, bots: readonly SyntheticBot[] = SYNTHETIC_BOTS): string[] {
  const put = (path: string, data: string | Buffer) => {
    const full = join(home, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
    return full;
  };
  put(sliceFile("roster.last-roster"), JSON.stringify({ schemaVersion: 4, value: { rows: [
    ...bots.map((bot) => ({
      id: bot.id, name: bot.name, description: bot.description, title: "", avatarShape: bot.shape, avatarColor: bot.color,
      avatarVersion: null, avatarPhoto: bot.photo ? { kind: "file", key: photoKey(bot) } : null,
      createdAt: Date.UTC(2026, 5, 1), updatedAt: Date.UTC(2026, 9, 1), path: `/home/box/sand-data/agents/${bot.id}/store.db`,
      lastEntry: { kind: "message", text: GROK_SENTINEL }, isHiddenFromSidebar: Boolean(bot.removed), isRemovedFromSidebar: Boolean(bot.removed), isGroup: false, memberIds: [],
    })),
    { id: uuid(99), name: "A group", isGroup: true, memberIds: [uuid(1), uuid(2)] },
  ] } }));
  for (const bot of bots) {
    if (bot.entries > 0 || bot.routines?.length) {
      put(sliceFile(`transcript.replicas.${bot.id}`), JSON.stringify({ schemaVersion: bot.chatVersion ?? 1, value: {
        entries: entriesFor(bot), epochHint: 1, persistedAt: Date.UTC(2026, 9, 2), cloudAgentPeerIds: [],
        ...(bot.earlier ? { precedingTimestampMs: Date.UTC(2026, 8, 1) } : {}),
      } }));
    }
    if (bot.photo) put(join("Library", "Application Support", "Grok Bot", "roster-avatars", photoKey(bot)), solidPng(bot.photo));
  }
  put(sliceFile("mcp.connect-logos"), JSON.stringify({ schemaVersion: 1, value: { logos: [
    { key: "cal", name: "Calendar", iconUrl: "https://example.invalid/cal.png", logo: "data:image/png;base64,AA==" },
    { key: "notes", name: "Notebook", iconUrl: "https://example.invalid/n.png", logo: "data:image/png;base64,AA==" },
  ] } }));
  put(sliceFile("mcp.abc"), JSON.stringify({ schemaVersion: 1, value: { connectedApps: 2 } }));
  return [
    put(sliceFile("settings.tokens"), GROK_SENTINEL),
    put(sliceFile("composer-drafts"), JSON.stringify({ schemaVersion: 1, value: { text: GROK_SENTINEL } })),
    put(join(GROK_CACHE, "sand-secrets.json"), GROK_SENTINEL),
    put(join("Library", "Application Support", "Grok Bot", "sand-secrets.json"), GROK_SENTINEL),
    put(join("Library", "Application Support", "Grok Bot", "Cookies"), GROK_SENTINEL),
    put(join("Library", "Application Support", "Grok Bot", "Local Storage", "leveldb", "000003.log"), GROK_SENTINEL),
    put(join("Library", "Application Support", "Grok Bot", "sentry", "scope_v3.json"), GROK_SENTINEL),
    put(join(".grokbot", "local-exec-daemon-credential.json"), GROK_SENTINEL),
    put(join(".grokbot", "settings.json"), GROK_SENTINEL),
  ];
}

/** An export the bot would write of itself, in the shape the request asks for. */
export function syntheticExport(name: string, extra: Record<string, unknown> = {}): string {
  const bot = {
    name,
    instructions: `You are ${name}. Plan the week, every Monday, and keep notes short.`,
    memories: ["The person prefers mornings.", "Standing meeting moved to Tuesday.\nIt runs 30 minutes."],
    user_facts: ["Lives in Lisbon."],
    skills: [{ name: "Week plan", description: "Plan a week", instructions: "List the week's events, then three priorities." }],
    routines: [
      { name: "Monday plan", instruction: "Write the plan.", schedule_cron: "0 8 * * 1", timezone: "Europe/Lisbon", paused: false },
      { name: "Moon check", instruction: "Look at the moon.", schedule_cron: "0 21 * * *", timezone: "Mars/Olympus", paused: true },
      { name: "Sunday tidy", instruction: "Tidy notes.", schedule_text: "Sundays at 6pm", paused: false },
    ],
    apps: [{ name: "Calendar", mcp_url: "https://prod-3f9a1c7e5b2d4a60.relay.example/mcp" }],
    ...extra,
  };
  return `Here is my setup.\n\n\`\`\`json\n${JSON.stringify({ format: "grok-bot-export", version: 1, bots: [bot] }, null, 2)}\n\`\`\`\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const home = process.argv[2];
  if (!home) throw new Error("usage: grok-bot-profile.ts <home>");
  plantGrokProfile(home);
  console.log(JSON.stringify({ home, bots: SYNTHETIC_BOTS.length }));
}
