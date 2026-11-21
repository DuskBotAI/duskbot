import type { MessengerPlatform } from "../../shared/messengers.ts";

const TELEGRAM = " You are replying in Telegram: no tables or headers, one item per line with a label; two or three short messages at most; a choice goes on tap-to-answer buttons, never a numbered list to type back; files go as attachments.";

/** How a reply reads in the chat app this turn's conversation lives in; empty in the app's own chats. */
export function channelPrompt(platform: MessengerPlatform | null): string {
  if (platform === "telegram") return TELEGRAM;
  if (platform === "discord") return TELEGRAM.replace("Telegram", "Discord") + " Wrap a bare link in <> so it does not expand.";
  return "";
}
