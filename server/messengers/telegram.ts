// Telegram Bot API (https://core.telegram.org/bots/api, Bot API 9.x). One bot token per dusk bot. Updates arrive by
// long polling (getUpdates) where this process stays up, or by webhook through the public address on a Cloud home,
// whose edge wakes a sleeping home and queues the update for it. Telegram allows one of the two at a time per token.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { InboundChoice, InboundFile, InboundMessage, InboundReaction, MessengerTransport, OutboundFile } from "./bridge.ts";
import { markdownToTelegramHtml, splitMessage } from "./text.ts";

export class TelegramError extends Error {
  readonly code: number;
  readonly retryAfterMs?: number;
  constructor(code: number, description: string, retryAfterMs?: number) {
    super(description);
    this.name = "TelegramError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export const TELEGRAM_TOKEN = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/;
export const TELEGRAM_HOOK_PATH = /^\/hooks\/telegram\/([\w-]{1,128})$/;
const TEXT_MAX = 4096;
const UPLOAD_MAX = 50 * 1024 * 1024;
const PHOTO_MAX = 10 * 1024 * 1024;
/** Telegram sends message_reaction only where the bot is an administrator, and never for a bot's own reactions. */
export const TELEGRAM_UPDATES = ["message", "my_chat_member", "callback_query", "message_reaction"];

/** A test or self-hosted Bot API server on loopback only (DUSK_TELEGRAM_API_URL); anything else is api.telegram.org. */
export function telegramApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DUSK_TELEGRAM_API_URL;
  return value && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value) ? value : "https://api.telegram.org";
}

export interface TelegramApi {
  call<T = unknown>(token: string, method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  upload<T = unknown>(token: string, method: string, fields: Record<string, string>, file: { field: string; name: string; mime: string; bytes: Buffer }): Promise<T>;
  download(token: string, filePath: string, maxBytes: number): Promise<{ bytes: Buffer; mime: string }>;
}

export function createTelegramApi(options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}): TelegramApi {
  const base = telegramApiBase(options.env);
  const fetcher = options.fetch ?? fetch;
  async function answer<T>(response: Response): Promise<T> {
    let body: { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    try { body = await response.json() as typeof body; } catch { throw new TelegramError(response.status || 502, "Telegram answered with something that isn't JSON."); }
    if (body.ok) return body.result as T;
    const retry = body.parameters?.retry_after;
    throw new TelegramError(body.error_code ?? response.status, body.description ?? "Telegram refused the request.", typeof retry === "number" ? retry * 1000 : undefined);
  }
  return {
    async call(token, method, params = {}, timeoutMs = 20_000) {
      let response: Response;
      try {
        response = await fetcher(`${base}/bot${token}/${method}`, { method: "POST", redirect: "error", headers: { "content-type": "application/json" },
          body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs) });
      } catch { throw new TelegramError(0, "Telegram could not be reached."); }
      return answer(response);
    },
    async upload(token, method, fields, file) {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields)) form.set(name, value);
      form.set(file.field, new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name);
      let response: Response;
      try {
        response = await fetcher(`${base}/bot${token}/${method}`, { method: "POST", redirect: "error", body: form, signal: AbortSignal.timeout(120_000) });
      } catch { throw new TelegramError(0, "Telegram could not be reached."); }
      return answer(response);
    },
    async download(token, filePath, maxBytes) {
      if (!/^[\w./-]{1,512}$/.test(filePath) || filePath.includes("..")) throw new TelegramError(400, "Bad file path.");
      const response = await fetcher(`${base}/file/bot${token}/${filePath}`, { redirect: "error", signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new TelegramError(response.status, "The file could not be downloaded.");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new TelegramError(413, "The file is too large.");
      return { bytes, mime: response.headers.get("content-type") ?? "application/octet-stream" };
    },
  };
}

export interface TelegramAccount { id: string; username: string; name: string }

