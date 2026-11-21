import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../store.ts";
import { startFakeTelegram, type FakeTelegram } from "../testing/fake-telegram.ts";
import { createMessengerHost, messengerSendAs, type MessengerHost } from "./host.ts";
import { markdownToTelegramHtml } from "./text.ts";

const TOKEN = "7000001:AAH" + "x".repeat(32);
const OWNER = { id: 501, first_name: "Sid", username: "sid" };
const STRANGER = { id: 777, first_name: "Mallory" };
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

interface Sent { botId: string; threadId: string; text: string; sendId: string; outside: boolean; person: { name: string } }

async function fixture(options: { dataDir?: string; fake?: FakeTelegram; hookBase?: string } = {}) {
  const fake = options.fake ?? await startFakeTelegram({ token: TOKEN });
  if (!options.fake) cleanups.push(() => fake.close());
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "dusk-messengers-"));
  if (!options.dataDir) cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const keyValue = "k".repeat(64);
  const threads = new Map<string, Message[]>();
  const listeners = new Set<(change: { type: string; threadId?: string; botId?: string }) => void>();
  const sent: Sent[] = [];
  const answers: Array<{ threadId: string; requestId: string; reply: { behavior: string; message?: string } }> = [];
  let threadCount = 0;
  const change = (threadId: string) => { for (const listener of listeners) listener({ type: "message", threadId }); };
  const host: MessengerHost = createMessengerHost({
    dataDir, key: { get: () => keyValue, peek: () => keyValue },
    env: { DUSK_TELEGRAM_API_URL: fake.origin, DUSK_TELEGRAM_POLL_SECONDS: "1" },
    bot: (id) => (id === "bot-nova" ? { id, name: "Nova" } : null),
    onStoreChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    messages: (threadId) => threads.get(threadId) ?? [],
    createThread: (_botId, title) => { const id = `thread-${++threadCount}`; threads.set(id, []); titles.set(id, title); return id; },
    threadExists: (_botId, threadId) => threads.has(threadId),
    saveAttachment: async (_bytes, name, mime) => ({ path: `/attachments/${name}`, kind: mime.startsWith("image/") ? "image" : "file", name }),
    readAttachment: (path) => ({ bytes: Buffer.from("png-bytes"), mime: "image/png", name: path.split("/").pop()! }),
    send: async (input) => {
      sent.push(input);
      threads.get(input.threadId)!.push({ id: `m-${sent.length}`, role: "user", kind: "text", text: input.text, sendId: input.sendId } as unknown as Message);
      change(input.threadId);
    },
    answerCard: async (threadId, requestId, reply) => {
      answers.push({ threadId, requestId, reply });
      const card = threads.get(threadId)?.find((m) => m.card?.requestId === requestId)?.card;
      if (card) card.answered = reply.behavior;
      change(threadId);
      return { ok: true };
    },
    hookBase: () => options.hookBase ?? null,
    settleMs: 10,
    log: () => {},
  });
  const titles = new Map<string, string>();
  cleanups.push(() => host.stop());
  host.start();
  const reply = (threadId: string, text: string, extra: Partial<Message> = {}) => {
    threads.get(threadId)!.push({ id: `r-${randomBytes(4).toString("hex")}`, role: "bot", kind: "text", text, turnTerminal: true, ...extra } as unknown as Message);
    change(threadId);
  };
  const card = (threadId: string, card: Record<string, unknown>) => {
    const message = { id: `c-${randomBytes(4).toString("hex")}`, role: "bot", kind: "text", text: "", card: { subtitle: "", options: [], ...card } } as unknown as Message;
    threads.get(threadId)!.push(message);
    change(threadId);
    return message;
  };
  return { fake, host, sent, threads, titles, reply, dataDir, answers, card, change };
}

async function claimed() {
  const f = await fixture();
  const status = await f.host.connect("bot-nova", "telegram", TOKEN);
  f.fake.message({ from: OWNER, text: `/start ${status.pairCode}` });
  await until(() => f.fake.sent().find((call) => String(call.params.text).startsWith("Connected.")));
  return { ...f, status };
}

