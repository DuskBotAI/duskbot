// Who speaks next when a bot's room reply @mentions teammates, for one message of the person's. A teammate not yet heard
// from is brought in, up to MENTION_DEPTH steps from the person's message. A bot that handed work to a teammate gets one
// closing turn when that teammate @mentions it back, and a closing turn may only hand back further up, so every bot speaks
// at most twice per message and a tagging loop always ends.

/** Steps of bot-to-bot @mentions away from the person's message that may still bring a new teammate in. */
export const MENTION_DEPTH = 2;

const ASKS = /\b(?:waiting|wait for|once|when you(?:'re| are)? (?:done|ready|finished)|send (?:me|over|them)|shares?|let me know|pass (?:me|over)|need your)\b/i;

/** Whether the sentence of `text` that @mentions `name` asks that teammate for something back (a question, or words like
 * "send me", "once you're done"), rather than handing the work over. */
export function asksFor(text: string, name: string): boolean {
  const at = text.toLocaleLowerCase().indexOf(`@${name.toLocaleLowerCase()}`);
  if (at === -1) return false;
  const start = Math.max(text.lastIndexOf("\n", at), ...[".", "!", "?"].map((mark) => text.lastIndexOf(mark, at))) + 1;
  const ends = ["\n", ".", "!", "?"].map((mark) => text.indexOf(mark, at)).filter((index) => index !== -1);
  const end = ends.length ? Math.min(...ends) : text.length;
  const sentence = text.slice(start, end + 1);
  return sentence.trimEnd().endsWith("?") || ASKS.test(sentence);
}

export interface MentionCue {
  /** The teammate whose @mention woke this bot. */
  by: { id: string; name: string };
  /** True for the asker's closing turn: the teammate it handed work to answered it. */
  closing: boolean;
}

export interface NextSpeaker {
  id: string;
  hop: number;
  cue: MentionCue;
}

export class MentionChain {
  /** botId -> the bots that brought it in with an @mention. */
  private askedBy = new Map<string, Set<string>>();
  private closed = new Set<string>();
  private cues = new Map<string, MentionCue>();
  /** botId -> the bots waiting on its reply, with the hop they asked from. */
  private waiting = new Map<string, Map<string, number>>();
  /** Bots whose reply for this message has landed. */
  private finished = new Set<string>();
  /** A waiting bot still answering when the teammate it asked replied: it speaks again once its own reply lands. */
  private answered = new Map<string, { by: { id: string; name: string }; hop: number }>();

  /** The cue for `botId`'s next turn, taken once. */
  takeCue(botId: string): MentionCue | undefined {
    const cue = this.cues.get(botId);
    this.cues.delete(botId);
    return cue;
  }

  closing(botId: string): boolean {
    return this.closed.has(botId);
  }

  /** Whether `id`, @mentioned in `speaker`'s reply, speaks next; asked right before it would run, since an earlier mention
   * in the same reply may have brought it in already. `heard`: bots that already had a turn for this message. */
  decide(speaker: { id: string; name: string }, id: string, hop: number, heard: ReadonlySet<string>, speakerClosing: boolean, asks = false): NextSpeaker | null {
    if (id === speaker.id) return null;
    const by = { id: speaker.id, name: speaker.name };
    if (this.askedBy.get(speaker.id)?.has(id) === true && heard.has(id) && !this.closed.has(id)) {
      this.closed.add(id);
      return this.cued(id, hop, { by, closing: true });
    }
    // a teammate still answering this message: the speaker waits for that reply and gets one closing turn once it lands
    if (asks && !speakerClosing && heard.has(id) && !this.finished.has(id) && !this.closed.has(speaker.id)) {
      const waiters = this.waiting.get(id) ?? new Map<string, number>();
      waiters.set(speaker.id, hop);
      this.waiting.set(id, waiters);
      return null;
    }
    if (speakerClosing || heard.has(id) || hop >= MENTION_DEPTH) return null;
    const askers = this.askedBy.get(id) ?? new Set<string>();
    askers.add(speaker.id);
    this.askedBy.set(id, askers);
    return this.cued(id, hop, { by, closing: false });
  }

  /** `bot`'s reply for this message has landed: the bots that asked it while it was still answering speak again, once. */
  wake(bot: { id: string; name: string }): NextSpeaker[] {
    this.finished.add(bot.id);
    const woken: NextSpeaker[] = [];
    // its own reply landed after the teammate it waited on had already answered
    const own = this.answered.get(bot.id);
    this.answered.delete(bot.id);
    if (own && !this.closed.has(bot.id)) {
      this.closed.add(bot.id);
      woken.push(this.cued(bot.id, own.hop, { by: own.by, closing: true }));
    }
    const waiters = this.waiting.get(bot.id);
    this.waiting.delete(bot.id);
    for (const [id, hop] of waiters ?? []) {
      if (this.closed.has(id)) continue;
      if (!this.finished.has(id)) { this.answered.set(id, { by: { id: bot.id, name: bot.name }, hop }); continue; }
      this.closed.add(id);
      woken.push(this.cued(id, hop, { by: { id: bot.id, name: bot.name }, closing: true }));
    }
    return woken;
  }

  private cued(id: string, hop: number, cue: MentionCue): NextSpeaker {
    this.cues.set(id, cue);
    return { id, hop: hop + 1, cue };
  }
}
