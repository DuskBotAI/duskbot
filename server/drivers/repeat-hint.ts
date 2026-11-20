// A one-time reminder for something that comes back (a standup, rent, the gym): its tool result asks the bot to offer
// making it repeat, so even a small model makes the offer the prompt alone leaves to its judgement.
import type { ToolCallResult } from "./agents-call.ts";

const RECURRING = /\b(?:stand-?ups?|rent|reports?|gym|workouts?|yoga|class(?:es)?|lectures?|meds|medicines?|medication|pills|vitamins|bills?|payroll|timesheets?|invoices?|1:1s?|one-on-ones?|syncs?|check-?ins?|retros?|trash|garbage|recycling|water (?:the )?plants|drink water|journal|weekly|daily|every\s+(?:day|morning|week|month))\b/i;

export const REPEAT_HINT = "This is a one-time reminder for something that usually comes back. End your reply with one short line offering to make it repeat on the schedule it most likely follows (\"Want this every weekday at 9:45?\"); do not set that up unless they say yes.";

/** the result of creating a once-only schedule, with the repeat offer asked for when its name or instructions read as recurring */
export function withRepeatHint(result: ToolCallResult, fields: { name?: unknown; instructions?: unknown; schedule?: unknown }): ToolCallResult {
  if (result.isError) return result;
  const schedule = fields.schedule && typeof fields.schedule === "object" ? fields.schedule as { type?: unknown } : null;
  if (schedule?.type !== "once") return result;
  const words = `${typeof fields.name === "string" ? fields.name : ""} ${typeof fields.instructions === "string" ? fields.instructions : ""}`;
  return RECURRING.test(words) ? { ...result, text: `${result.text}\n\n${REPEAT_HINT}` } : result;
}