describe("Telegram chat channel", () => {
  it("connects with a token, pairs the owner through the start link and refuses a stranger", async () => {
    const f = await fixture();
    const status = await f.host.connect("bot-nova", "telegram", TOKEN);
    expect(status).toMatchObject({ state: "connecting", handle: "@nova_test_bot", openUrl: "https://t.me/nova_test_bot" });
    expect(status.pairUrl).toBe(`https://t.me/nova_test_bot?start=${status.pairCode}`);

    f.fake.message({ from: STRANGER, text: "hello?" });
    await until(() => f.fake.sent().find((call) => /private/.test(String(call.params.text))));
    expect(f.sent).toHaveLength(0);

    f.fake.message({ from: OWNER, text: `/start ${status.pairCode}` });
    await until(() => f.fake.sent().find((call) => String(call.params.text).startsWith("Connected.")));
    const after = f.host.status("bot-nova").platforms[0]!;
    expect(after).toMatchObject({ state: "online", delivery: "polling", owner: { id: "501", kind: "person", name: "Sid" } });
    expect(after.pairCode).toBeUndefined();
    expect(after.knocked).toEqual([expect.objectContaining({ id: "777", kind: "person", name: "Mallory" })]);
  });

  it("turns the owner's message into a turn and posts the bot's reply, with files both ways", async () => {
    const f = await claimed();
    f.fake.addFile("ph1", Buffer.from("jpeg"), "image/jpeg");
    f.fake.message({ from: OWNER, caption: "what is this?", photo: [{ file_id: "small" }, { file_id: "ph1", file_size: 4 }] });
    const turn = await until(() => f.sent[0]);
    expect(turn).toMatchObject({ botId: "bot-nova", outside: false, person: { name: "Sid" } });
    expect(turn.text).toContain("what is this?");
    expect(turn.text).toContain('<attached-image path="/attachments/photo.jpg"');
    expect(f.titles.get(turn.threadId)).toBe("Telegram · @sid");
    await until(() => f.fake.sent("sendChatAction").length);

    f.reply(turn.threadId, "It's a **cat**.", { attachments: [{ kind: "image", path: "/attachments/cat.png", mime: "image/png" }] } as Partial<Message>);
    const answer = await until(() => f.fake.sent().find((call) => String(call.params.text).includes("cat")));
    expect(answer.params).toMatchObject({ chat_id: "501", parse_mode: "HTML", text: "It's a <b>cat</b>." });
    const photo = await until(() => f.fake.sent("sendPhoto")[0]);
    expect(photo.file).toMatchObject({ field: "photo", name: "cat.png" });

    f.fake.message({ from: OWNER, text: "and now?" });
    const second = await until(() => f.sent[1]);
    expect(second.threadId).toBe(turn.threadId);
    f.fake.message({ from: OWNER, text: "/new" });
    await until(() => f.fake.sent().find((call) => call.params.text === "Started a new conversation."));
    f.fake.message({ from: OWNER, text: "fresh" });
    expect((await until(() => f.sent[2])).threadId).not.toBe(turn.threadId);
  });

  it("answers in a group only when mentioned, as outside work, and lets a group in when the owner adds the bot", async () => {
    const f = await claimed();
    const group = { id: -100200, type: "supergroup", title: "Team" };
    f.fake.added({ from: OWNER, chat: group });
    await until(() => f.fake.sent().find((call) => call.params.chat_id === "-100200"));
    expect(f.host.status("bot-nova").platforms[0]!.allowed).toEqual([{ id: "-100200", kind: "chat", name: "Team" }]);

    f.fake.message({ from: STRANGER, chat: group, text: "just chatting" });
    const mention = f.fake.message({ from: STRANGER, chat: group, text: "@nova_test_bot summarize", entities: [{ type: "mention", offset: 0, length: 14 }] });
    const turn = await until(() => f.sent[0]);
    expect(f.sent).toHaveLength(1);
    expect(turn).toMatchObject({ text: "summarize", outside: true, person: { name: "Mallory" } });
    expect(f.titles.get(turn.threadId)).toBe("Telegram · Team");
    f.reply(turn.threadId, "Done.");
    const answer = await until(() => f.fake.sent().find((call) => call.params.text === "Done."));
    expect(answer.params.reply_parameters).toEqual({ message_id: (mention.message as { message_id: number }).message_id, allow_sending_without_reply: true });
  });

  it("lets a turned-away person in by name through the tool, and refuses the tool from a Telegram conversation", async () => {
    const f = await claimed();
    f.fake.message({ from: STRANGER, text: "let me in" });
    await until(() => f.host.status("bot-nova").platforms[0]!.knocked.length);
    const call = async (threadId: string, body: unknown) => {
      let answer: { status: number; body: Record<string, unknown> } | null = null;
      await f.host.internal({ method: "POST", path: "/api/internal/messengers", res: {} as never, botId: "bot-nova", threadId,
        json: ((_res: unknown, status: number, value: Record<string, unknown>) => { answer = { status, body: value }; }) as never, readBody: async () => body });
      return answer!;
    };
    expect(await call("app-thread", { action: "allow", platform: "telegram", who: "mallory" })).toMatchObject({ status: 200 });
    expect(f.host.status("bot-nova").platforms[0]!.allowed).toEqual([{ id: "777", kind: "person", name: "Mallory" }]);
    f.fake.message({ from: STRANGER, text: "thanks" });
    const turn = await until(() => f.sent[0]);
    expect(turn.outside).toBe(true);
    expect(await call(turn.threadId, { action: "disconnect", platform: "telegram" })).toMatchObject({ status: 403 });
  });

  it("does everything from chat: shows the claim link, who is in and who tried, lets in, removes and disconnects", async () => {
    const f = await fixture();
    f.threads.set("app-thread", [{ id: "u1", role: "user", kind: "text", text: TOKEN } as unknown as Message]);
    const call = async (body: unknown) => {
      let answer: { status: number; body: Record<string, unknown> } | null = null;
      await f.host.internal({ method: "POST", path: "/api/internal/messengers", res: {} as never, botId: "bot-nova", threadId: "app-thread",
        json: ((_res: unknown, status: number, value: Record<string, unknown>) => { answer = { status, body: value }; }) as never, readBody: async () => body });
      return answer!;
    };
    const connected = await call({ action: "connect", platform: "telegram" });
    const code = /start=([A-Z2-9]+)/.exec(String(connected.body.text))![1]!;
    expect(String((await call({ action: "status" })).body.text)).toContain(`https://t.me/nova_test_bot?start=${code}`);
    f.fake.message({ from: OWNER, text: `/start ${code}` });
    f.fake.message({ from: STRANGER, text: "hi" });
    await until(() => f.host.status("bot-nova").platforms[0]!.knocked.length);
    const status = String((await call({ action: "status" })).body.text);
    expect(status).toContain("Owner: Sid");
    expect(status).toContain("Turned away recently: Mallory (person, 777)");
    expect((await call({ action: "allow", platform: "telegram", who: "Mallory" })).status).toBe(200);
    expect(String((await call({ action: "status" })).body.text)).toContain("Also let in: Mallory (person, 777)");
    expect((await call({ action: "remove_access", platform: "telegram", who: "mallory" })).status).toBe(200);
    expect(f.host.status("bot-nova").platforms[0]!.allowed).toEqual([]);
    expect((await call({ action: "disconnect", platform: "telegram" })).status).toBe(200);
    expect(String((await call({ action: "status" })).body.text)).toContain("Telegram: not connected.");
    expect(f.fake.webhook().url).toBe("");
  });

  it("connects from the token the person pasted in chat and keeps the token out of the status", async () => {
    const f = await fixture();
    f.threads.set("app-thread", [{ id: "u1", role: "user", kind: "text", text: `here you go ${TOKEN} thanks` } as unknown as Message]);
    let answer: { status: number; body: Record<string, unknown> } | null = null;
    await f.host.internal({ method: "POST", path: "/api/internal/messengers", res: {} as never, botId: "bot-nova", threadId: "app-thread",
      json: ((_res: unknown, status: number, value: Record<string, unknown>) => { answer = { status, body: value }; }) as never,
      readBody: async () => ({ action: "connect", platform: "telegram" }) });
    expect(answer!.status).toBe(200);
    expect(String(answer!.body.text)).toContain("https://t.me/nova_test_bot?start=");
    expect(String(answer!.body.text)).not.toContain(TOKEN);
    expect(JSON.stringify(f.host.status("bot-nova"))).not.toContain(TOKEN);
    expect(f.host.scrub(`token ${TOKEN}`)).not.toContain(TOKEN);
  });

  it("picks up where it left off after a restart", async () => {
    const f = await claimed();
    f.fake.message({ from: OWNER, text: "first" });
    const turn = await until(() => f.sent[0]);
    await f.host.stop();
    const again = await fixture({ dataDir: f.dataDir, fake: f.fake });
    again.threads.set(turn.threadId, f.threads.get(turn.threadId)!);
    f.fake.message({ from: OWNER, text: "second" });
    const next = await until(() => again.sent[0]);
    expect(next.text).toBe("second");
    expect(next.threadId).toBe(turn.threadId);
    expect(next.outside).toBe(false);
  });

  it("on a Cloud home takes updates by webhook through the public door, checking Telegram's secret", async () => {
    const fake = await startFakeTelegram({ token: TOKEN });
    cleanups.push(() => fake.close());
    let door: Server | null = null;
    const f = await fixture({ fake, hookBase: "https://home.example.test" });
    door = createServer((req, res) => { void f.host.door(req, res, new URL(req.url ?? "/", "http://x")).then((done) => { if (!done) { res.writeHead(404); res.end(); } }); });
    await new Promise<void>((resolve) => door!.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => door!.close(() => resolve())));
    const status = await f.host.connect("bot-nova", "telegram", TOKEN);
    expect(status).toMatchObject({ state: "online", delivery: "webhook" });
    expect(fake.webhook().url).toBe("https://home.example.test/hooks/telegram/bot-nova");
    const base = `http://127.0.0.1:${(door.address() as AddressInfo).port}/hooks/telegram/bot-nova`;
    const post = (update: unknown, secret: string) => fetch(base, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(update) });
    const claim = { update_id: 1, message: { message_id: 5, from: { ...OWNER, is_bot: false }, chat: { id: OWNER.id, type: "private" }, text: `/start ${status.pairCode}` } };
    expect((await post(claim, "wrong")).status).toBe(401);
    expect((await post(claim, fake.webhook().secret)).status).toBe(200);
    expect(f.host.status("bot-nova").platforms[0]!.owner?.id).toBe("501");
    const hello = { update_id: 2, message: { message_id: 6, from: { ...OWNER, is_bot: false }, chat: { id: OWNER.id, type: "private" }, text: "hi from the phone" } };
    expect((await post(hello, fake.webhook().secret)).status).toBe(200);
    expect(f.sent[0]).toMatchObject({ text: "hi from the phone", outside: false });
    expect(fake.sent("getUpdates")).toHaveLength(0);
  });

  it("a bot moved in with one person let in there needs no pairing: that person is its owner", async () => {
    const f = await fixture();
    const status = await f.host.connect("bot-nova", "telegram", TOKEN, { allowed: [{ id: "501", kind: "person" }] });
    expect(status).toMatchObject({ owner: { id: "501" }, allowed: [] });
    expect(status.pairCode).toBeUndefined();
    f.fake.message({ from: OWNER, text: "still me" });
    expect(await until(() => f.sent[0])).toMatchObject({ text: "still me", outside: false });
  });

  it("sends the owner's own direct chat as the owner at the keyboard, and anyone else as a relayed outsider", () => {
    expect(messengerSendAs(false, "Sid")).toEqual({ trigger: { kind: "owner" }, personPresent: true });
    expect(messengerSendAs(true, "Mallory")).toEqual({ sender: { name: "Mallory" }, trigger: { kind: "user", label: "Mallory" }, personPresent: false, relayed: true });
  });

  it("writes markdown as Telegram HTML with everything else escaped", () => {
    expect(markdownToTelegramHtml("# Plan\n- **a** <b> & `x<y`\n```\nif (a < b) {}\n```\n[site](https://x.test/?a=1&b=2)"))
      .toBe('<b>Plan</b>\n• <b>a</b> &lt;b&gt; &amp; <code>x&lt;y</code>\n<pre><code>if (a &lt; b) {}</code></pre>\n<a href="https://x.test/?a=1&amp;b=2">site</a>');
  });

  it("puts an approval in the owner's own chat as buttons: only the owner's tap answers it, and the app's answer clears them", async () => {
    const f = await claimed();
    f.fake.message({ from: OWNER, text: "clean the folder" });
    const turn = await until(() => f.sent[0]);
    f.card(turn.threadId, { requestId: "req-1", title: "Run a command", subtitle: "rm -rf build", tool: "Bash" });
    const offer = await until(() => f.fake.sent().find((call) => call.params.reply_markup));
    const keyboard = (offer.params.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard.flat();
    expect(keyboard.map((button) => button.text)).toEqual(["Allow", "Deny"]);
    expect(keyboard[0]!.callback_data).not.toContain("req-1");

    f.fake.press({ from: STRANGER, chatId: OWNER.id, messageId: 1, data: keyboard[0]!.callback_data });
    await until(() => f.fake.sent("answerCallbackQuery").find((call) => /Only the bot's owner/.test(String(call.params.text))));
    expect(f.answers).toHaveLength(0);

    f.fake.press({ from: OWNER, chatId: OWNER.id, messageId: 1, data: keyboard[0]!.callback_data });
    await until(() => f.answers[0]);
    expect(f.answers[0]).toEqual({ threadId: turn.threadId, requestId: "req-1", reply: { behavior: "allow" } });
    const settled = await until(() => f.fake.sent("editMessageText").find((call) => /You chose: Allow/.test(String(call.params.text))));
    expect(settled.params.reply_markup).toEqual({ inline_keyboard: [] });

    const second = f.card(turn.threadId, { requestId: "req-2", title: "Pick a size", options: ["Small", "Large"] });
    await until(() => f.fake.sent().filter((call) => call.params.reply_markup).length === 2);
    second.card!.answered = "Large";
    f.change(turn.threadId);
    await until(() => f.fake.sent("editMessageText").find((call) => /Answered in dusk bot: Large/.test(String(call.params.text))));
    expect(f.answers).toHaveLength(1);
  });

  it("keeps a purchase or review card for dusk bot: no buttons, just the notice", async () => {
    const f = await claimed();
    f.fake.message({ from: OWNER, text: "buy it" });
    const turn = await until(() => f.sent[0]);
    f.card(turn.threadId, { requestId: "req-3", title: "Buy the plan", tool: "Bash", purchase: { amount: "$5" } });
    await until(() => f.fake.sent().find((call) => /I need you in dusk bot/.test(String(call.params.text))));
    expect(f.fake.sent().some((call) => call.params.reply_markup)).toBe(false);
  });
});
