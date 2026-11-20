// A chat-completions round that ends with nothing to show: one nudged retry, then a plain failure, never silence.
import { ChatProtocolError } from "./openai-chat-protocol.ts";

/** failures where the provider ran nothing and showed nothing, so asking once more repeats no work */
const RETRY_ONCE = new Set(["empty_reply", "stream_cut", "tool_call_malformed", "tools_unavailable"]);

const NUDGE = "Your last reply came back empty. Answer the person's last message now, in plain words.";
const NUDGE_NO_TOOLS = "No tools are available in this turn. Answer the person's last message now, in plain words, without calling a tool.";

const AGAIN = "Try again, or switch this bot to another model.";
const SAID = {
  empty_reply: `The model sent back an empty reply, so it said nothing. ${AGAIN}`,
  stream_cut: `The model's reply stream closed before it finished. ${AGAIN}`,
  tool_call_malformed: `The model sent a broken tool call, so nothing ran. ${AGAIN}`,
  tools_unavailable: `The model kept calling tools in a chat that has none, so it said nothing. ${AGAIN}`,
  reasoning_leak: `The model sent its working notes instead of a reply. ${AGAIN}`,
} as const;

/** the failure a provider error code stands for, worded for the person; the code rides along for usage reasons */
export function noReplyError(code: keyof typeof SAID): ChatProtocolError {
  return new ChatProtocolError(SAID[code], code === "empty_reply" ? "no_reply:empty_reply" : code);
}

/** why a round that called no tool cannot be the turn's answer; null when `reply` is a finished answer */
export function unfinishedReply(reply: string, finishReason: string | null): ChatProtocolError | null {
  if (!reply.trim()) {
    if (finishReason === "length") return new ChatProtocolError("The model spent its whole output allowance before it wrote a reply (finish_reason: length). Ask for a shorter answer, or switch this bot to another model.", "finish_length");
    if (finishReason === "content_filter") return contentFiltered();
    return noReplyError("empty_reply");
  }
  if (!finishReason || finishReason === "stop") return null;
  if (finishReason === "length") return new ChatProtocolError("The model's reply hit its output allowance before it finished (finish_reason: length). Ask it to continue, or ask for a shorter answer.", "finish_length");
  if (finishReason === "content_filter") return contentFiltered();
  const reason = /^[a-z][a-z0-9_]{0,30}$/.test(finishReason) ? finishReason : "other";
  return new ChatProtocolError(`The model stopped before it finished this reply (finish_reason: ${reason}). ${AGAIN}`, `finish_${reason}`);
}

const contentFiltered = () => new ChatProtocolError("The provider's content filter blocked this reply (finish_reason: content_filter). Reword the request, or switch this bot to another model.", "finish_content_filter");

const FINALIZE = "Your tools have finished and you wrote no reply. Without calling another tool, write your final answer now from what they returned.";
const FINALIZE_FAILED = " A step failed: say plainly what failed, what you did not do, and what would get it done.";

/** the message to send once more for a reply with nothing in it, or null when this failure is not retried or already was.
 * After tools ran (`after`), it asks for the final answer from their results, never more work. */
export function nudgeOnce(error: unknown, retried: boolean, after?: { toolsRan: number; failed: boolean }): string | null {
  if (retried || !(error instanceof ChatProtocolError) || !error.code || !RETRY_ONCE.has(error.code.replace(/^no_reply:/, ""))) return null;
  if (error.code === "tools_unavailable") return NUDGE_NO_TOOLS;
  return after?.toolsRan ? FINALIZE + (after.failed ? FINALIZE_FAILED : "") : NUDGE;
}

/** a protocol failure's code for the turn's runtime.error */
export const failureCodeOf = (error: unknown): string | undefined => error instanceof ChatProtocolError ? error.code : undefined;

/** a coded no-reply failure in the person's words, whatever the protocol layer called it; anything else as it is */
export function inPlainWords(error: unknown): unknown {
  const code = failureCodeOf(error)?.replace(/^no_reply:/, "");
  return code && Object.hasOwn(SAID, code) ? noReplyError(code as keyof typeof SAID) : error;
}
