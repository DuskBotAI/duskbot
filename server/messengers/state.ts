import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MESSENGER_PLATFORMS } from "../../shared/messengers.ts";
import { writeFileAtomic } from "../atomic.ts";

export const MESSENGER_STATE_FILE = "messenger-state.json";

const platform = z.enum(MESSENGER_PLATFORMS);
const conversationSchema = z.object({ botId: z.string(), platform, chatId: z.string(), threadId: z.string(), createdAt: z.number() });
const pendingSchema = z.object({
  botId: z.string(), platform, chatId: z.string(), threadId: z.string(), sendId: z.string(), replyTo: z.string().optional(),
  startedAt: z.number(), notifiedInput: z.boolean(),
  /** The paired owner's own direct chat: its cards are offered as buttons there. */
  owner: z.boolean().optional(),
});
/** A card sent to a chat as buttons; `id` goes out in each button's callback, never the request id itself. */
const offerSchema = z.object({
  id: z.string(), botId: z.string(), platform, chatId: z.string(), threadId: z.string(), requestId: z.string(), cardMessageId: z.string(),
  labels: z.array(z.string()), sentId: z.string().optional(), at: z.number(), settled: z.boolean().optional(),
});
const knockSchema = z.object({ botId: z.string(), platform, id: z.string(), kind: z.enum(["person", "chat"]), name: z.string(), at: z.number(), toldAt: z.number().optional() });
const schema = z.object({
  version: z.literal(1),
  conversations: z.record(z.string(), conversationSchema),
  pending: z.array(pendingSchema),
  /** Telegram getUpdates offset per bot. */
  offsets: z.record(z.string(), z.number()),
  knocks: z.array(knockSchema),
  offers: z.array(offerSchema).default([]),
  /** Group conversation keys whose unaddressed lines the bot may read as context when it is next addressed (opt-in). */
  listening: z.array(z.string()).default([]),
});
export type MessengerConversation = z.infer<typeof conversationSchema>;
export type MessengerPending = z.infer<typeof pendingSchema>;
export type MessengerKnock = z.infer<typeof knockSchema>;
export type MessengerOffer = z.infer<typeof offerSchema>;
type Data = z.infer<typeof schema>;

const MAX_PENDING = 500;
const MAX_KNOCKS_PER_BOT = 20;
const MAX_OFFERS = 300;

