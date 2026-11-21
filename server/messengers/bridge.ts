import { createHash, randomBytes } from "node:crypto";
import { MESSENGER_LABELS, type MessengerPlatform } from "../../shared/messengers.ts";
import { isErrorDump } from "../../shared/failed-turn.ts";
import { requestNeedsInput } from "../guarded-requests.ts";
import type { Message } from "../store.ts";
import type { MessengerLink } from "./secrets.ts";
import { cardChoices, cardText, type CardChoice } from "./cards.ts";
import type { MessengerOffer, MessengerPending, MessengerState } from "./state.ts";

export interface MessengerPerson { id: string; name: string; handle?: string }
export interface InboundFile { name: string; mime?: string; size?: number; fetch(): Promise<{ bytes: Buffer; mime: string }> }
export interface InboundMessage {
  platform: MessengerPlatform;
  botId: string;
  chatId: string;
  chatKind: "dm" | "group";
  chatTitle?: string;
  messageId: string;
  sender: MessengerPerson;
  text: string;
  files: InboundFile[];
  /** A direct message, or a group message that mentions the bot, replies to it or is a command for it. */
  addressed: boolean;
}
export interface OutboundFile { bytes: Buffer; mime: string; name: string; kind: "image" | "file" | "audio" }
/** A tap on one of a card's buttons: Telegram's callback query, or Discord's interaction (its id and token). */
export interface ChoiceAck { id: string; token?: string; appId?: string }
export interface InboundChoice { platform: MessengerPlatform; botId: string; chatId: string; senderId: string; data: string; sentId?: string; ack: ChoiceAck }
export interface MessengerTransport {
  sendText(botId: string, chatId: string, text: string, replyTo?: string): Promise<void>;
  /** A message with one button per choice; resolves to the sent message's id. */
  sendChoices(botId: string, chatId: string, text: string, buttons: Array<{ label: string; data: string }>): Promise<string | null>;
  /** Takes the buttons off a sent card and says what happened; with `ack`, also answers the tap (a short toast on Telegram). */
  settleChoices(botId: string, chatId: string, sentId: string | undefined, note: string, ack?: ChoiceAck & { toast?: string }): Promise<void>;
  sendFile(botId: string, chatId: string, file: OutboundFile, replyTo?: string): Promise<void>;
  typing(botId: string, chatId: string): Promise<void>;
  typingEveryMs: number;
}

export interface MessengerBridgeDeps {
  state: MessengerState;
  transport(platform: MessengerPlatform): MessengerTransport | null;
  link(botId: string, platform: MessengerPlatform): MessengerLink | null;
  /** The pairing code was right: this person owns the bot's chat-app account from now on. */
  claim(botId: string, platform: MessengerPlatform, owner: MessengerPerson): void;
  /** A wrong pairing code; the code is dropped after too many. */
  pairMiss(botId: string, platform: MessengerPlatform): void;
  bot(botId: string): { id: string; name: string } | null;
  createThread(botId: string, title: string): string | null;
  threadExists(botId: string, threadId: string): boolean;
  /** Resolves once the message is accepted (started, steered or queued). `outside`: anyone but the owner in a direct
   * chat, so the turn runs as outside work. */
  send(input: { botId: string; threadId: string; text: string; sendId: string; person: MessengerPerson; outside: boolean; platform: MessengerPlatform }): Promise<void>;
  messages(threadId: string): readonly Message[];
  /** Answers a card the way the owner's 👍 or a Live call does (the app's own checks on the card still apply). */
  answerCard(threadId: string, requestId: string, reply: CardChoice["reply"]): Promise<{ ok: true } | { ok: false; error: string }>;
  onChange(listener: (change: { type: string; threadId?: string }) => void): () => void;
  saveAttachment(bytes: Buffer, name: string, mime: string): Promise<{ path: string; kind: "image" | "file"; name: string } | null>;
  readAttachment(path: string): { bytes: Buffer; mime: string; name: string } | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  log?: (line: string) => void;
  maxFileBytes?: number;
  settleMs?: number;
  pendingTimeoutMs?: number;
}

