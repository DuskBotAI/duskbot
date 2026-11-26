// The ready Telegram watcher a bot starts as a background job (template telegram_watch): long-polls the Bot API with
// the person's bot token and hands each batch of new messages to the bot (dusk-notify), which decides what to tell the
// person. Node's standard library only, so it runs on every computer dusk bot runs on, through the box's egress proxy.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";

import { sendJobNote } from "./dusk-notify.ts";

/** `id` is Telegram's message_id, the same for a message and its edits, so a run can tell a new post from one it logged. */
export interface TelegramMessage { chat: string; chatId: number; id?: number; from: string; text: string; at: number }

/** Telegram's Bot API (https://core.telegram.org/bots/api), the fields this reads. */
interface Update {
  update_id: number;
  message?: RawMessage; edited_message?: RawMessage; channel_post?: RawMessage; edited_channel_post?: RawMessage;
}
interface RawMessage {
  message_id?: number; date: number; text?: string; caption?: string;
  chat: { id: number; title?: string; username?: string; first_name?: string; type: string };
  from?: { first_name?: string; last_name?: string; username?: string };
  sender_chat?: { title?: string };
}

export function messagesOf(updates: readonly Update[]): TelegramMessage[] {
  const out: TelegramMessage[] = [];
  for (const update of updates) {
    const raw = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
    const text = raw?.text ?? raw?.caption;
    if (!raw || !text) continue;
    const chat = raw.chat.title ?? raw.chat.username ?? raw.chat.first_name ?? String(raw.chat.id);
    const from = raw.from ? [raw.from.first_name, raw.from.last_name].filter(Boolean).join(" ") || raw.from.username || "someone" : raw.sender_chat?.title ?? chat;
    out.push({ chat, chatId: raw.chat.id, ...(typeof raw.message_id === "number" ? { id: raw.message_id } : {}), from, text, at: raw.date * 1000 });
  }
  return out;
}

/** Only the chats and words the person cares about; an empty list keeps everything. Matched without case. */
export function wanted(message: TelegramMessage, chats: readonly string[], keywords: readonly string[]): boolean {
  const lower = (value: string) => value.toLowerCase();
  if (chats.length && !chats.some((chat) => lower(message.chat).includes(lower(chat)) || String(message.chatId) === chat)) return false;
  return !keywords.length || keywords.some((word) => lower(message.text).includes(lower(word)));
}

function messagePrefix(m: TelegramMessage, part = ""): string {
  return `[${m.chat}] ${m.from} (${new Date(m.at).toISOString().slice(0, 16).replace("T", " ")} UTC${m.id === undefined ? "" : `, message ${m.id}`}${part ? `, part ${part}` : ""}): `;
}

function renderNote(lines: readonly string[]): string {
  return `New Telegram messages (${lines.length}), each with all this watch knows of it: chat, sender, time, message id and text:\n${lines.join("\n")}`;
}

function* notesFor(updates: readonly Update[], chats: readonly string[], keywords: readonly string[]): Generator<{ text: string; offset?: number }> {
  const limit = 3_800;
  let lines: string[] = [], offset: number | undefined;
  for (const update of updates) {
    const message = messagesOf([update])[0];
    if (!message || !wanted(message, chats, keywords)) continue;
    const text = message.text.replace(/\s+/g, " ").trim();
    let parts = [messagePrefix(message) + text];
    if (renderNote(parts).length > limit) {
      const capacity = limit - renderNote([messagePrefix(message, `${text.length}/${text.length}`)]).length;
      if (capacity < 2) throw new Error("Telegram message metadata exceeds the notification limit");
      const chunks: string[] = [];
      let chunk = "";
      for (const character of text) {
        if (chunk.length + character.length > capacity) { chunks.push(chunk); chunk = ""; }
        chunk += character;
      }
      if (chunk) chunks.push(chunk);
      parts = chunks.map((body, i) => messagePrefix(message, `${i + 1}/${chunks.length}`) + body);
    }
    for (const [i, part] of parts.entries()) {
      if (renderNote([...lines, part]).length > limit) {
        yield { text: renderNote(lines), offset };
        lines = []; offset = undefined;
      }
      lines.push(part);
      if (i === parts.length - 1) offset = update.update_id + 1;
    }
  }
  if (lines.length) yield { text: renderNote(lines), offset };
}

/** A GET through HTTPS_PROXY when one is set (the bot box's egress gate), straight out otherwise. */
function get(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Telegram did not answer in time")), timeoutMs);
    const done = (value: { status: number; body: string }) => { clearTimeout(timer); resolve(value); };
    const failed = (error: Error) => { clearTimeout(timer); reject(error); };
    const settle = (res: import("node:http").IncomingMessage) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => done({ status: res.statusCode ?? 0, body }));
      res.on("error", failed);
    };
    if (target.protocol === "http:") {
      httpRequest(target, { method: "GET" }, settle).on("error", failed).end();
      return;
    }
    if (!proxy) {
      httpsRequest(target, { method: "GET" }, settle).on("error", failed).end();
      return;
    }
    const via = new URL(proxy);
    httpRequest({ host: via.hostname, port: Number(via.port || 80), method: "CONNECT", path: `${target.hostname}:443` })
      .on("connect", (res, socket) => {
        if (res.statusCode !== 200) { socket.destroy(); failed(new Error(`the proxy refused Telegram (${res.statusCode})`)); return; }
        const secure = tlsConnect({ socket, servername: target.hostname });
        httpsRequest(target, { method: "GET", createConnection: () => secure }, settle).on("error", failed).end();
      })
      .on("error", failed)
      .end();
  });
}

