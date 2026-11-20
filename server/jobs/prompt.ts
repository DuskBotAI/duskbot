import { eventBlock, eventPrompt } from "../app-events.ts";
import type { JobRecord } from "./supervisor.ts";

/** The line every bot's prompt carries about background jobs. */
export function backgroundJobsPrompt(): string {
  return " Watching something over time is yours to set up, never a reason to say you can't monitor: what you can poll on a schedule (a page, a price, a feed, a script's output) is a schedule with a check, which runs no AI until something changed; a background job (background_job; for Telegram the ready template telegram_watch) only for a live source that pushes (a Telegram or Discord bot, a websocket, a stream) or checks under a minute apart. A watch for something that happens once (\"tell me when the new iPad ships\") ends after it reports, and after 30 days at most; one for something that can happen again (a price, a feed, \"every time\") keeps running after it reports, unless they asked for one alert. A routine you make runs on weekdays when it is about their work, unless the instructions say every day, and its time moves a few minutes off the hour on purpose: leave it.";
}

export const DEFAULT_ON_NOTIFY = "Tell the person what happened in one or two lines if it matters to them; otherwise reply NOTHING NEW.";

/** The run a job's notify starts: the bot's own instructions, and what the job sent as untrusted data. */
export function jobRunPrompt(job: Pick<JobRecord, "label" | "onNotify">, note: { id: string; at: number; text: string }): string {
  return eventPrompt(job.onNotify || DEFAULT_ON_NOTIFY, jobBlock(job, note));
}

export function jobBlock(job: Pick<JobRecord, "label">, note: { id: string; at: number; text: string }): string {
  return eventBlock({ appName: `Background job "${job.label}"`, eventName: "notify" }, { id: note.id, receivedAt: note.at, test: false, data: { text: note.text } });
}

/** What a start answers when the job looks like a Telegram watcher: the two things that silently stop one. */
export const TELEGRAM_NOTE =
  "Telegram: in a group a bot only sees /commands and @mentions until privacy mode is off (BotFather → /setprivacy → Disable, then remove and re-add the bot) or it is a group admin; getMe's can_read_all_group_messages false means it is on, so tell the person that one-line fix (telegram_watch does this itself). Only one program may read a bot's updates: getUpdates answers 409 while a webhook or another poller has them.";