export class MessengerState {
  private readonly path: string;
  private data: Data = { version: 1, conversations: {}, pending: [], offsets: {}, knocks: [], offers: [], listening: [] };

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, MESSENGER_STATE_FILE);
    try {
      this.data = schema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      try { renameSync(this.path, `${this.path}.unreadable-${Date.now()}`); } catch {}
      console.warn("Chat apps: the conversation list could not be read. Starting empty.");
    }
  }

  conversation(key: string): MessengerConversation | undefined {
    return Object.hasOwn(this.data.conversations, key) ? { ...this.data.conversations[key]! } : undefined;
  }

  setConversation(key: string, value: MessengerConversation): void {
    Object.defineProperty(this.data.conversations, key, { value: { ...value }, enumerable: true, configurable: true, writable: true });
    this.save();
  }

  dropConversation(key: string): void {
    if (!Object.hasOwn(this.data.conversations, key)) return;
    delete this.data.conversations[key];
    this.save();
  }

  isMessengerThread(threadId: string): boolean {
    return Object.values(this.data.conversations).some((one) => one.threadId === threadId);
  }

  /** The chat app a thread's conversation lives in, when it is one. */
  platformOf(threadId: string): MessengerConversation["platform"] | null {
    return Object.values(this.data.conversations).find((one) => one.threadId === threadId)?.platform ?? null;
  }

  pending(): MessengerPending[] {
    return this.data.pending.map((one) => ({ ...one }));
  }

  addPending(value: MessengerPending): void {
    this.data.pending = [...this.data.pending.filter((one) => one.sendId !== value.sendId), value].slice(-MAX_PENDING);
    this.save();
  }

  patchPending(sendId: string, patch: Partial<MessengerPending>): void {
    this.data.pending = this.data.pending.map((one) => (one.sendId === sendId ? { ...one, ...patch } : one));
    this.save();
  }

  dropPending(sendIds: readonly string[]): void {
    if (!sendIds.length) return;
    this.data.pending = this.data.pending.filter((one) => !sendIds.includes(one.sendId));
    this.save();
  }

  offset(botId: string): number {
    return this.data.offsets[botId] ?? 0;
  }

  setOffset(botId: string, offset: number): void {
    if (this.data.offsets[botId] === offset) return;
    this.data.offsets[botId] = offset;
    this.save();
  }

  knocks(botId: string, platformName: z.infer<typeof platform>): MessengerKnock[] {
    return this.data.knocks.filter((one) => one.botId === botId && one.platform === platformName).map((one) => ({ ...one }));
  }

  /** The time this knocker was last told they are not let in, before this knock (undefined: never). */
  knock(value: Omit<MessengerKnock, "toldAt">, tell: (lastToldAt: number | undefined) => boolean): boolean {
    const old = this.data.knocks.find((one) => one.botId === value.botId && one.platform === value.platform && one.id === value.id);
    const told = tell(old?.toldAt);
    const next = { ...value, ...(told ? { toldAt: value.at } : old?.toldAt ? { toldAt: old.toldAt } : {}) };
    const rest = this.data.knocks.filter((one) => one !== old);
    const mine = rest.filter((one) => one.botId === value.botId && one.platform === value.platform);
    const dropped = mine.length >= MAX_KNOCKS_PER_BOT ? mine.slice(0, mine.length - MAX_KNOCKS_PER_BOT + 1) : [];
    this.data.knocks = [...rest.filter((one) => !dropped.includes(one)), next];
    this.save();
    return told;
  }

  offers(): MessengerOffer[] {
    return this.data.offers.map((one) => ({ ...one, labels: [...one.labels] }));
  }

  addOffer(value: MessengerOffer): void {
    this.data.offers = [...this.data.offers.filter((one) => one.id !== value.id), value].slice(-MAX_OFFERS);
    this.save();
  }

  patchOffer(id: string, patch: Partial<MessengerOffer>): void {
    this.data.offers = this.data.offers.map((one) => (one.id === id ? { ...one, ...patch } : one));
    this.save();
  }

  listens(key: string): boolean {
    return this.data.listening.includes(key);
  }

  setListening(key: string, on: boolean): void {
    if (this.listens(key) === on) return;
    this.data.listening = on ? [...this.data.listening, key].slice(-MAX_PENDING) : this.data.listening.filter((one) => one !== key);
    this.save();
  }

  forgetKnock(botId: string, platformName: z.infer<typeof platform>, id: string): void {
    this.data.knocks = this.data.knocks.filter((one) => !(one.botId === botId && one.platform === platformName && one.id === id));
    this.save();
  }

  removeThread(threadId: string): void {
    this.data.conversations = Object.fromEntries(Object.entries(this.data.conversations).filter(([, one]) => one.threadId !== threadId));
    this.data.pending = this.data.pending.filter((one) => one.threadId !== threadId);
    this.data.offers = this.data.offers.filter((one) => one.threadId !== threadId);
    this.save();
  }

  removeBot(botId: string, platformName?: z.infer<typeof platform>): void {
    const mine = (one: { botId: string; platform: string }) => one.botId === botId && (!platformName || one.platform === platformName);
    this.data.conversations = Object.fromEntries(Object.entries(this.data.conversations).filter(([, one]) => !mine(one)));
    this.data.pending = this.data.pending.filter((one) => !mine(one));
    this.data.knocks = this.data.knocks.filter((one) => !mine(one));
    this.data.offers = this.data.offers.filter((one) => !mine(one));
    this.data.listening = this.data.listening.filter((key) => !(platformName ? key.startsWith(`${platformName}:${botId}:`) : key.split(":")[1] === botId));
    if (!platformName || platformName === "telegram") delete this.data.offsets[botId];
    this.save();
  }

  private save(): void {
    writeFileAtomic(this.path, JSON.stringify(this.data), { mode: 0o600 });
  }
}