export async function telegramMe(api: TelegramApi, token: string): Promise<TelegramAccount> {
  const me = await api.call<{ id: number; username?: string; first_name?: string; is_bot?: boolean }>(token, "getMe");
  if (!me.is_bot) throw new TelegramError(400, "That token is not a bot's.");
  return { id: String(me.id), username: me.username ?? "", name: me.first_name ?? me.username ?? "Telegram bot" };
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" ? String(value) : "";

function personOf(from: Record<string, unknown>) {
  const name = [str(from.first_name), str(from.last_name)].filter(Boolean).join(" ") || str(from.username) || str(from.id);
  return { id: str(from.id), name, ...(str(from.username) ? { handle: str(from.username) } : {}) };
}

export interface TelegramChatAdded { chatId: string; title: string; by: { id: string; name: string } }

/** One update as the bridge reads it, or what it says about the bot joining a group, or null for anything else. */
export function readTelegramUpdate(
  update: Record<string, unknown>,
  context: { botId: string; account: TelegramAccount; file(fileId: string): Promise<{ bytes: Buffer; mime: string }> },
): { message: InboundMessage } | { added: TelegramChatAdded } | { choice: InboundChoice } | { reaction: InboundReaction } | null {
  const reacted = record(update.message_reaction);
  if (Object.keys(reacted).length) {
    const chat = record(reacted.chat), user = record(reacted.user), before = new Set((Array.isArray(reacted.old_reaction) ? reacted.old_reaction : []).map((one) => str(record(one).emoji)));
    const emoji = (Array.isArray(reacted.new_reaction) ? reacted.new_reaction : []).map(record).find((one) => one.type === "emoji" && str(one.emoji) && !before.has(str(one.emoji)));
    if (!emoji || !str(chat.id) || !str(user.id) || user.is_bot === true || !str(reacted.message_id)) return null;
    return { reaction: { platform: "telegram", botId: context.botId, chatId: str(chat.id), senderId: str(user.id), messageId: str(reacted.message_id), emoji: str(emoji.emoji) } };
  }
  const query = record(update.callback_query);
  if (Object.keys(query).length) {
    const sent = record(query.message), chat = record(sent.chat);
    if (!str(query.id) || !str(record(query.from).id) || !str(chat.id)) return null;
    return { choice: { platform: "telegram", botId: context.botId, chatId: str(chat.id), senderId: str(record(query.from).id), data: str(query.data),
      ...(str(sent.message_id) ? { sentId: str(sent.message_id) } : {}), ack: { id: str(query.id) } } };
  }
  const member = record(update.my_chat_member);
  if (Object.keys(member).length) {
    const chat = record(member.chat), status = str(record(member.new_chat_member).status);
    if ((chat.type === "group" || chat.type === "supergroup") && (status === "member" || status === "administrator")) {
      const by = personOf(record(member.from));
      return { added: { chatId: str(chat.id), title: str(chat.title) || "group", by: { id: by.id, name: by.name } } };
    }
    return null;
  }
  const message = record(update.message);
  const chat = record(message.chat), from = record(message.from);
  if (!Object.keys(message).length || from.is_bot === true || !str(from.id)) return null;
  const kind = chat.type === "private" ? "dm" : chat.type === "group" || chat.type === "supergroup" ? "group" : null;
  if (!kind) return null;
  let text = str(message.text) || str(message.caption);
  const entities = (Array.isArray(message.entities) ? message.entities : Array.isArray(message.caption_entities) ? message.caption_entities : []).map(record);
  const handle = context.account.username.toLowerCase();
  let addressed = kind === "dm";
  const cut: Array<[number, number]> = [];
  for (const entity of entities) {
    const offset = Number(entity.offset), length = Number(entity.length);
    if (!Number.isInteger(offset) || !Number.isInteger(length)) continue;
    const part = text.slice(offset, offset + length).toLowerCase();
    if (entity.type === "mention" && handle && part === `@${handle}`) { addressed = true; cut.push([offset, length]); }
    if (entity.type === "bot_command" && handle && part.endsWith(`@${handle}`)) { addressed = true; cut.push([offset + part.length - handle.length - 1, handle.length + 1]); }
    if (entity.type === "text_mention" && str(record(entity.user).id) === context.account.id) addressed = true;
  }
  for (const [offset, length] of cut.sort((a, b) => b[0] - a[0])) text = text.slice(0, offset) + text.slice(offset + length);
  if (str(record(record(message.reply_to_message).from).id) === context.account.id) addressed = true;

  const files: InboundFile[] = [];
  const add = (value: unknown, fallbackName: string, mime?: string) => {
    const file = record(value), fileId = str(file.file_id);
    if (!fileId) return;
    const size = typeof file.file_size === "number" ? file.file_size : undefined;
    const declared = str(file.mime_type) || mime;
    files.push({ name: str(file.file_name) || fallbackName, ...(declared ? { mime: declared } : {}), ...(size !== undefined ? { size } : {}), fetch: () => context.file(fileId) });
  };
  if (Array.isArray(message.photo) && message.photo.length) add(message.photo.at(-1), "photo.jpg", "image/jpeg");
  add(message.document, "file");
  add(message.voice, "voice.ogg", "audio/ogg");
  add(message.audio, "audio.mp3");
  add(message.video, "video.mp4", "video/mp4");
  add(message.video_note, "video-note.mp4", "video/mp4");

  return { message: {
    platform: "telegram", botId: context.botId, chatId: str(chat.id), chatKind: kind, ...(kind === "group" ? { chatTitle: str(chat.title) } : {}),
    messageId: str(message.message_id), sender: personOf(from), text: text.replace(/[ \t]{2,}/g, " ").trim(), files, addressed,
  } };
}

export function createTelegramTransport(api: TelegramApi, token: (botId: string) => string | null): MessengerTransport {
  const need = (botId: string) => {
    const value = token(botId);
    if (!value) throw new TelegramError(401, "This bot has no Telegram token.");
    return value;
  };
  const reply = (replyTo?: string) => replyTo ? { reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } } : {};
  return {
    typingEveryMs: 4_500,
    async sendText(botId, chatId, text, replyTo) {
      const key = need(botId);
      for (const [index, chunk] of splitMessage(text, 3_800).entries()) {
        const extra = index === 0 ? reply(replyTo) : {};
        try {
          await api.call(key, "sendMessage", { chat_id: chatId, text: markdownToTelegramHtml(chunk), parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });
        } catch (error) {
          if (!(error instanceof TelegramError) || error.code !== 400) throw error;
          await api.call(key, "sendMessage", { chat_id: chatId, text: chunk.slice(0, TEXT_MAX), ...extra });
        }
      }
    },
    async sendFile(botId, chatId, file: OutboundFile, replyTo) {
      if (file.bytes.byteLength > UPLOAD_MAX) throw new TelegramError(413, "The file is over Telegram's 50 MB limit for bots.");
      const [method, field] = file.kind === "image" && file.bytes.byteLength <= PHOTO_MAX && /^image\/(png|jpeg|webp)$/.test(file.mime) ? ["sendPhoto", "photo"]
        : file.kind === "audio" && file.mime.startsWith("audio/ogg") ? ["sendVoice", "voice"]
          : file.kind === "audio" ? ["sendAudio", "audio"] : ["sendDocument", "document"];
      const fields: Record<string, string> = { chat_id: chatId };
      if (replyTo) fields.reply_parameters = JSON.stringify({ message_id: Number(replyTo), allow_sending_without_reply: true });
      await api.upload(need(botId), method!, fields, { field: field!, name: file.name, mime: file.mime, bytes: file.bytes });
    },
    async typing(botId, chatId) {
      await api.call(need(botId), "sendChatAction", { chat_id: chatId, action: "typing" });
    },
    async react(botId, chatId, messageId, emoji) {
      await api.call(need(botId), "setMessageReaction", { chat_id: chatId, message_id: Number(messageId), reaction: [{ type: "emoji", emoji }] });
    },
    async sendChoices(botId, chatId, text, buttons) {
      const rows = buttons.length <= 2 ? [buttons] : buttons.map((button) => [button]);
      const sent = await api.call<{ message_id?: number }>(need(botId), "sendMessage", { chat_id: chatId, text: text.slice(0, TEXT_MAX),
        reply_markup: { inline_keyboard: rows.map((row) => row.map((button) => ({ text: button.label.slice(0, 64), callback_data: button.data }))) } });
      return sent.message_id === undefined ? null : String(sent.message_id);
    },
    async settleChoices(botId, chatId, sentId, note, ack) {
      const key = need(botId);
      if (ack) await api.call(key, "answerCallbackQuery", { callback_query_id: ack.id, ...(ack.toast ? { text: ack.toast.slice(0, 190) } : {}) }).catch(() => {});
      if (!sentId) return;
      if (note) await api.call(key, "editMessageText", { chat_id: chatId, message_id: Number(sentId), text: note.slice(0, TEXT_MAX), reply_markup: { inline_keyboard: [] } });
      else await api.call(key, "editMessageReplyMarkup", { chat_id: chatId, message_id: Number(sentId), reply_markup: { inline_keyboard: [] } });
    },
  };
}

