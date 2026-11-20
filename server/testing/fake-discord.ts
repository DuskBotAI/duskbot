import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export interface FakeDiscordCall { method: string; path: string; body: Record<string, unknown>; file?: { name: string; bytes: number } }

/** A loopback Discord: the REST calls the bot makes, and a gateway that says hello, takes identify and dispatches. */
export async function startFakeDiscord(options: { token: string; bot?: { id: string; username: string } }) {
  const bot = options.bot ?? { id: "900000000000000001", username: "nova" };
  const calls: FakeDiscordCall[] = [];
  const identifies: Array<Record<string, unknown>> = [];
  const sockets = new Set<WebSocket>();
  let seq = 0, nextId = 1000n;

  async function read(req: IncomingMessage): Promise<{ body: Record<string, unknown>; file?: FakeDiscordCall["file"] }> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks), type = req.headers["content-type"] ?? "";
    if (type.startsWith("multipart/form-data")) {
      const form = await new Response(raw, { headers: { "content-type": type } }).formData();
      const file = form.get("files[0]");
      return { body: JSON.parse(String(form.get("payload_json") ?? "{}")) as Record<string, unknown>, ...(file && typeof file !== "string" ? { file: { name: file.name, bytes: file.size } } : {}) };
    }
    return { body: raw.length ? JSON.parse(raw.toString("utf8")) as Record<string, unknown> : {} };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const reply = (status: number, value?: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(value === undefined ? "" : JSON.stringify(value)); };
    if (url.pathname.startsWith("/cdn/")) { res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.from("png")); return; }
    if (req.headers.authorization !== `Bot ${options.token}`) return reply(401, { message: "401: Unauthorized", code: 0 });
    const path = url.pathname.replace(/^\/api\/v10/, "");
    const { body, file } = await read(req);
    calls.push({ method: req.method ?? "GET", path, body, ...(file ? { file } : {}) });
    if (path === "/users/@me") return reply(200, { id: bot.id, username: bot.username, bot: true });
    if (path === "/oauth2/applications/@me") return reply(200, { id: bot.id });
    if (path === "/gateway/bot") return reply(200, { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/gateway` });
    if (/^\/channels\/\d+\/typing$/.test(path)) return reply(204);
    if (/^\/channels\/\d+\/messages$/.test(path)) return reply(200, { id: String(nextId++), ...body });
    if (req.method === "PATCH" && /^\/channels\/\d+\/messages\/\d+$/.test(path)) return reply(200, { id: path.split("/").pop(), ...body });
    if (/^\/interactions\/\d+\/[\w-]+\/callback$/.test(path)) return reply(204);
    if (/^\/webhooks\/\d+\/[\w-]+$/.test(path)) return reply(200, { id: String(nextId++), ...body });
    const channel = /^\/channels\/(\d+)$/.exec(path);
    if (channel) return reply(200, { id: channel[1], name: "general" });
    return reply(404, { message: "Unknown", code: 0 });
  });
  const gateway = new WebSocketServer({ server, path: "/gateway" });
  gateway.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }));
    socket.on("message", (raw) => {
      const payload = JSON.parse(String(raw)) as { op: number; d: Record<string, unknown> };
      if (payload.op === 1) socket.send(JSON.stringify({ op: 11 }));
      if (payload.op === 2) {
        identifies.push(payload.d);
        if (payload.d.token !== options.token) { socket.close(4004, "Authentication failed."); return; }
        socket.send(JSON.stringify({ op: 0, s: ++seq, t: "READY", d: { session_id: "s1", resume_gateway_url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/gateway`, user: { id: bot.id, username: bot.username, bot: true } } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin, bot, calls, identifies,
    connected: () => sockets.size > 0,
    message(input: { author: { id: string; username: string }; channelId: string; guildId?: string; content: string; mentionsBot?: boolean; attachments?: Array<{ filename: string; content_type: string; size: number }> }) {
      const id = String(nextId++);
      const d = {
        id, type: 0, channel_id: input.channelId, ...(input.guildId ? { guild_id: input.guildId } : {}), author: { ...input.author, bot: false },
        content: input.content, mentions: input.mentionsBot ? [{ id: bot.id }] : [],
        attachments: (input.attachments ?? []).map((one, index) => ({ id: `${id}${index}`, url: `${origin}/cdn/${one.filename}`, ...one })),
      };
      for (const socket of sockets) socket.send(JSON.stringify({ op: 0, s: ++seq, t: "MESSAGE_CREATE", d }));
      return d;
    },
    /** A press on a button of the bot's message `messageId`, as an INTERACTION_CREATE in a DM. */
    press(input: { user: { id: string; username: string }; channelId: string; messageId: string; customId: string }) {
      const d = { id: String(nextId++), application_id: bot.id, type: 3, token: `tok-${nextId}`, channel_id: input.channelId, user: input.user,
        message: { id: input.messageId }, data: { component_type: 2, custom_id: input.customId } };
      for (const socket of sockets) socket.send(JSON.stringify({ op: 0, s: ++seq, t: "INTERACTION_CREATE", d }));
      return d;
    },
    posted: () => calls.filter((call) => call.method === "POST" && call.path.endsWith("/messages")),
    close: () => new Promise<void>((resolve) => { for (const socket of sockets) socket.terminate(); gateway.close(); server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
