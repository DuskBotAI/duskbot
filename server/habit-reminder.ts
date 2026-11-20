import type { WireMessage } from "../shared/wire.ts";

/** Text messages in the chat, the person's and the bots', before the reminder starts riding each turn. */
export const HABIT_REMINDER_AFTER = 20;

export const HABIT_REMINDER = "Reminder: do the whole ask now, not a plan; say done only for what a tool did this turn; stop at once when told; result first; no narration between tool calls; no tool or file names; no time-of-day greeting in an ongoing chat.";

export function chatMessageCount(messages: ReadonlyArray<Pick<WireMessage, "kind">>): number {
  let count = 0;
  for (const message of messages) if (message.kind === "text") count += 1;
  return count;
}

export const VENT_HINT = "This message reads as venting: answer the feeling first, in one line of your own words (not theirs back), give no fix or advice they did not ask for, and add at most one gentle question or one small offer.";

const FEELING = /\b(?:ugh+|argh+|sigh|so tired|exhausted|drained|stressed|stressful|overwhelmed|frustrat(?:ed|ing)|annoyed|annoying|sick of|fed up|i hate|hate (?:this|it|mondays)|rough (?:day|week|morning)|long (?:day|week)|burn(?:ed|t) out|can'?t deal|anxious|upset|sad|disaster|nightmare|mondays)\b/i;
const ASKS = /\?|\b(?:can you|could you|would you|will you|please|pls|help me|remind|make|write|draft|find|set up|schedule|send|book|fix|show me|tell me|what|how|why|when|where)\b/i;

/** whether a person's message is mostly a feeling with no ask in it */
export function venting(text: string): boolean {
  const line = text.trim();
  return line.length > 0 && line.length <= 400 && FEELING.test(line) && !ASKS.test(line);
}

/** the reminder for a long chat, and the venting hint for a message that is only a feeling */
export function habitReminder(chatMessages: number, text = ""): string {
  return (chatMessages >= HABIT_REMINDER_AFTER ? ` ${HABIT_REMINDER}` : "") + (venting(text) ? ` ${VENT_HINT}` : "");
}