/** A test Bot API on loopback only (DUSK_TELEGRAM_API_URL, as the chat app host reads it); anything else is Telegram. */
export function apiBase(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DUSK_TELEGRAM_API_URL;
  return value && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value) ? value : "https://api.telegram.org";
}

async function call<T>(token: string, method: string, query: Record<string, string> = {}, timeoutMs = 20_000): Promise<{ ok: boolean; result?: T; error_code?: number; description?: string }> {
  const url = `${apiBase()}/bot${token}/${method}?${new URLSearchParams(query)}`;
  const answer = await get(url, timeoutMs);
  try { return JSON.parse(answer.body); } catch { return { ok: false, error_code: answer.status, description: `Telegram answered ${answer.status}` }; }
}

const list = (value: string | undefined) => (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);

/** A token Telegram refuses never starts working by itself: say so once and end, so the job is not restarted. */
async function refused(): Promise<void> {
  console.error("Telegram refused the bot token (401 Unauthorized).");
  await sendJobNote("Telegram doesn't accept the bot token I was given, so I stopped watching. Send me the current token from @BotFather and I'll start again.", true);
}

interface State { offset?: number; toldPrivacy?: boolean; toldConflict?: boolean }

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set: start the job with the token's Vault label in secret.");
  const chats = list(process.env.TELEGRAM_WATCH_CHATS), keywords = list(process.env.TELEGRAM_WATCH_KEYWORDS);
  const dir = process.env.DUSK_JOB_DIR ?? ".";
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "telegram-watch.json");
  let state: State = {};
  try { state = JSON.parse(readFileSync(file, "utf8")) as State; } catch {}
  const save = () => writeFileSync(file, JSON.stringify(state));

  const me = await call<{ username: string; can_read_all_group_messages?: boolean }>(token, "getMe");
  if (me.error_code === 401) return refused();
  if (!me.ok || !me.result) throw new Error(`Telegram answered getMe with ${me.error_code ?? "?"} ${me.description ?? ""}.`);
  console.log(`watching as @${me.result.username}${chats.length ? ` in ${chats.join(", ")}` : ""}${keywords.length ? ` for ${keywords.join(", ")}` : ""}`);
  if (me.result.can_read_all_group_messages === false && !state.toldPrivacy) {
    const name = `@${me.result.username}`;
    const told = await sendJobNote(`${name} can only see commands and @mentions in groups. To let it read the group: in Telegram open @BotFather, send /setprivacy, pick ${name}, choose Disable, then remove ${name} from the group and add it again (or make it a group admin).`, true);
    if (told.ok) { state.toldPrivacy = true; save(); }
  }

  let pause = 1_000;
  for (;;) {
    let answer;
    try {
      answer = await call<Update[]>(token, "getUpdates", { timeout: "50", allowed_updates: JSON.stringify(["message", "edited_message", "channel_post", "edited_channel_post"]), ...(state.offset ? { offset: String(state.offset) } : {}) }, 70_000);
    } catch (error) {
      console.error(`getUpdates failed: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, pause));
      pause = Math.min(pause * 2, 60_000);
      continue;
    }
    if (!answer.ok) {
      console.error(`Telegram: ${answer.error_code} ${answer.description}`);
      if (answer.error_code === 401) return refused();
      if (answer.error_code === 409 && !state.toldConflict) {
        const told = await sendJobNote("Another program is already reading this Telegram bot's messages (a webhook or a second poller), so I can't read them too. Turn that one off, or give me a bot of its own.", true);
        if (told.ok) { state.toldConflict = true; save(); }
      }
      await new Promise((resolve) => setTimeout(resolve, pause));
      pause = Math.min(pause * 2, 60_000);
      continue;
    }
    pause = 1_000;
    const updates = answer.result ?? [];
    if (!updates.length) continue;
    let failed = false;
    for (const note of notesFor(updates, chats, keywords)) {
      const sent = await sendJobNote(note.text, false);
      if (!sent.ok) { console.error(`dusk-notify: ${sent.body}`); failed = true; break; }
      if (note.offset !== undefined) { state.offset = note.offset; save(); }
    }
    if (failed) { await new Promise((resolve) => setTimeout(resolve, 15_000)); continue; }
    state.offset = updates[updates.length - 1]!.update_id + 1;
    save();
  }
}

if (process.argv[1] && /telegram-watch\.(?:ts|js)$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