export interface TelegramPollerDeps {
  api: TelegramApi;
  token(): string | null;
  offset(): number;
  setOffset(offset: number): void;
  onUpdate(update: Record<string, unknown>): Promise<void>;
  onState(state: "connecting" | "online" | "error", error?: string): void;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  pollSeconds?: number;
}

/** One getUpdates loop. An update's offset is confirmed only after the bridge accepted it, so a restart never loses one. */
export function createTelegramPoller(deps: TelegramPollerDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
  let running = false, loop: Promise<void> | null = null;
  async function run(): Promise<void> {
    let failures = 0;
    deps.onState("connecting");
    while (running) {
      const token = deps.token();
      if (!token) { deps.onState("error", "This bot has no Telegram token."); return; }
      let updates: Array<Record<string, unknown>>;
      try {
        updates = await deps.api.call(token, "getUpdates", { offset: deps.offset() || undefined, timeout: deps.pollSeconds ?? 25, allowed_updates: TELEGRAM_UPDATES },
          ((deps.pollSeconds ?? 25) + 15) * 1000);
      } catch (error) {
        if (!running) return;
        const code = error instanceof TelegramError ? error.code : 0;
        if (code === 401 || code === 404) { deps.onState("error", "Telegram no longer accepts this bot's token. Paste a new one from BotFather."); return; }
        failures++;
        deps.onState(failures >= 3 || code === 409 ? "error" : "connecting", code === 409
          ? "Another app is reading this Telegram bot's messages. Stop it there, or disconnect and connect again here."
          : failures >= 3 ? "Telegram can't be reached right now. Retrying." : undefined);
        await sleep(error instanceof TelegramError && error.retryAfterMs ? error.retryAfterMs : Math.min(60_000, 2_000 * 2 ** Math.min(failures, 5)));
        continue;
      }
      failures = 0;
      deps.onState("online");
      for (const update of Array.isArray(updates) ? updates : []) {
        if (!running) return;
        const id = Number(update.update_id);
        try { await deps.onUpdate(update); } catch { deps.log?.("A Telegram update could not be handled."); }
        if (Number.isSafeInteger(id)) deps.setOffset(id + 1);
      }
    }
  }
  return {
    start() {
      if (running) return;
      running = true;
      loop = run().catch(() => deps.onState("error", "Telegram polling stopped."));
    },
    async stop() {
      running = false;
      await loop?.catch(() => {});
    },
  };
}

/** Telegram signs nothing; the secret_token set with setWebhook comes back in this header on every delivery. */
export function telegramHookSecretMatches(req: IncomingMessage, expected: string | undefined): boolean {
  const got = req.headers["x-telegram-bot-api-secret-token"];
  if (!expected || typeof got !== "string") return false;
  const a = Buffer.from(got), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hookAnswer(res: ServerResponse, status: number): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(status === 200 ? "{\"ok\":true}" : "{\"ok\":false}");
}
