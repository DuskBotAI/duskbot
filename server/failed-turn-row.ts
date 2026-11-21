// every failed reply's row is made here: the server's one reading of what stopped it, and a short code the person can
// quote to support, logged with the real cause, which no app shows.
import { failedTurnTool, withoutEchoedPrompt, type FailedTurnTool } from "../shared/failed-turn.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { errorKind, newErrorRef, rowFailureKind } from "../shared/failure-plan.ts";
import { failedReplyReason } from "./failed-reply-reason.ts";

type Flags = NonNullable<Parameters<typeof failedTurnTool>[1]> & Parameters<typeof failedReplyReason>[1];

const LOGGED_CAUSE_CHARS = 600;
/** A provider may name the signed-in account in its error; the server log never holds a person's address. */
const EMAIL = /[^\s@"'<>()]+@[^\s@"'<>()]+\.[a-z]{2,}/gi;

export function failedTurnRow(cause: string, flags: Flags = {}, log: (line: string) => void = console.warn): FailedTurnTool {
  const reason = flags.reason ?? (flags.place || flags.blocker || flags.claudeUpdate ? undefined : failedReplyReason(cause, flags));
  const errorRef = newErrorRef();
  const tool = failedTurnTool(cause, { ...flags, ...(reason ? { reason } : {}), errorRef });
  const kind = rowFailureKind(tool);
  const said = redactSecretsInText(withoutEchoedPrompt(cause)).replace(EMAIL, "[email]").replace(/\s+/g, " ").trim().slice(0, LOGGED_CAUSE_CHARS);
  log(`failed reply ${errorRef}: ${errorKind(kind)} (${kind}) ${said}`);
  return tool;
}
