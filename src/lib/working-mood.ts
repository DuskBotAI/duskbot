import { TYPING_PHASE } from "./friendly-activity";

/** How the chat's working mascot carries itself for what the bot is doing now. */
export const WORKING_MOODS = ["thinking", "writing", "replying", "searching", "browsing", "running", "reading", "waiting", "error", "done"] as const;
export type WorkingMood = (typeof WORKING_MOODS)[number];

const BY_POOL: Record<string, WorkingMood> = {
  thinking: "thinking",
  generic: "thinking",
  memory: "thinking",
  web: "searching",
  page: "browsing",
  openPage: "browsing",
  browsing: "browsing",
  clicking: "browsing",
  screen: "browsing",
  computer: "browsing",
  form: "writing",
  typingInto: "writing",
  editing: "writing",
  saving: "writing",
  code: "writing",
  publish: "writing",
  commands: "running",
  files: "reading",
  team: "waiting",
};

/** The mood for the working line's `phase` (a friendly pool, a notice, the typing phase). Waiting on the person or on
 * teammates, a step that just failed and the turn's end win over the step itself. */
export function workingMood({ phase, waiting = false, failed = false, done = false }: {
  phase?: string | null;
  waiting?: boolean;
  failed?: boolean;
  done?: boolean;
}): WorkingMood {
  if (done) return "done";
  if (failed || phase?.startsWith("notice:")) return "error";
  if (waiting) return "waiting";
  if (!phase) return "thinking";
  if (phase === TYPING_PHASE) return "replying";
  if (phase.startsWith("friendly:service:")) return "browsing";
  return BY_POOL[phase.startsWith("friendly:") ? phase.slice("friendly:".length) : ""] ?? "thinking";
}

const WORD_GROUP: Record<WorkingMood, string> = {
  thinking: "thinking",
  searching: "looking",
  browsing: "looking",
  reading: "looking",
  running: "working",
  writing: "working",
  replying: "writing",
  waiting: "waiting",
  error: "error",
  done: "done",
};

/** The coarse step a working line's words stand for (thinking, looking things up, working on it, writing): steps in
 * one group never change the words. The bot's own labels and notices each stand alone. */
export function wordGroup(phase: string): string {
  return phase.startsWith("friendly:") ? WORD_GROUP[workingMood({ phase })] : phase;
}
