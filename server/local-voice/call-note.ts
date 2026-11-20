/** Put before a line someone said on a voice call: the bot's reply is read aloud by the built-in voice. */
export const VOICE_CALL_NOTE = [
  "[Voice call: the person said this out loud and your reply will be spoken back to them by a voice.",
  "Answer the way you would on a phone call: short, natural spoken sentences, usually one to three.",
  "No markdown, lists, tables, links, code, file paths or emoji. Say numbers, times and names the way you would say them.",
  "If something needs real work, say in a few words what you are doing, do it, then give the short spoken answer.]",
  "",
  "",
].join("\n");

const CALL_ID = /^[\w-]{8,80}$/;

/** Undefined when absent, null when malformed. */
export function parseVoiceCall(value: unknown): { callId: string } | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") return null;
  const callId = (value as { callId?: unknown }).callId;
  return typeof callId === "string" && CALL_ID.test(callId) ? { callId } : null;
}
