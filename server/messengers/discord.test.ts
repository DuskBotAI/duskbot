import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../store.ts";
import { startFakeDiscord } from "../testing/fake-discord.ts";
import { createMessengerHost } from "./host.ts";

const TOKEN = `${"M".repeat(26)}.Gabcde.${"z".repeat(38)}`;
const OWNER = { id: "111111111111111111", username: "sid" };
const STRANGER = { id: "222222222222222222", username: "mallory" };
const cleanups: Array<() => unknown> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function until<T>(read: () => T | undefined | null | false, ms = 8_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function fixture() {
  const fake = await startFakeDiscord({ token: TOKEN });
  const dataDir = mkdtempSync(join(tmpdir(), "dusk-discord-"));
  cleanups.push(() => fake.close(), () => rmSync(dataDir, { recursive: true, force: true }));
  const threads = new Map<string, Message[]>();
  const titles = new Map<string, string>();
  const listeners = new Set<(change: { type: string; threadId?: string }) => void>();
  const sent: Array<{ threadId: string; text: string; outside: boolean }> = [];
  const answers: Array<{ threadId: string; requestId: string; behavior: string }> = [];
  const change = (threadId: string) => { for (const listener of listeners) listener({ type: "message", threadId }); };
  const key = "d".repeat(64);
  const host = createMessengerHost({
    dataDir, key: { get: () => key, peek: () => key }, env: { DUSK_DISCORD_API_URL: fake.origin },
    bot: (id) => (id === "bot-nova" ? { id, name: "Nova" } : null),
    onStoreChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    messages: (threadId) => threads.get(threadId) ?? [],
    createThread: (_botId, title) => { const id = `t${threads.size + 1}`; threads.set(id, []); titles.set(id, title); return id; },
    threadExists: (_botId, threadId) => threads.has(threadId),
    saveAttachment: async (_bytes, name, mime) => ({ path: `/attachments/${name}`, kind: mime.startsWith("image/") ? "image" : "file", name }),
    readAttachment: () => ({ bytes: Buffer.from("report"), mime: "application/pdf", name: "report.pdf" }),
    send: async (input) => {
      sent.push(input);
      threads.get(input.threadId)!.push({ id: `u${sent.length}`, role: "user", kind: "text", text: input.text, sendId: input.sendId } as unknown as Message);
      change(input.threadId);
    },
    answerCard: async (threadId, requestId, reply) => {
      answers.push({ threadId, requestId, behavior: reply.behavior });
      const card = threads.get(threadId)?.find((m) => m.card?.requestId === requestId)?.card;
      if (card) card.answered = reply.behavior;
      change(threadId);
      return { ok: true };
    },
    hookBase: () => null, settleMs: 10, log: () => {},
  });
  cleanups.push(() => host.stop());
  host.start();
  const reply = (threadId: string, text: string, extra: Partial<Message> = {}) => {
    threads.get(threadId)!.push({ id: `r${Math.random()}`, role: "bot", kind: "text", text, turnTerminal: true, ...extra } as unknown as Message);
    change(threadId);
  };
  const card = (threadId: string, card: Record<string, unknown>) => {
    threads.get(threadId)!.push({ id: `c${Math.random()}`, role: "bot", kind: "text", text: "", card: { subtitle: "", options: [], ...card } } as unknown as Message);
    change(threadId);
  };
  return { fake, host, sent, titles, reply, answers, card };
}

describe("Discord chat channel", () => {
  it("connects over the gateway without the privileged content intent, pairs by DM code and answers with files", async () => {
    const f = await fixture();
    const status = await f.host.connect("bot-nova", "discord", TOKEN);
    expect(status.pairCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(status.openUrl).toContain("client_id=900000000000000001");
    await until(() => f.host.status("bot-nova").platforms[1]!.state === "online");
    expect(f.fake.identifies[0]).toMatchObject({ intents: 1 | (1 << 9) | (1 << 10) | (1 << 12) | (1 << 13) });

    f.fake.message({ author: STRANGER, channelId: "300", content: "hi" });
    await until(() => f.fake.posted().find((call) => /private/.test(String(call.body.content))));
    f.fake.message({ author: OWNER, channelId: "301", content: status.pairCode! });
    await until(() => f.fake.posted().find((call) => String(call.body.content).startsWith("Connected.")));

    f.fake.message({ author: OWNER, channelId: "301", content: "look at this", attachments: [{ filename: "shot.png", content_type: "image/png", size: 3 }] });
    const turn = await until(() => f.sent[0]);
    expect(turn.outside).toBe(false);
    expect(turn.text).toContain('<attached-image path="/attachments/shot.png"');
    expect(f.titles.get(turn.threadId)).toBe("Discord · @sid");
    await until(() => f.fake.calls.find((call) => call.path === "/channels/301/typing"));

    f.reply(turn.threadId, "Here is the report.", { attachments: [{ kind: "file", path: "/attachments/report.pdf", mime: "application/pdf", name: "report.pdf" }] } as Partial<Message>);
    await until(() => f.fake.posted().find((call) => call.body.content === "Here is the report."));
    const upload = await until(() => f.fake.posted().find((call) => call.file));
    expect(upload.file).toEqual({ name: "report.pdf", bytes: 6 });
  });

  it("answers in a server channel only when mentioned by someone let in, replying to that message", async () => {
    const f = await fixture();
    const status = await f.host.connect("bot-nova", "discord", TOKEN);
    await until(() => f.host.status("bot-nova").platforms[1]!.state === "online");
    f.fake.message({ author: OWNER, channelId: "301", content: status.pairCode! });
    await until(() => f.host.status("bot-nova").platforms[1]!.owner);

    f.fake.message({ author: OWNER, channelId: "400", guildId: "500", content: "no mention here" });
    f.fake.message({ author: STRANGER, channelId: "400", guildId: "500", content: "<@900000000000000001> do it", mentionsBot: true });
    const mention = f.fake.message({ author: OWNER, channelId: "400", guildId: "500", content: "<@900000000000000001> plan the week", mentionsBot: true });
    const turn = await until(() => f.sent[0]);
    expect(f.sent).toHaveLength(1);
    expect(turn).toMatchObject({ text: "plan the week", outside: true });
    expect(f.titles.get(turn.threadId)).toBe("Discord · #general");
    expect(f.host.status("bot-nova").platforms[1]!.knocked).toEqual([expect.objectContaining({ id: "400", kind: "chat" })]);
    f.reply(turn.threadId, "Planned.");
    const answer = await until(() => f.fake.posted().find((call) => call.body.content === "Planned."));
    expect(answer.body.message_reference).toEqual({ message_id: mention.id, fail_if_not_exists: false });
    expect(answer.body.allowed_mentions).toEqual({ parse: [] });
  });

  it("refuses a token Discord does not accept", async () => {
    const f = await fixture();
    await expect(f.host.connect("bot-nova", "discord", `${"A".repeat(26)}.Gabcde.${"z".repeat(38)}`)).rejects.toThrow(/didn't accept/);
    expect(f.host.status("bot-nova").platforms[1]!.state).toBe("not_connected");
  });

  it("puts an approval in the owner's DM as buttons, defers each press and lets only the owner answer", async () => {
    const f = await fixture();
    const status = await f.host.connect("bot-nova", "discord", TOKEN);
    await until(() => f.host.status("bot-nova").platforms[1]!.state === "online");
    f.fake.message({ author: OWNER, channelId: "301", content: status.pairCode! });
    await until(() => f.host.status("bot-nova").platforms[1]!.owner);
    f.fake.message({ author: OWNER, channelId: "301", content: "deploy it" });
    const turn = await until(() => f.sent[0]);
    f.card(turn.threadId, { requestId: "req-1", title: "Run a command", subtitle: "deploy.sh", tool: "Bash" });
    const offer = await until(() => f.fake.posted().find((call) => call.body.components));
    const buttons = (offer.body.components as Array<{ components: Array<{ label: string; custom_id: string }> }>).flatMap((row) => row.components);
    expect(buttons.map((button) => button.label)).toEqual(["Allow", "Deny"]);
    expect(buttons[0]!.custom_id).not.toContain("req-1");

    f.fake.press({ user: STRANGER, channelId: "301", messageId: "1", customId: buttons[0]!.custom_id });
    await until(() => f.fake.calls.find((call) => call.path.startsWith("/webhooks/") && /Only the bot's owner/.test(String(call.body.content))));
    expect(f.answers).toHaveLength(0);

    f.fake.press({ user: OWNER, channelId: "301", messageId: "1", customId: buttons[1]!.custom_id });
    await until(() => f.answers[0]);
    expect(f.answers[0]).toEqual({ threadId: turn.threadId, requestId: "req-1", behavior: "deny" });
    expect(f.fake.calls.filter((call) => call.path.endsWith("/callback")).map((call) => call.body)).toEqual([{ type: 6 }, { type: 6 }]);
    const edit = await until(() => f.fake.calls.find((call) => call.method === "PATCH" && /You chose: Deny/.test(String(call.body.content))));
    expect(edit.body.components).toEqual([]);
  });
});