const START_FAILED = "I couldn't start on that. Check dusk bot for details.";
const TURN_FAILED = "I couldn't finish that. Check dusk bot for details.";
const NEEDS_INPUT = "I need you in dusk bot to continue: an approval or a question is waiting there.";
const TELL_STRANGER_EVERY_MS = 6 * 60 * 60_000;

/** Security: words from a chat app never carry the app's own attachment markup, which would point the bot at a file. */
function defuse(text: string): string {
  return text.replace(/<(?=\s*\/?\s*(?:attached-(?:file|image)|pasted-text|slack-thread)\b)/gi, "&lt;");
}
function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("\t", "&#9;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;");
}

export function messengerSendId(platform: MessengerPlatform, botId: string, chatId: string, messageId: string): string {
  return `${platform === "telegram" ? "tg" : "dc"}-${createHash("sha256").update(`${botId}|${chatId}|${messageId}`).digest("hex").slice(0, 40)}`;
}

export function conversationKey(platform: MessengerPlatform, botId: string, chatId: string): string {
  return `${platform}:${botId}:${chatId}`;
}

export function personLetIn(link: Pick<MessengerLink, "owner" | "allowed">, personId: string): boolean {
  return link.owner?.id === personId || link.allowed.some((one) => one.kind === "person" && one.id === personId);
}

