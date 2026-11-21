// Discord bots (https://discord.com/developers/docs, API v10). Messages arrive only over the Gateway websocket, so a
// bot answers while this process runs. The privileged Message Content intent is not asked for: Discord still sends
// the content of direct messages and of messages that mention the bot, which is all the bot answers.
import type { ChoiceAck, InboundChoice, InboundFile, InboundMessage, MessengerTransport, OutboundFile } from "./bridge.ts";
import { splitMessage } from "./text.ts";

export class DiscordError extends Error {
  readonly code: number;
  readonly retryAfterMs?: number;
  constructor(code: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "DiscordError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export const DISCORD_TOKEN = /^[A-Za-z0-9_-]{20,40}\.[A-Za-z0-9_-]{4,10}\.[A-Za-z0-9_-]{20,64}$/;
const GUILDS = 1 << 0, GUILD_MESSAGES = 1 << 9, DIRECT_MESSAGES = 1 << 12;
export const DISCORD_INTENTS = GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES;
/** View Channel, Send Messages, Attach Files, Read Message History. */
const INVITE_PERMISSIONS = String((1 << 10) | (1 << 11) | (1 << 15) | (1 << 16));
const UPLOAD_MAX = 10 * 1024 * 1024;

/** A test Discord on loopback (DUSK_DISCORD_API_URL, its gateway on the same origin); anything else is discord.com. */
export function discordApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DUSK_DISCORD_API_URL;
  return value && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value) ? `${value}/api/v10` : "https://discord.com/api/v10";
}

export function discordInviteUrl(appId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(appId)}&scope=bot&permissions=${INVITE_PERMISSIONS}`;
}

function allowedCdn(url: string, base: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return false;
    if (base.startsWith("http://127.0.0.1:")) return parsed.origin === new URL(base).origin;
    return parsed.protocol === "https:" && (parsed.hostname === "cdn.discordapp.com" || parsed.hostname === "media.discordapp.net");
  } catch { return false; }
}

export interface DiscordApi {
  readonly base: string;
  call<T = unknown>(token: string, method: string, path: string, body?: unknown): Promise<T>;
  upload(token: string, path: string, payload: Record<string, unknown>, file: { name: string; mime: string; bytes: Buffer }): Promise<void>;
  download(url: string, maxBytes: number): Promise<{ bytes: Buffer; mime: string }>;
}

export function createDiscordApi(options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}): DiscordApi {
  const base = discordApiBase(options.env);
  const fetcher = options.fetch ?? fetch;
  async function send<T>(token: string, method: string, path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, { ...init, method, redirect: "error", signal: AbortSignal.timeout(60_000),
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bot ${token}`, "user-agent": "DiscordBot (https://dusk.bot, 1)" } });
    } catch { throw new DiscordError(0, "Discord could not be reached."); }
    if (response.status === 204) return undefined as T;
    let body: Record<string, unknown> = {};
    try { body = await response.json() as Record<string, unknown>; } catch {}
    if (response.ok) return body as T;
    const retry = typeof body.retry_after === "number" ? body.retry_after * 1000 : undefined;
    throw new DiscordError(response.status, typeof body.message === "string" ? body.message : "Discord refused the request.", retry);
  }
  return {
    base,
    call: (token, method, path, body) => send(token, method, path, body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    async upload(token, path, payload, file) {
      const form = new FormData();
      form.set("payload_json", JSON.stringify({ ...payload, attachments: [{ id: 0, filename: file.name }] }));
      form.set("files[0]", new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name);
      await send(token, "POST", path, { body: form });
    },
    async download(url, maxBytes) {
      if (!allowedCdn(url, base)) throw new DiscordError(400, "Not a Discord file address.");
      const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new DiscordError(response.status, "The file could not be downloaded.");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new DiscordError(413, "The file is too large.");
      return { bytes, mime: response.headers.get("content-type") ?? "application/octet-stream" };
    },
  };
}

export interface DiscordAccount { id: string; username: string; name: string; appId: string }

