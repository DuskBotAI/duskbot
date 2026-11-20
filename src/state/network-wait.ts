import type { Message } from "./store";

/** The conversation ends on a message of the person's still on its way while the device has no network: the wait is
 * for the connection, not for the bot. */
export function waitsForNetwork(messages: readonly Pick<Message, "id" | "role">[], offline: boolean): boolean {
  if (!offline) return false;
  const last = messages.at(-1);
  return Boolean(last && last.role === "user" && last.id.startsWith("optimistic-"));
}
