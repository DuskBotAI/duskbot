import type { Message } from "./store.ts";

export const REPEAT_WINDOW_MS = 10 * 60_000;

const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The bot already said exactly this in the chat in the last ten minutes and the person has not written since: a resumed
 * or carried-on turn repeating itself (Codex: "avoid duplicate user-visible messages within a turn or across turns").
 * Someone asking again gets the answer again. */
export function repeatedBubble(path: readonly Pick<Message, "role" | "kind" | "text" | "at">[], text: string, now: number): boolean {
  const said = plain(text);
  if (!said) return false;
  for (let i = path.length - 1; i >= 0; i--) {
    const message = path[i]!;
    if (message.at < now - REPEAT_WINDOW_MS) return false;
    if (message.role === "user") return false;
    if (message.role === "bot" && message.kind === "text" && plain(message.text ?? "") === said) return true;
  }
  return false;
}