export async function discordMe(api: DiscordApi, token: string): Promise<DiscordAccount> {
  const me = await api.call<{ id: string; username?: string; global_name?: string | null; bot?: boolean }>(token, "GET", "/users/@me");
  if (!me.bot) throw new DiscordError(400, "That token is not a bot's.");
  const app = await api.call<{ id?: string }>(token, "GET", "/oauth2/applications/@me").catch(() => ({ id: me.id }));
  return { id: me.id, username: me.username ?? "", name: me.global_name || me.username || "Discord bot", appId: app.id || me.id };
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string => typeof value === "string" ? value : "";

/** A MESSAGE_CREATE dispatch as the bridge reads it, or null. */
export function readDiscordMessage(data: Record<string, unknown>, context: { botId: string; account: { id: string }; download(url: string): Promise<{ bytes: Buffer; mime: string }> }): InboundMessage | null {
  const author = record(data.author);
  if (!str(author.id) || author.bot === true || author.id === context.account.id || (data.type !== 0 && data.type !== 19)) return null;
  const dm = !str(data.guild_id);
  const mentioned = Array.isArray(data.mentions) && data.mentions.some((one) => str(record(one).id) === context.account.id);
  const repliedTo = str(record(record(data.referenced_message).author).id) === context.account.id;
  const mention = new RegExp(`<@!?${context.account.id}>`, "g");
  const files: InboundFile[] = (Array.isArray(data.attachments) ? data.attachments : []).map(record).filter((one) => str(one.url)).map((one) => ({
    name: str(one.filename) || "file", ...(str(one.content_type) ? { mime: str(one.content_type) } : {}),
    ...(typeof one.size === "number" ? { size: one.size } : {}), fetch: () => context.download(str(one.url)),
  }));
  const name = str(record(data.member).nick) || str(author.global_name) || str(author.username) || str(author.id);
  return {
    platform: "discord", botId: context.botId, chatId: str(data.channel_id), chatKind: dm ? "dm" : "group",
    ...(dm ? {} : { chatTitle: `#${str(data.channel_id)}` }),
    messageId: str(data.id), sender: { id: str(author.id), name, ...(str(author.username) ? { handle: str(author.username) } : {}) },
    text: str(data.content).replace(mention, "").replace(/[ \t]{2,}/g, " ").trim(), files, addressed: dm || mentioned || repliedTo,
  };
}

/** A button press (INTERACTION_CREATE of a message component) as the bridge reads it, or null. */
export function readDiscordInteraction(data: Record<string, unknown>, context: { botId: string }): InboundChoice | null {
  const user = record(data.user), member = record(record(data.member).user);
  const senderId = str(user.id) || str(member.id), custom = str(record(data.data).custom_id);
  if (data.type !== 3 || !str(data.id) || !str(data.token) || !str(data.channel_id) || !senderId || !custom) return null;
  const sentId = str(record(data.message).id);
  return { platform: "discord", botId: context.botId, chatId: str(data.channel_id), senderId, data: custom, ...(sentId ? { sentId } : {}),
    ack: { id: str(data.id), token: str(data.token), ...(str(data.application_id) ? { appId: str(data.application_id) } : {}) } };
}

/** Discord wants an answer to a press within 3 seconds: this one says "the message will be updated" so the card can be
 * answered at its own pace and edited after. */
export async function deferDiscordChoice(api: DiscordApi, token: string, ack: ChoiceAck): Promise<void> {
  if (!ack.token) return;
  await api.call(token, "POST", `/interactions/${encodeURIComponent(ack.id)}/${encodeURIComponent(ack.token)}/callback`, { type: 6 });
}

export function createDiscordTransport(api: DiscordApi, token: (botId: string) => string | null): MessengerTransport {
  const need = (botId: string) => {
    const value = token(botId);
    if (!value) throw new DiscordError(401, "This bot has no Discord token.");
    return value;
  };
  const reference = (replyTo?: string) => replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {};
  return {
    typingEveryMs: 8_000,
    async sendText(botId, chatId, text, replyTo) {
      for (const [index, chunk] of splitMessage(text, 1_900).entries()) {
        await api.call(need(botId), "POST", `/channels/${encodeURIComponent(chatId)}/messages`, { content: chunk, allowed_mentions: { parse: [] }, ...(index === 0 ? reference(replyTo) : {}) });
      }
    },
    async sendFile(botId, chatId, file: OutboundFile, replyTo) {
      if (file.bytes.byteLength > UPLOAD_MAX) throw new DiscordError(413, "The file is over Discord's 10 MB limit for bots.");
      await api.upload(need(botId), `/channels/${encodeURIComponent(chatId)}/messages`, { allowed_mentions: { parse: [] }, ...reference(replyTo) }, file);
    },
    async typing(botId, chatId) {
      await api.call(need(botId), "POST", `/channels/${encodeURIComponent(chatId)}/typing`);
    },
    async sendChoices(botId, chatId, text, buttons) {
      const rows: Array<typeof buttons> = [];
      for (let index = 0; index < buttons.length; index += 5) rows.push(buttons.slice(index, index + 5));
      const sent = await api.call<{ id?: string } | undefined>(need(botId), "POST", `/channels/${encodeURIComponent(chatId)}/messages`, {
        content: text.slice(0, 1_900), allowed_mentions: { parse: [] },
        components: rows.map((row) => ({ type: 1, components: row.map((button, index) => ({ type: 2, style: index === 0 && row === rows[0] ? 1 : 2, label: button.label.slice(0, 80), custom_id: button.data })) })),
      });
      return sent?.id ?? null;
    },
    async settleChoices(botId, chatId, sentId, note, ack) {
      const key = need(botId);
      // a refusal with nothing to edit goes to the person who pressed only
      if (!note && ack?.toast && ack.token && ack.appId) {
        await api.call(key, "POST", `/webhooks/${encodeURIComponent(ack.appId)}/${encodeURIComponent(ack.token)}`, { content: ack.toast.slice(0, 1_900), flags: 64, allowed_mentions: { parse: [] } }).catch(() => {});
      }
      if (!sentId) return;
      await api.call(key, "PATCH", `/channels/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(sentId)}`, { ...(note ? { content: note.slice(0, 1_900) } : {}), components: [] });
    },
  };
}

export interface DiscordGatewayDeps {
  api: DiscordApi;
  token(): string | null;
  onMessage(data: Record<string, unknown>): void;
  onInteraction?(data: Record<string, unknown>): void;
  onState(state: "connecting" | "online" | "error", error?: string): void;
  WebSocket?: typeof WebSocket;
  log?: (line: string) => void;
}

/** Close codes after which a reconnect cannot help (bad token, intents not allowed). */
const FATAL_CLOSE = new Map<number, string>([
  [4004, "Discord no longer accepts this bot's token. Paste a new one from the Developer Portal."],
  [4013, "Discord refused the bot's intents."],
  [4014, "Discord refused the bot's intents."],
]);

export function createDiscordGateway(deps: DiscordGatewayDeps) {
  const Socket = deps.WebSocket ?? WebSocket;
  let running = false, socket: WebSocket | null = null, heartbeat: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null, failures = 0;
  let seq: number | null = null, sessionId = "", resumeUrl = "", acked = true;

  const clearBeat = () => { if (heartbeat) clearInterval(heartbeat); heartbeat = null; };
  function later(): void {
    if (!running) return;
    failures++;
    if (failures >= 3) deps.onState("error", "Discord can't be reached right now. Retrying.");
    retry = setTimeout(connect, Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6)));
    retry.unref?.();
  }
  async function connect(): Promise<void> {
    retry = null;
    const token = deps.token();
    if (!running) return;
    if (!token) { deps.onState("error", "This bot has no Discord token."); return; }
    let url = resumeUrl;
    if (!url) {
      try { url = (await deps.api.call<{ url: string }>(token, "GET", "/gateway/bot")).url; }
      catch (error) {
        if (error instanceof DiscordError && error.code === 401) { deps.onState("error", FATAL_CLOSE.get(4004)); return; }
        later(); return;
      }
    }
    if (!running) return;
    deps.onState("connecting");
    const target = new URL(url);
    target.searchParams.set("v", "10");
    target.searchParams.set("encoding", "json");
    const ws = new Socket(target.toString());
    socket = ws;
    const sendOp = (op: number, d: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ op, d })); };
    ws.addEventListener("message", (event) => {
      let payload: { op?: number; d?: unknown; s?: number | null; t?: string | null };
      try { payload = JSON.parse(String(event.data)) as typeof payload; } catch { return; }
      if (typeof payload.s === "number") seq = payload.s;
      if (payload.op === 10) {
        const interval = Number(record(payload.d).heartbeat_interval) || 41_250;
        clearBeat();
        acked = true;
        heartbeat = setInterval(() => {
          if (!acked) { ws.close(4000, "zombie"); return; }
          acked = false;
          sendOp(1, seq);
        }, interval);
        heartbeat.unref?.();
        if (sessionId && resumeUrl) sendOp(6, { token, session_id: sessionId, seq });
        else sendOp(2, { token, intents: DISCORD_INTENTS, properties: { os: process.platform, browser: "dusk bot", device: "dusk bot" } });
      } else if (payload.op === 11) acked = true;
      else if (payload.op === 1) sendOp(1, seq);
      else if (payload.op === 7) ws.close(4000, "reconnect");
      else if (payload.op === 9) {
        if (!payload.d) { sessionId = ""; resumeUrl = ""; seq = null; }
        ws.close(4000, "invalid session");
      } else if (payload.op === 0) {
        const data = record(payload.d);
        if (payload.t === "READY") {
          sessionId = str(data.session_id);
          resumeUrl = str(data.resume_gateway_url);
          failures = 0;
          deps.onState("online");
        } else if (payload.t === "RESUMED") { failures = 0; deps.onState("online"); }
        else if (payload.t === "MESSAGE_CREATE") deps.onMessage(data);
        else if (payload.t === "INTERACTION_CREATE") deps.onInteraction?.(data);
      }
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      socket = null;
      clearBeat();
      const fatal = FATAL_CLOSE.get(event.code);
      if (fatal) { running = false; deps.onState("error", fatal); return; }
      if (event.code === 4007 || event.code === 4009) { sessionId = ""; resumeUrl = ""; seq = null; }
      later();
    });
    ws.addEventListener("error", () => { try { ws.close(); } catch {} });
  }
  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      void connect();
    },
    stop() {
      running = false;
      if (retry) clearTimeout(retry);
      retry = null;
      clearBeat();
      const ws = socket;
      socket = null;
      sessionId = ""; resumeUrl = ""; seq = null;
      try { ws?.close(1000, "stop"); } catch {}
    },
  };
}