export function createMessengerBridge(deps: MessengerBridgeDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return { cancel: () => clearTimeout(timer) }; });
  const log = deps.log ?? (() => {});
  const seen = new Set<string>();
  const posted = new Set<string>();
  const settling = new Map<string, { cancel(): void }>();
  const typing = new Map<string, { cancel(): void }>();
  const inbound = new Map<string, Promise<void>>();
  const offering = new Set<string>();
  const generations = new Map<string, number>();
  let sweep: { cancel(): void } | undefined;
  let stopped = false;

  const generationKey = (botId: string, platform: MessengerPlatform) => `${platform}:${botId}`;
  const generation = (botId: string, platform: MessengerPlatform) => generations.get(generationKey(botId, platform)) ?? 0;

  async function say(platform: MessengerPlatform, botId: string, chatId: string, text: string, replyTo?: string): Promise<void> {
    const transport = deps.transport(platform);
    if (!transport) return;
    try { await transport.sendText(botId, chatId, text, replyTo); } catch { log(`${MESSENGER_LABELS[platform]} message could not be sent.`); }
  }

  function typingKey(p: Pick<MessengerPending, "platform" | "botId" | "chatId">) { return `${p.platform}:${p.botId}:${p.chatId}`; }
  function keepTyping(p: MessengerPending): void {
    const key = typingKey(p);
    if (typing.has(key) || stopped) return;
    const transport = deps.transport(p.platform);
    if (!transport) return;
    const tick = () => {
      if (stopped || !deps.state.pending().some((one) => typingKey(one) === key)) { typing.delete(key); return; }
      void transport.typing(p.botId, p.chatId).catch(() => {});
      typing.set(key, setTimer(tick, transport.typingEveryMs));
    };
    tick();
  }
  function stopTyping(p: MessengerPending): void {
    const key = typingKey(p);
    if (deps.state.pending().some((one) => typingKey(one) === key)) return;
    typing.get(key)?.cancel();
    typing.delete(key);
  }

  function drop(entries: readonly MessengerPending[]): void {
    deps.state.dropPending(entries.map((p) => p.sendId));
    for (const p of entries) stopTyping(p);
    if (!deps.state.pending().length) { sweep?.cancel(); sweep = undefined; }
  }

  function armSweep(): void {
    if (sweep || stopped || !deps.state.pending().length) return;
    sweep = setTimer(() => {
      sweep = undefined;
      drop(deps.state.pending().filter((p) => now() - p.startedAt >= (deps.pendingTimeoutMs ?? 30 * 60_000)));
      armSweep();
    }, 60_000);
  }

  async function post(p: MessengerPending, text: string, attachments: NonNullable<Message["attachments"]>): Promise<void> {
    const transport = deps.transport(p.platform);
    const started = generation(p.botId, p.platform);
    const active = () => !stopped && started === generation(p.botId, p.platform) && deps.link(p.botId, p.platform) !== null;
    if (!transport || !active()) return;
    const words = isErrorDump(text) ? TURN_FAILED : text.trim();
    if (words) {
      try { await transport.sendText(p.botId, p.chatId, words, p.replyTo); } catch { log(`${MESSENGER_LABELS[p.platform]} reply could not be posted.`); }
    }
    for (const attachment of attachments) {
      if (!active()) return;
      const file = deps.readAttachment(attachment.path);
      if (!file) continue;
      try {
        await transport.sendFile(p.botId, p.chatId, { bytes: file.bytes, mime: attachment.mime || file.mime, name: ("name" in attachment && attachment.name) || file.name,
          kind: attachment.kind === "image" ? "image" : attachment.kind === "audio" ? "audio" : "file" }, p.replyTo);
      } catch { log(`${MESSENGER_LABELS[p.platform]} file could not be posted.`); }
    }
  }

  function result(p: MessengerPending) {
    const messages = deps.messages(p.threadId);
    const index = messages.findIndex((m) => m.role === "user" && m.sendId === p.sendId);
    if (index < 0) return null;
    const user = messages[index]!;
    const later = messages.slice(index + 1);
    const terminal = later.filter((m) => m.role === "bot").findLast((m) => m.turnTerminal === true);
    const outcome = later.findLast((m) => m.turnSucceeded !== undefined);
    return { user, later, terminal, outcome, done: Boolean(terminal || outcome) };
  }

  async function finalize(threadId: string): Promise<void> {
    const groups = new Map<string, { p: MessengerPending; terminal?: Message; outcome?: Message; later: readonly Message[] }[]>();
    for (const p of deps.state.pending()) {
      if (p.threadId !== threadId) continue;
      const r = result(p);
      if (!r) continue;
      if (r.user.requestCancelled) { drop([p]); continue; }
      if (!r.done) continue;
      const key = `${p.platform}:${p.botId}:${threadId}:${r.terminal?.id ?? r.outcome!.id}`;
      groups.set(key, [...(groups.get(key) ?? []), { p, ...r }]);
    }
    for (const [key, group] of groups) {
      const newest = group.at(-1)!;
      drop(group.map((entry) => entry.p));
      if (posted.has(key)) continue;
      posted.add(key);
      if (posted.size > 2000) posted.delete(posted.values().next().value!);
      const { p, terminal, later } = newest;
      const end = terminal ? later.findIndex((m) => m.id === terminal.id) + 1 : later.length;
      const attachments = later.slice(0, end).filter((m) => m.role === "bot").flatMap((m) => m.attachments ?? []);
      const text = terminal ? terminal.text ?? "" : later.some((m) => m.turnSucceeded === false) ? TURN_FAILED : "";
      await post(p, text, attachments);
    }
  }

  function evaluate(threadId: string): void {
    if (stopped) return;
    for (const p of deps.state.pending()) {
      if (p.threadId !== threadId) continue;
      const r = result(p);
      if (!r) continue;
      if (r.user.requestCancelled) { drop([p]); continue; }
      // a question card outlives its turn, so cards are offered whether or not the turn is still running
      const offerable = p.owner ? r.later.filter((m) => cardChoices(m.card)) : [];
      for (const m of offerable) void offer(p, m);
      if (r.done) {
        if (!settling.has(threadId)) settling.set(threadId, setTimer(() => {
          settling.delete(threadId);
          void finalize(threadId).catch(() => log("A chat app reply could not be completed."));
        }, deps.settleMs ?? 300));
      } else {
        if (!p.notifiedInput && r.later.some((m) => requestNeedsInput(m) && !offerable.includes(m))) {
          deps.state.patchPending(p.sendId, { notifiedInput: true });
          void say(p.platform, p.botId, p.chatId, NEEDS_INPUT, p.replyTo);
        }
      }
    }
  }
  const unsubscribe = deps.onChange((change) => { if (change.threadId) { evaluate(change.threadId); settleStale(change.threadId); } });

  async function offer(p: MessengerPending, message: Message): Promise<void> {
    const key = `${p.threadId}:${message.id}`;
    const transport = deps.transport(p.platform), choices = cardChoices(message.card);
    if (!transport || !choices || offering.has(key) || deps.state.offers().some((one) => one.threadId === p.threadId && one.cardMessageId === message.id)) return;
    offering.add(key);
    const id = randomBytes(8).toString("base64url");
    const record: MessengerOffer = { id, botId: p.botId, platform: p.platform, chatId: p.chatId, threadId: p.threadId, requestId: message.card!.requestId!,
      cardMessageId: message.id, labels: choices.map((choice) => choice.label), at: now() };
    deps.state.addOffer(record);
    try {
      const sentId = await transport.sendChoices(p.botId, p.chatId, cardText(message.card!), choices.map((choice, index) => ({ label: choice.label, data: `dk:${id}:${index}` })));
      if (sentId) deps.state.patchOffer(id, { sentId });
    } catch {
      log(`${MESSENGER_LABELS[p.platform]} approval buttons could not be sent.`);
      deps.state.patchOffer(id, { settled: true });
      await say(p.platform, p.botId, p.chatId, NEEDS_INPUT);
    } finally { offering.delete(key); }
  }

  /** A card answered, dismissed or expired anywhere loses its buttons. */
  function settleStale(threadId: string): void {
    for (const one of deps.state.offers()) {
      if (one.threadId !== threadId || one.settled) continue;
      const card = deps.messages(threadId).find((m) => m.id === one.cardMessageId)?.card;
      if (card && cardChoices(card)) continue;
      deps.state.patchOffer(one.id, { settled: true });
      const words = card?.answered ? `Answered in dusk bot: ${card.answeredText ?? card.answered}.` : "This is no longer waiting.";
      void deps.transport(one.platform)?.settleChoices(one.botId, one.chatId, one.sentId, words).catch(() => {});
    }
  }

  async function choose(choice: InboundChoice): Promise<void> {
    const transport = deps.transport(choice.platform);
    if (!transport) return;
    const [, id, index] = /^dk:([\w-]{6,20}):(\d{1,2})$/.exec(choice.data) ?? [];
    const one = deps.state.offers().find((offer) => offer.id === id);
    const ack = (toast: string) => transport.settleChoices(choice.botId, choice.chatId, undefined, "", { ...choice.ack, toast }).catch(() => {});
    if (!one || one.botId !== choice.botId || one.platform !== choice.platform || one.chatId !== choice.chatId) { await ack("That choice is no longer open."); return; }
    const link = deps.link(choice.botId, choice.platform);
    if (!link?.owner || link.owner.id !== choice.senderId) { await ack("Only the bot's owner can answer this."); return; }
    const card = deps.messages(one.threadId).find((m) => m.id === one.cardMessageId)?.card;
    const choices = cardChoices(card);
    const picked = choices?.[Number(index)];
    if (one.settled || !choices || !picked || picked.label !== one.labels[Number(index)]) {
      deps.state.patchOffer(one.id, { settled: true });
      await transport.settleChoices(choice.botId, choice.chatId, one.sentId ?? choice.sentId, "This was already answered.", { ...choice.ack, toast: "Already answered." }).catch(() => {});
      return;
    }
    deps.state.patchOffer(one.id, { settled: true });
    let result: Awaited<ReturnType<MessengerBridgeDeps["answerCard"]>>;
    try { result = await deps.answerCard(one.threadId, one.requestId, picked.reply); }
    catch { result = { ok: false, error: "It could not be answered." }; }
    const text = card ? cardText(card) : "";
    await transport.settleChoices(choice.botId, choice.chatId, one.sentId ?? choice.sentId,
      result.ok ? `${text}\n\nYou chose: ${picked.label}` : `${text}\n\n${result.error}`, { ...choice.ack, toast: result.ok ? picked.label : result.error }).catch(() => {});
  }

  async function files(message: InboundMessage): Promise<string[]> {
    const notes: string[] = [], tags: string[] = [];
    const max = deps.maxFileBytes ?? 20 * 1024 * 1024;
    for (const file of message.files.slice(0, 10)) {
      const name = defuse(file.name.replace(/[\r\n]+/g, " ").slice(0, 200)) || "file";
      if (file.size !== undefined && file.size > max) { notes.push(`(${name} was too large to bring over, over ${Math.round(max / 1024 / 1024)} MB)`); continue; }
      try {
        const downloaded = await file.fetch();
        if (downloaded.bytes.byteLength > max) { notes.push(`(${name} was too large to bring over)`); continue; }
        const saved = await deps.saveAttachment(downloaded.bytes, name, file.mime || downloaded.mime);
        if (!saved) notes.push(`(${name} is a file type the bot can't open)`);
        else tags.push(`<attached-${saved.kind} path="${escapeAttribute(saved.path)}" name="${escapeAttribute(saved.name)}" />`);
      } catch { notes.push(`(${name} could not be downloaded)`); }
    }
    return [notes.join("\n"), tags.join("\n")].filter(Boolean);
  }

  function pairCodeIn(text: string): string | null {
    const match = /^\s*(?:\/start(?:@\w+)?\s+)?([A-Za-z0-9]{6,32})\s*$/.exec(text);
    return match ? match[1]!.toUpperCase() : null;
  }

  async function handle(message: InboundMessage): Promise<void> {
    const { platform, botId, chatId } = message;
    const link = deps.link(botId, platform);
    if (stopped || !link) return;
    const started = generation(botId, platform);
    const active = () => !stopped && started === generation(botId, platform);
    const sendId = messengerSendId(platform, botId, chatId, message.messageId);
    if (seen.has(sendId)) return;
    seen.add(sendId);
    if (seen.size > 4000) seen.delete(seen.values().next().value!);
    const botName = deps.bot(botId)?.name ?? "this bot";
    const text = message.text.trim();

    if (message.chatKind === "dm" && link.pairCode && !link.owner) {
      const code = pairCodeIn(text);
      if (code && code === link.pairCode.toUpperCase()) {
        deps.claim(botId, platform, message.sender);
        await say(platform, botId, chatId, `Connected. This chat now goes to ${botName} in dusk bot, and only you can talk to it here until you let others in.`);
        return;
      }
      if (code || /^\/start\b/.test(text)) deps.pairMiss(botId, platform);
    }

    const personIn = personLetIn(link, message.sender.id);
    const chatIn = message.chatKind === "group" && link.allowed.some((one) => one.kind === "chat" && one.id === chatId);
    if (message.chatKind === "group" && !message.addressed) return;
    if (!personIn && !chatIn) {
      const group = message.chatKind === "group";
      const told = deps.state.knock(
        { botId, platform, id: group ? chatId : message.sender.id, kind: group ? "chat" : "person", name: (group ? message.chatTitle : message.sender.name) || (group ? chatId : message.sender.id), at: now() },
        (last) => last === undefined || now() - last >= TELL_STRANGER_EVERY_MS,
      );
      if (told) await say(platform, botId, chatId, group
        ? `${botName} only answers here once its owner lets this group in from dusk bot.`
        : `${botName} is private. Its owner can let you in from dusk bot.`);
      return;
    }

    const key = conversationKey(platform, botId, chatId);
    const command = /^\/(\w+)(?:@\w+)?\s*$/.exec(text)?.[1]?.toLowerCase();
    if (command === "new" || command === "reset") {
      deps.state.dropConversation(key);
      await say(platform, botId, chatId, "Started a new conversation.");
      return;
    }
    if (command === "start" && !message.files.length) {
      await say(platform, botId, chatId, `Hi, this is ${botName}. Message me here any time. Send /new to start a fresh conversation.`);
      return;
    }

    const body = [defuse(text), ...await files(message)].filter(Boolean).join("\n\n");
    if (!body || !active()) return;
    let mapping = deps.state.conversation(key);
    if (!mapping || !deps.threadExists(botId, mapping.threadId)) {
      const label = MESSENGER_LABELS[platform];
      const where = message.chatKind === "dm" ? (message.sender.handle ? `@${message.sender.handle}` : message.sender.name) : message.chatTitle || "group";
      const threadId = deps.createThread(botId, `${label} · ${where}`);
      if (!threadId) { log(`${label} conversation could not be created.`); return; }
      mapping = { botId, platform, chatId, threadId, createdAt: now() };
      deps.state.setConversation(key, mapping);
    }
    const p: MessengerPending = {
      botId, platform, chatId, threadId: mapping.threadId, sendId, ...(message.chatKind === "group" ? { replyTo: message.messageId } : {}),
      startedAt: now(), notifiedInput: false,
    };
    const owner = message.chatKind === "dm" && link.owner?.id === message.sender.id;
    if (owner) p.owner = true;
    deps.state.addPending(p);
    keepTyping(p);
    try {
      await deps.send({ botId, threadId: p.threadId, text: body, sendId, person: message.sender, outside: !owner, platform });
    } catch {
      drop([p]);
      if (active()) await say(platform, botId, chatId, START_FAILED, p.replyTo);
      log(`${MESSENGER_LABELS[platform]} request could not be started.`);
      return;
    }
    if (!active()) { drop([p]); return; }
    armSweep();
    evaluate(p.threadId);
  }

  return {
    /** Messages from one bot's account are handled one at a time, in order. */
    receive(message: InboundMessage): Promise<void> {
      const lane = generationKey(message.botId, message.platform);
      const task = (inbound.get(lane) ?? Promise.resolve()).then(() => handle(message));
      const tail = task.catch(() => log("A chat app message could not be handled."));
      inbound.set(lane, tail);
      void tail.then(() => { if (inbound.get(lane) === tail) inbound.delete(lane); });
      return tail;
    },
    /** A tap on a card's button; only the paired owner's answer reaches the card. */
    choose(choice: InboundChoice): Promise<void> {
      return choose(choice).catch(() => log("A chat app button press could not be handled."));
    },
    /** Replies still owed from before a restart. */
    resume(): void {
      const threads = new Set(deps.state.pending().map((p) => p.threadId));
      for (const p of deps.state.pending()) keepTyping(p);
      armSweep();
      for (const threadId of threads) evaluate(threadId);
    },
    forgetBot(botId: string, platform?: MessengerPlatform): void {
      for (const one of platform ? [platform] : (["telegram", "discord"] as const)) generations.set(generationKey(botId, one), generation(botId, one) + 1);
      const gone = deps.state.pending().filter((p) => p.botId === botId && (!platform || p.platform === platform));
      drop(gone);
      deps.state.removeBot(botId, platform);
    },
    forgetThread(threadId: string): void {
      drop(deps.state.pending().filter((p) => p.threadId === threadId));
      deps.state.removeThread(threadId);
    },
    stop(): void {
      stopped = true;
      unsubscribe();
      sweep?.cancel();
      for (const timer of [...settling.values(), ...typing.values()]) timer.cancel();
      settling.clear();
      typing.clear();
    },
  };
}
export type MessengerBridge = ReturnType<typeof createMessengerBridge>;
