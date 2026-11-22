// What of a streaming reply reaches the chat: the words a person's Stop keeps, and a reply that is only "(pass)".
import { assistantTranscript } from "../../shared/client-cancel.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { isPassText } from "../room-reply.ts";
import { isDirectPassText, PassStreamGate, stripTrailingPass } from "../silent-reply.ts";
import type { Message, Store } from "../store.ts";

export interface StreamedReplyDeps {
  store: Pick<Store, "activePath" | "botByThread" | "groupByThread" | "messagesFor" | "patchMessage">;
  /** A one-on-one turn the person is in: a "(pass)" there sends nothing. Never a routine's run, an internal turn, a
   * bot API thread or assigned work. */
  directPassAllowed(threadId: string): boolean;
}

const TURN_OUTPUT: ReadonlySet<Message["kind"]> = new Set(["text", "widget", "app", "options", "screen"]);

export function createStreamedReply(deps: StreamedReplyDeps) {
  const { store } = deps;
  // A person's Stop keeps the words already streamed and nothing after: each thread's reply text since its last finished
  // item, and that text frozen at the first frame after the Stop (landed as the turn's last bubble, then cleared).
  const streamedReply = new Map<string, string>(), replyAtStop = new Map<string, string>();
  const passStreamGate = new PassStreamGate(), silentPassTurns = new Set<string>();
  /** The streaming reply's words the person's app showed when they pressed Stop: what is kept ends there. */
  const replySaidAtStop = new Map<string, string>();
  const flatWords = (text: string) => text.replace(/\s+/g, " ").trim();
  const keptAtStop = (threadId: string, turnId: string | undefined, streamed: string) => {
    const said = replySaidAtStop.get(threadId);
    if (said === undefined) return streamed;
    // the item they watched is still streaming: keep exactly what they saw
    if (flatWords(streamed).startsWith(flatWords(said))) return said;
    // it finished on its way to the Stop: its bubble ends where they stopped seeing it, and nothing after is kept
    const bubble = store.messagesFor(threadId).findLast((message) => message.role === "bot" && message.kind === "text" && message.turnId === turnId);
    const landed = flatWords(bubble?.text ?? "");
    if (bubble && landed !== flatWords(said) && landed.startsWith(flatWords(said))) store.patchMessage(threadId, bubble.id, { text: said });
    return "";
  };
  const freezeAtStop = (threadId: string, turnId: string | undefined) => {
    if (replyAtStop.has(threadId)) return;
    passStreamGate.reset(threadId);
    replyAtStop.set(threadId, keptAtStop(threadId, turnId, streamedReply.get(threadId) ?? ""));
  };

  const allowsPass = (threadId: string) => Boolean(store.botByThread(threadId) ? deps.directPassAllowed(threadId) : store.groupByThread(threadId));
  return {
    saidAtStop(threadId: string, said: string): void {
      replySaidAtStop.set(threadId, said);
    },
    turnStarted(threadId: string): void {
      streamedReply.delete(threadId);
      replyAtStop.delete(threadId);
      replySaidAtStop.delete(threadId);
      passStreamGate.reset(threadId);
      silentPassTurns.delete(threadId);
    },
    /** The event as the apps get it, or null when none of it reaches them: reply text after the person's Stop, words
     * that could still spell "(pass)", and a finished reply that is one. */
    shown(event: RuntimeEvent, afterPersonStop: boolean): RuntimeEvent | null {
      const { threadId } = event;
      if (event.type === "content.delta" && event.streamKind === "assistant_text") {
        if (afterPersonStop) { freezeAtStop(threadId, event.turnId); return null; }
        const delta = passStreamGate.delta(threadId, event.delta);
        if (delta === null) return null;
        streamedReply.set(threadId, (streamedReply.get(threadId) ?? "") + delta);
        return delta === event.delta ? event : { ...event, delta };
      }
      if (event.type === "item.completed" && event.itemType === "assistant_text") {
        if (afterPersonStop) { freezeAtStop(threadId, event.turnId); return null; }
        passStreamGate.reset(threadId);
        streamedReply.delete(threadId);
        const spoken = assistantTranscript(event.text);
        if (spoken.kind === "stopped") return event;
        const room = store.botByThread(threadId) ? undefined : store.groupByThread(threadId);
        const canPass = allowsPass(threadId);
        const stripped = canPass ? stripTrailingPass(spoken.text) : spoken.text;
        const pass = room ? Boolean(stripped.trim()) && isPassText(stripped) : canPass && isDirectPassText(stripped);
        if (pass) return null;
        if (canPass) {
          const cleaned = stripTrailingPass(event.text);
          if (cleaned !== event.text) return { ...event, text: cleaned };
        }
        return event;
      }
      return event;
    },
    /** The half answer that streamed before the Stop, handed over once. */
    takeKept(threadId: string): string {
      const kept = replyAtStop.get(threadId) ?? "";
      replyAtStop.set(threadId, "");
      return kept;
    },
    keptAtTurnEnd(threadId: string, turnId: string | undefined): string {
      return replyAtStop.get(threadId) ?? keptAtStop(threadId, turnId, streamedReply.get(threadId) ?? "");
    },
    replyEnded(threadId: string): void {
      streamedReply.delete(threadId);
      replyAtStop.delete(threadId);
      replySaidAtStop.delete(threadId);
      passStreamGate.reset(threadId);
    },
    /** Strips a trailing standalone "(pass)" line when this thread allows silent passes. */
    stripTrailingPass(threadId: string, text: string): string {
      return allowsPass(threadId) ? stripTrailingPass(text) : text;
    },
    /** True when this one-on-one reply is only "(pass)": it is not sent, and the turn counts as quiet until it speaks. */
    passes(threadId: string, text: string): boolean {
      if (!deps.directPassAllowed(threadId) || !isDirectPassText(stripTrailingPass(text))) return false;
      silentPassTurns.add(threadId);
      return true;
    },
    spoke(threadId: string): void {
      silentPassTurns.delete(threadId);
    },
    /** The turn that just ended answered "(pass)" and put nothing else in the chat. */
    passedQuietly(threadId: string, turn: { turnId: string | undefined; startedAt: number | undefined; reply: string }): boolean {
      const hasTurnOutput = Boolean(turn.reply) || store.activePath(threadId).some((message) =>
        message.role === "bot" &&
        ((turn.turnId && message.turnId === turn.turnId) || (turn.startedAt !== undefined && message.at >= turn.startedAt)) &&
        TURN_OUTPUT.has(message.kind));
      return silentPassTurns.delete(threadId) && !hasTurnOutput;
    },
  };
}
