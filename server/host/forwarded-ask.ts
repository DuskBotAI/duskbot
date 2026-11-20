// A bot handing the person's own ask, nearly word for word, to a teammate the person never named, instead of doing it:
// small models do this with work their own tools cover ("make me a bot" sent to the Chief). The first such hand-off in a
// conversation goes back to the bot with what to do instead; the next one goes through.

export const FORWARDED_ASK_NOTE = "Not sent: this passes the person's own request to a teammate they did not name. They asked you, so do it yourself with your own tools (create_bot makes a bot, trigger sets up an automation, memory_update saves a note). Hand a teammate only a part that needs an app or access you lack, say which part in your message, and call coordinate_bots again for that.";

const WORD = /[\p{L}\p{N}]{4,}/gu;
const words = (text: string) => new Set((text.toLowerCase().match(WORD) ?? []));

/** whether `message` mostly repeats `ask` and the ask names none of the teammates it goes to */
export function forwardsAsk(ask: string, message: string, targets: ReadonlyArray<{ name: string }>): boolean {
  const lowered = ask.toLowerCase();
  if (targets.some(({ name }) => name.trim().length > 1 && lowered.includes(name.trim().toLowerCase()))) return false;
  const asked = words(ask), sent = words(message);
  if (asked.size < 2) return false;
  let shared = 0;
  for (const word of asked) if (sent.has(word)) shared += 1;
  return shared / asked.size >= 0.6;
}

const REFUSED_MAX = 500;
const AGAIN_AFTER_MS = 10 * 60_000;

export function createForwardedAskGuard(now: () => number = Date.now) {
  const refused = new Map<string, number>();
  return {
    /** the note to return instead of sending, or null to send: only a bot that is not a Chief, in its own one-on-one
     * conversation, and not again there for ten minutes, so a bot that truly needs the teammate goes through */
    check(input: { threadId: string; chief: boolean; room: boolean; consult: boolean; ask: string | undefined; message: string; targets: ReadonlyArray<{ name: string }> }): string | null {
      if (input.chief || input.room || input.consult || !input.ask) return null;
      const last = refused.get(input.threadId);
      if (last !== undefined && now() - last < AGAIN_AFTER_MS) return null;
      if (!forwardsAsk(input.ask, input.message, input.targets)) return null;
      refused.delete(input.threadId);
      refused.set(input.threadId, now());
      if (refused.size > REFUSED_MAX) refused.delete(refused.keys().next().value!);
      return FORWARDED_ASK_NOTE;
    },
  };
}

/** the server's one guard */
export const forwardedAsks = createForwardedAskGuard();
