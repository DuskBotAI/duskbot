// A loopback Telegram Bot API for many bots at once (any well-formed token is its own bot), so each conversation gets a
// token of its own: the chat app host and the telegram_watch job reach it through DUSK_TELEGRAM_API_URL.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface TelegramCall { token: string; method: string; params: Record<string, unknown>; at: number }

interface BotState { queue: Array<Record<string, unknown>>; waiters: Set<() => void>; nextUpdate: number; nextMessage: number; username: string }

export async function startTelegram() {
  const bots = new Map<string, BotState>();
  const calls: TelegramCall[] = [];
  const bot = (token: string): BotState => {
    let state = bots.get(token);
    if (!state) bots.set(token, state = { queue: [], waiters: new Set(), nextUpdate: 1, nextMessage: 100, username: `sage_${token.split(":")[0]}_bot` });
    return state;
  };
  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const type = req.headers["content-type"] ?? "";
    if (type.startsWith("multipart/form-data")) {
      const form = await new Response(raw, { headers: { "content-type": type } }).formData();
      return Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `[file ${v.name}]`]));
    }
    if (raw.length && type.includes("json")) return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    return {};
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const reply = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    const ok = (result: unknown) => reply(200, { ok: true, result });
    const match = /^\/bot(\d{5,16}:[A-Za-z0-9_-]{30,64})\/(\w+)$/.exec(url.pathname);
    if (!match) return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });
    const [, token, method] = match;
    const state = bot(token!);
    const params = { ...Object.fromEntries(url.searchParams), ...(await body(req)) };
    calls.push({ token: token!, method: method!, params, at: Date.now() });
    switch (method) {
      case "getMe": return ok({ id: Number(token!.split(":")[0]), is_bot: true, first_name: "Sage", username: state.username, can_join_groups: true, can_read_all_group_messages: true });
      case "getWebhookInfo": return ok({ url: "", pending_update_count: 0 });
      case "getUpdates": {
        const offset = Number(params.offset ?? 0);
        while (state.queue.length && Number(state.queue[0]!.update_id) < offset) state.queue.shift();
        if (!state.queue.length) {
          await new Promise<void>((resolve) => {
            const done = () => { state.waiters.delete(done); clearTimeout(timer); resolve(); };
            const timer = setTimeout(done, Math.min(Number(params.timeout ?? 0), 10) * 1000);
            state.waiters.add(done);
          });
        }
        return ok(state.queue.filter((one) => Number(one.update_id) >= offset));
      }
      case "sendMessage": return ok({ message_id: state.nextMessage++, chat: { id: params.chat_id }, date: Math.floor(Date.now() / 1000), text: params.text });
      default: return ok(true);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin, calls,
    username: (token: string) => bot(token).username,
    /** a message from a person in a private chat (chatTitle unset) or a group */
    message(token: string, input: { fromId: number; from: string; text: string; chatTitle?: string; chatId?: number }) {
      const state = bot(token);
      const chat = input.chatTitle ? { id: input.chatId ?? -1000 - input.chatTitle.length, type: "supergroup", title: input.chatTitle } : { id: input.fromId, type: "private", first_name: input.from };
      state.queue.push({ update_id: state.nextUpdate++, message: { message_id: state.nextMessage++, date: Math.floor(Date.now() / 1000), from: { id: input.fromId, is_bot: false, first_name: input.from }, chat, text: input.text } });
      for (const wake of Array.from(state.waiters)) wake();
    },
    sent: (token: string) => calls.filter((call) => call.token === token && call.method === "sendMessage"),
    close: () => new Promise<void>((resolve) => { for (const state of bots.values()) for (const wake of Array.from(state.waiters)) wake(); server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
export type FakeTelegram = Awaited<ReturnType<typeof startTelegram>>;
