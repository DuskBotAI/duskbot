// A bot's own chat-app accounts (a Telegram bot, a Discord bot): people message it there and it answers as itself.

export const MESSENGER_PLATFORMS = ["telegram", "discord"] as const;
export type MessengerPlatform = (typeof MESSENGER_PLATFORMS)[number];

export const MESSENGER_LABELS: Record<MessengerPlatform, string> = { telegram: "Telegram", discord: "Discord" };

export function isMessengerPlatform(value: unknown): value is MessengerPlatform {
  return typeof value === "string" && (MESSENGER_PLATFORMS as readonly string[]).includes(value);
}

/** Someone or some group chat let in to talk to the bot. */
export interface MessengerAllowed {
  id: string;
  kind: "person" | "chat";
  name?: string;
}

/** Someone the bot turned away recently, so the owner can let them in by name. */
export interface MessengerKnocked {
  id: string;
  kind: "person" | "chat";
  name: string;
  at: number;
}

/** One platform's state for one bot, as GET /api/bots/:id/messengers answers it. Never carries a token. */
export interface MessengerStatus {
  platform: MessengerPlatform;
  state: "not_connected" | "connecting" | "online" | "error";
  /** The bot account's handle: @name on Telegram, name on Discord. */
  handle?: string;
  /** Where to open a chat with it: t.me for Telegram, the add-to-server link for Discord. */
  openUrl?: string;
  /** Telegram: a one-tap link that makes whoever opens it first the owner. Discord: send this code to the bot in a DM. */
  pairUrl?: string;
  pairCode?: string;
  /** The person who claimed the bot with the pairing code: always let in. */
  owner?: MessengerAllowed;
  allowed: MessengerAllowed[];
  knocked: MessengerKnocked[];
  /** How messages reach this place: a webhook through the public address (a sleeping cloud wakes for it), or this
   * process asking the platform (needs it to be running). */
  delivery?: "webhook" | "polling" | "gateway";
  error?: string;
}

export interface MessengersStatus {
  botId: string;
  platforms: MessengerStatus[];
}
