import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeTelegramCall { method: string; token: string; params: Record<string, unknown>; file?: { field: string; name: string; bytes: number } }

/** A loopback Bot API: getMe, getUpdates (long poll over a queue), webhooks, sends, getFile and file downloads. */
export async function startFakeTelegram(options: { token: string; bot?: { id: number; username: string; first_name: string } }) {
  const bot = options.bot ?? { id: 7000001, username: "nova_test_bot", first_name: "Nova" };
  const calls: FakeTelegramCall[] = [];
  const queue: Array<Record<string, unknown>> = [];
  const files = new Map<string, { path: string; bytes: Buffer; mime: string }>();
  const waiters = new Set<() => void>();
  let nextUpdate = 1, nextMessage = 100, webhook = { url: "", secret: "" };

  async function body(req: IncomingMessage): Promise<{ params: Record<string, unknown>; file?: FakeTelegramCall["file"] }> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const type = req.headers["content-type"] ?? "";
    if (type.startsWith("multipart/form-data")) {
      const form = await new Response(raw, { headers: { "content-type": type } }).formData();
      const params: Record<string, unknown> = {};
      let file: FakeTelegramCall["file"];
      for (const [field, value] of form.entries()) {
        if (typeof value === "string") params[field] = value;
        else file = { field, name: value.name, bytes: value.size };
      }
      return { params, ...(file ? { file } : {}) };
    }
    return { params: raw.length ? JSON.parse(raw.toString("utf8")) as Record<string, unknown> : {} };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const reply = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    const ok = (result: unknown) => reply(200, { ok: true, result });
    const download = /^\/file\/bot([^/]+)\/(.+)$/.exec(url.pathname);
    if (download) {
      const file = [...files.values()].find((one) => one.path === download[2]);
      if (download[1] !== options.token || !file) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": file.mime });
      res.end(file.bytes);
      return;
    }
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    if (!match) return reply(404, { ok: false, error_code: 404, description: "Not Found" });
    const [, token, method] = match;
    if (token !== options.token) return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });
    const { params, file } = await body(req);
    calls.push({ method: method!, token: token!, params, ...(file ? { file } : {}) });
    switch (method) {
      case "getMe": return ok({ ...bot, is_bot: true });
      case "getWebhookInfo": return ok({ url: webhook.url, pending_update_count: 0 });
      case "setWebhook": webhook = { url: String(params.url), secret: String(params.secret_token ?? "") }; return ok(true);
      case "deleteWebhook": webhook = { url: "", secret: "" }; return ok(true);
      case "getUpdates": {
        if (webhook.url) return reply(409, { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" });
        const offset = Number(params.offset ?? 0);
        while (queue.length && Number(queue[0]!.update_id) < offset) queue.shift();
        if (!queue.length) {
          await new Promise<void>((resolve) => {
            const done = () => { waiters.delete(done); clearTimeout(timer); resolve(); };
            const timer = setTimeout(done, Math.min(Number(params.timeout ?? 0), 2) * 1000);
            waiters.add(done);
          });
        }
        return ok(queue.filter((one) => Number(one.update_id) >= offset));
      }
      case "getFile": {
        const found = files.get(String(params.file_id));
        return found ? ok({ file_id: params.file_id, file_path: found.path, file_size: found.bytes.length }) : reply(400, { ok: false, error_code: 400, description: "Bad Request: invalid file_id" });
      }
      case "sendMessage": {
        if (params.parse_mode === "HTML" && String(params.text).includes("<broken")) return reply(400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities" });
        return ok({ message_id: nextMessage++, chat: { id: params.chat_id }, text: params.text });
      }
      case "sendPhoto": case "sendDocument": case "sendVoice": case "sendAudio": return ok({ message_id: nextMessage++ });
      case "sendChatAction": case "answerCallbackQuery": case "editMessageText": case "editMessageReplyMarkup": return ok(true);
      default: return reply(400, { ok: false, error_code: 400, description: `Bad Request: method ${method} not faked` });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  function push(update: Record<string, unknown>): Record<string, unknown> {
    const full = { update_id: nextUpdate++, ...update };
    queue.push(full);
    for (const wake of Array.from(waiters)) wake();
    return full;
  }

  return {
    origin, bot, calls, files, webhook: () => webhook,
    /** A message as a person's client sends it; the update is queued for getUpdates and returned for a webhook post. */
    message(input: { from: { id: number; first_name: string; username?: string }; chat?: { id: number; type: string; title?: string }; text?: string; caption?: string;
      entities?: unknown[]; reply_to_message?: unknown; photo?: Array<{ file_id: string; file_size?: number }> }) {
      const { from, chat, ...rest } = input;
      return push({ message: { message_id: nextMessage++, date: Math.floor(Date.now() / 1000), from: { ...from, is_bot: false }, chat: chat ?? { id: from.id, type: "private", first_name: from.first_name }, ...rest } });
    },
    added(input: { from: { id: number; first_name: string }; chat: { id: number; type: string; title: string } }) {
      return push({ my_chat_member: { chat: input.chat, from: input.from, date: 0, old_chat_member: { status: "left", user: bot }, new_chat_member: { status: "member", user: bot } } });
    },
    /** A tap on an inline button under the bot's message `messageId`. */
    press(input: { from: { id: number; first_name: string }; chatId: number; messageId: number; data: string }) {
      return push({ callback_query: { id: `q${nextUpdate}`, from: { ...input.from, is_bot: false }, message: { message_id: input.messageId, chat: { id: input.chatId, type: "private" } }, data: input.data } });
    },
    addFile(fileId: string, bytes: Buffer, mime: string) { files.set(fileId, { path: `photos/${fileId}.jpg`, bytes, mime }); },
    sent(method = "sendMessage") { return calls.filter((call) => call.method === method); },
    close: () => new Promise<void>((resolve) => { for (const wake of Array.from(waiters)) wake(); server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
export type FakeTelegram = Awaited<ReturnType<typeof startFakeTelegram>>;

if (import.meta.url === `file://${process.argv[1]}`) {
  const token = process.argv[2] ?? "7000001:AAH" + "x".repeat(32);
  const fake = await startFakeTelegram({ token });
  console.log(JSON.stringify({ origin: fake.origin, token }));
  const control = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
    const answer = req.url === "/message" ? fake.message(input as Parameters<typeof fake.message>[0]) : req.url === "/calls" ? fake.calls : null;
    res.writeHead(answer ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
  });
  control.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ control: `http://127.0.0.1:${(control.address() as AddressInfo).port}` })));
}
