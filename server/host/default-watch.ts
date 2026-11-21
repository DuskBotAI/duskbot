import type { Routine, RoutineScheduleInput } from "../routines.ts";

export const WATCH_NAME = "Keep an eye on my day";
const FIRST_LINES = [
  "Keep an eye on my day for me.",
  "- Email: pick what I must not miss: mail that needs my reply, mail from someone I meet today, and anything with a deadline. Leave out newsletters, receipts and notifications.",
  "- Meetings: before a meeting with other people, prepare me in a few lines: who they are, why we are meeting, what is still open, and one next step.",
];
export const WATCH_INSTRUCTIONS = [
  ...FIRST_LINES,
  "- Promises: what I said I'd do in mail or Slack in the last two days that isn't done yet, with who is waiting and by when.",
  "- Waiting on me: threads where someone asked me something and nothing went back. Check my Sent mail before you call anything unanswered.",
  "- Deadlines in the next seven days, with the date. Tell me only what needs me today.",
].join("\n");
/** Wordings the server made before, which a watch nobody edited moves on from. */
const EARLIER_INSTRUCTIONS = [FIRST_LINES.join("\n")];

/** The current wording for a watch still worded as the server once made it, or null. */
export const upgradedWatchPrompt = (prompt: string): string | null => (EARLIER_INSTRUCTIONS.includes(prompt) ? WATCH_INSTRUCTIONS : null);
export const WATCH_TIME = "08:00";
const FIRST_WATCH_EVERY_MINUTES = 15;
export const WATCH_SUGGESTION_TEXT = "Want me to keep an eye on your day? Every morning I'll pick out the email you shouldn't miss and get you ready for your meetings.";

export const watchSchedule = (): RoutineScheduleInput => ({ type: "daily", time: WATCH_TIME, weekdays: [0, 1, 2, 3, 4, 5, 6] });

/** The default watch as the server made it: on, and named, worded and timed as made. One the person paused or changed
 * is theirs. */
export function watchAsMade(routine: Pick<Routine, "name" | "prompt" | "enabled" | "deliver" | "schedule">): boolean {
  if (routine.deliver !== "brief" || !routine.enabled || routine.name !== WATCH_NAME || (routine.prompt !== WATCH_INSTRUCTIONS && !EARLIER_INSTRUCTIONS.includes(routine.prompt))) return false;
  const { schedule } = routine;
  if (schedule.type === "interval") return schedule.everyMinutes === FIRST_WATCH_EVERY_MINUTES;
  return schedule.type === "daily" && schedule.time === WATCH_TIME && schedule.weekdays.length === 7;
}
