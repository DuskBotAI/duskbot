// The rhythm of a working turn, kept by the harness rather than left to the engine: a short ack a few seconds after the
// person asks for real work, then, on a job past half a minute, a second message saying what they will get, and on a long job a milestone
// when nothing has been said for a while. A small fast model writes each one in the bot's voice from what the person asked
// and the steps run so far; the engine's own turn runs on untouched. Each beat is dropped the moment the engine has said
// the same kind of thing itself, or is writing its result. Never for routines, teammates, cards or other turns nobody
// watches, and only while features.quickUpdates is not false.
import { classifyTurn } from "./turn-route.ts";
import { derivedLabel } from "./harness/derived-status.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";

export type BeatKind = "ack" | "plan" | "milestone";

/** The earliest an ack goes out, so a fast reply never follows one. */
export const ACK_MIN_MS = 1_500;
/** An ack for work that has run no tool yet waits this long for the engine to answer by itself first, and goes out only
 * once the engine shows it is thinking (or at once, for an engine that shows none): an ack nothing follows is a promise
 * the turn did not keep. */
export const ACK_IDLE_MS = 4_000;
/** The pause before a beat's writer is asked once more after a rate limit or a busy model. */
export const RETRY_BUSY_MS = 700;
const BUSY = /\b(?:429|50[234])\b|rate.?limit|too many requests|overloaded|auth_unavailable/i;
/** The second message is written from here, once a tool has run, and goes out from PLAN_MIN_MS: only a job that runs
 * past half a minute gets one, so a quick task reads as an ack and its result. */
export const PLAN_WRITE_MS = 26_000;
export const PLAN_MIN_MS = 30_000;
/** A milestone after this long without any message from the bot, while tools keep running. */
export const MILESTONE_QUIET_MS = 150_000;
export const MAX_MILESTONES = 3;
const WRITE_TIMEOUT_MS = 12_000;
const TICK_MS = 250;
const UNSTARTED_MS = 60_000;
const SOUL_CHARS = 1_200;
/** A setup that has the bot ask before it uses tools: its ack waits for a tool to run. */
const ASKS_FIRST = /\b(?:ask|check with|confirm with)\b[^.]{0,80}\b(?:before|first)\b|\bbefore (?:using|running|calling) any tool/i;
const ASK_CHARS = 1_500;
const STEP_CHARS = 90;
const SAID_CHARS = 300;
const MAX_SAID_BEFORE_PLAN = 2;
const MAX_WORDS = { ack: 26, plan: 55, milestone: 45 } as const;

export type BeatWriter = (prompt: string, options: { signal: AbortSignal; timeoutMs: number }) => Promise<string>;

export interface TurnBeatsDeps {
  enabled(): boolean;
  /** The small one-off text call of the engine running this thread, or null when it has none. */
  writer(botId: string, threadId: string): BeatWriter | null;
  /** `apps`: the connected apps this bot may use, by name; absent when unknown. */
  bot(botId: string): { name: string; soul?: string; apps?: readonly string[] } | null | undefined;
  /** False for an engine that may show no thinking before its first tool: its ack goes out at ACK_IDLE_MS anyway. */
  showsThinking?(threadId: string): boolean;
  /** Whether this turn is still the one the thread runs. */
  live(threadId: string, turnId: string): boolean;
  post(beat: { botId: string; threadId: string; turnId: string; text: string; kind: BeatKind }): void;
  now?: () => number;
  log?: (line: string) => void;
}

export interface BeatStart {
  botId: string;
  threadId: string;
  text: string;
  attachments: number;
  /** A routine, webhook, teammate, card continuation, voice call or any other turn nobody reads live as it runs. */
  unattended: boolean;
}

type Phase = "idle" | "writing" | "ready" | "posted" | "dropped";

interface Beat {
  phase: Phase;
  text?: string;
  /** An ack that asks for a detail the work cannot start without, instead of naming work underway. */
  asks?: boolean;
  abort?: AbortController;
}

interface Watch {
  botId: string;
  threadId: string;
  ask: string;
  work: boolean;
  /** Its setup has it ask before using tools. */
  asksFirst: boolean;
  startedAt: number;
  turnId?: string;
  tools: number;
  toolsDone: number;
  /** When the engine's own text last arrived, and how many messages it has finished. */
  engineTextAt: number;
  engineMessages: number;
  /** Every message of the turn so far, the engine's and the harness's, in order. */
  said: string[];
  streaming: boolean;
  /** The engine has shown it is working on it: reasoning streamed or a reasoning step began. */
  thinking: boolean;
  planRewritten: boolean;
  steps: string[];
  stepsAtLastWord: number;
  lastWordAt: number;
  waiting: boolean;
  ack: Beat;
  plan: Beat;
  milestone: Beat;
  milestones: number;
  milestoneTriedAt: number;
  posted: string[];
  timer: ReturnType<typeof setInterval>;
}

/** Asks that set something up or change it (a reminder, a watch, a routine, a correction): they run tools before any
 * reply, so their ack is written as the turn starts rather than after the first tool. */
const SETUP_ASK = /\b(?:remind|reminder|notify|alert|ping me|tell me (?:when|if|as soon)|let me know|keep an eye|watch|monitor|track|every (?:day|morning|evening|night|week|weekday|month|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d)|each (?:day|morning|week|monday|tuesday|wednesday|thursday|friday)|daily|weekly|cancel|stop (?:the|my)|turn off|make it|change it|instead|skip|move it|set up|set an?|add (?:a|an|it)|wait,|actually,)/i;

/** Asks to make something (an image, a chart, a deck) or go through what exists: the model often thinks for a long while
 * before its first tool. */
const MAKE_ASK = /\b(?:make (?:me |us )?(?:an?|the|my|some|\d+)\b|draw|sketch|illustrate|audit|go through)|\b(?:an?|the|my) (?:image|picture|thumbnail|logo|poster|banner|chart|graph|deck|slides?|spreadsheet|pdf)\b/i;
const SETUP_ASK_PT_ES = /\b(?:tod[oa]s (?:os|as|los|las) (?:dias|días|semanas|manh(?:ã|a)s|mañanas|noites|noches|segundas|lunes)|tod[ao] (?:dia|día|semana|segunda|lunes)|cada (?:dia|día|semana|manh(?:ã|a)|mañana|hora)|lembr[ae]|recu(?:é|e)rd|avis[ae]|av(?:í|i)same|me avise|cancel[ae])/i;

/** A message that only says yes to something earlier in the chat ("go ahead and set it up", "ok do that"). */
const GO_AHEAD = /^\s*(?:ok(?:ay)?|yes|yep|yeah|sure|great|perfect|sounds good|looks good|go ahead|do it|do that|please do|set it up|go for it)\b[^?]{0,40}$/i;

/** Whether a message asks for work that is worth an ack before any tool has run. */
export function looksLikeWork(text: string, attachments: number): boolean {
  return classifyTurn({ text, attachments, priorTurnUsedTools: false }) === "complex" || SETUP_ASK.test(text) || MAKE_ASK.test(text) || SETUP_ASK_PT_ES.test(text);
}

function personaLines(bot: { name: string; soul?: string }): string {
  const soul = (bot.soul ?? "").replace(/\s+/g, " ").trim().slice(0, SOUL_CHARS);
  return soul ? `About ${bot.name}, in its own setup: ${soul}` : `${bot.name} is a helpful assistant.`;
}

const SHARED_RULES = (name: string) => [
  `- Write as ${name}, in the first person, in the language of the person's message.`,
  `- Plain, warm and specific. No greeting, no emoji, no exclamation marks, no questions, no apology: when they are upset, name the fix being made. Never say what can't be done or that a step failed: that is ${name}'s own reply to make.`,
  "- Never state results, prices, numbers or facts that are not given above. Never promise a time.",
  "- Never claim to be reading, watching, cancelling or changing something in an app, account, chat, device or existing item (an inbox, a group chat, a reminder, a file) unless it is among the apps above or the steps show it: name the goal instead (\"Setting up a watch on that group.\").",
  "- Never name tools, models, searches as a mechanism, files that hold notes, or the app.",
  "- If nothing useful and true can be said, reply exactly SKIP.",
  "Reply with the message only.",
].join("\n");

export function beatPrompt(kind: BeatKind, input: { name: string; soul?: string; apps?: readonly string[]; ask: string; steps: string[]; said: string[]; minutes?: number }): string {
  const ask = input.ask.slice(0, ASK_CHARS);
  const steps = input.steps.slice(-10).map((step) => `- ${step}`).join("\n") || "- (none yet)";
  const said = input.said.map((line) => `- ${line}`).join("\n");
  const head = [
    `You write one short chat message for ${input.name}. ${input.name} is working on the person's request right now; another process does the work. You only write a short message the person sees while it runs.`,
    personaLines(input),
    `Connected apps ${input.name} can use: ${input.apps?.length ? input.apps.join(", ") : "none"}.`,
    "",
    "The person's message:",
    "<<<",
    ask,
    ">>>",
  ];
  if (kind === "ack") {
    return [...head, "",
      "Write the acknowledgement they see first.",
      "- One sentence, 6 to 20 words, present tense, naming the concrete action and object, like \"On it, pulling this week's Delhi to Goa fares.\" or \"Got it, comparing the three plans now.\" Write names and products exactly as the person did (EndNote, not \"the endnote\"). Say it in your own words, never their sentence back, and never a stock phrase like \"I'd be happy to help\".",
      "- When the work needs their own inbox, files, computer, account or a booking, name the check, never the work as underway: \"Checking your support inbox.\", not \"Going through your inbox now.\"",
      "- When the work cannot start without a detail only the person can give (where they are, for a nearest or near-me ask that names no place; which of two accounts; a date they never gave), never say the work is underway: reply ASK: and one short question for just that detail, the one place a question is allowed (\"ASK: Which area or landmark are you near?\"). You see only this message, not the chat before it: a go-ahead or a pointer back (\"go ahead and set it up\", \"do that\") never gets ASK; reply SKIP.",
      `- Reply exactly SKIP only if the message is a greeting, thanks or small talk, or ${input.name}'s setup says it asks before using tools. Any other ask for work gets an ack: a correction or a change ("wait, it's in Rust") gets one naming the change, and setting up a watch or an automation names what is being set up.`,
      SHARED_RULES(input.name),
    ].join("\n");
  }
  if (kind === "plan") {
    return [...head, "",
      `${input.name} already told them:`, said || "- (nothing yet)", "",
      `What ${input.name} has done so far:`, steps, "",
      "Write the second message: what they will get and its shape (a short list, a table, a file, a link, a summary), and any default you can see being assumed.",
      `- Never promise a check, a test, a price lookup or anything else that is not already among the steps: you cannot know ${input.name} can do it. No "before sending, I'll check" lines.`,
      "- 15 to 40 words, 1 or 2 sentences. Do not repeat what was already said.",
      "- If what was already said tells them what they will get, reply exactly SKIP.",
      "- Never promise a format, file or page the request does not call for.",
      SHARED_RULES(input.name),
    ].join("\n");
  }
  return [...head, "",
    `${input.name} has been working for about ${input.minutes ?? 3} minutes. Already said:`, said || "- (nothing yet)", "",
    "Steps since then:", steps, "",
    "Write a short progress note: what has been covered so far, taken only from the steps, and what it is on now. 10 to 30 words. Not a status ping: say something concrete.",
    SHARED_RULES(input.name),
  ].join("\n");
}

/** A line about the bot's own reply ("a brief confirmation", "check it matches your message") rather than the work. */
const ABOUT_ITSELF = /\ba (?:brief |short |quick )?confirmation\b|\bmy (?:reply|response|answer)\b|\bmatch(?:es)? your (?:message|request)\b/i;

/** The model's reply as a chat line, or null when it declined or wrote something that is not one short message. */
export function cleanBeat(kind: BeatKind, reply: string): string | null {
  return cleanBeatLine(kind, reply)?.text ?? null;
}

/** An ack written as ASK: is the one question a beat may be. */
export function cleanBeatLine(kind: BeatKind, reply: string): { text: string; asks: boolean } | null {
  let text = reply.replace(/\r/g, "").trim();
  text = text.replace(/^(?:message|ack|reply|answer)\s*:\s*/i, "").replace(/^["“'‘]+|["”'’]+$/g, "").trim();
  const asks = kind === "ack" && /^ASK\s*:/.test(text);
  if (asks) text = text.replace(/^ASK\s*:\s*/, "").replace(/^["“'‘]+|["”'’]+$/g, "").trim();
  if (!text || /\bSKIP\b/.test(text) || text.includes("```") || text.split("\n").filter((line) => line.trim()).length > 2) return null;
  text = redactSecretsInText(text.replace(/\s+/g, " ")).replace(/\s*!+/g, ".").replace(/\.\.+$/, ".");
  const words = text.split(" ").length;
  if (words < 3 || words > MAX_WORDS[kind] || /\?\s*$/.test(text) !== asks || ABOUT_ITSELF.test(text)) return null;
  return { text, asks };
}

/** What the engine reads before the next message: the lines the harness sent in its name, which it never saw itself. */
export function beatsNote(lines: readonly string[]): string {
  if (!lines.length) return "";
  return `(While you worked on the person's previous request, these short updates were sent to them in your name, and they are part of this chat: ${lines.map((line) => `"${line}"`).join(" ")} Stay consistent with them.)\n\n`;
}

export function createTurnBeats(deps: TurnBeatsDeps) {
  const now = deps.now ?? Date.now;
  const watches = new Map<string, Watch>();
  const notes = new Map<string, string[]>();

  const end = (watch: Watch) => {
    clearInterval(watch.timer);
    for (const beat of [watch.ack, watch.plan, watch.milestone]) beat.abort?.abort();
    if (watches.get(watch.threadId) === watch) watches.delete(watch.threadId);
    if (watch.posted.length) notes.set(watch.threadId, [...(notes.get(watch.threadId) ?? []), ...watch.posted].slice(-6));
  };


  const write = (watch: Watch, kind: BeatKind, beat: Beat) => {
    const writer = deps.writer(watch.botId, watch.threadId);
    const bot = deps.bot(watch.botId);
    if (!writer || !bot) {
      beat.phase = "dropped";
      return;
    }
    beat.phase = "writing";
    beat.abort = new AbortController();
    const steps = kind === "milestone" ? watch.steps.slice(watch.stepsAtLastWord) : watch.steps;
    const prompt = beatPrompt(kind, { name: bot.name, soul: bot.soul, apps: bot.apps, ask: watch.ask, steps, said: watch.said.slice(-4), minutes: Math.round((now() - watch.startedAt) / 60_000) });
    const signal = beat.abort.signal;
    const once = () => writer(prompt, { signal, timeoutMs: WRITE_TIMEOUT_MS });
    // a busy model answers 429 or a 5xx "overloaded" at the busiest moment, the turn's start: one more try after a short pause
    const written = once().catch(async (error: unknown) => {
      if (!BUSY.test(error instanceof Error ? error.message : String(error)) || signal.aborted) throw error;
      await new Promise((done) => setTimeout(done, RETRY_BUSY_MS));
      if (signal.aborted || beat.phase !== "writing") throw error;
      return once();
    });
    void written.then((reply) => {
      if (beat.phase !== "writing") return;
      const line = cleanBeatLine(kind, reply);
      // the writer never sees the chat before this message, so a question back to a go-ahead is always one already answered
      if (!line || (line.asks && GO_AHEAD.test(watch.ask))) {
        beat.phase = "dropped";
        deps.log?.(`turn beats: the ${kind} for ${watch.threadId} was skipped`);
        return;
      }
      beat.text = line.text;
      beat.asks = line.asks;
      beat.phase = "ready";
      tick(watch);
    }, (error: unknown) => {
      if (beat.phase !== "writing") return;
      beat.phase = "dropped";
      deps.log?.(`turn beats: the ${kind} for ${watch.threadId} was not written (${error instanceof Error ? error.message.slice(0, 160) : "unknown"})`);
    });
  };

  const post = (watch: Watch, kind: BeatKind, beat: Beat) => {
    beat.phase = "posted";
    const text = beat.text!;
    watch.posted.push(text);
    watch.said.push(text);
    watch.lastWordAt = now();
    watch.stepsAtLastWord = watch.steps.length;
    try {
      deps.post({ botId: watch.botId, threadId: watch.threadId, turnId: watch.turnId!, text, kind });
      deps.log?.(`turn beats: sent the ${kind} in ${watch.threadId} ${now() - watch.startedAt} ms after the message`);
    } catch (error) {
      deps.log?.(`turn beats: could not post in ${watch.threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** The engine is writing a message right now, maybe its result. */
  const composing = (watch: Watch) => watch.streaming;

  const tick = (watch: Watch) => {
    if (watches.get(watch.threadId) !== watch) return;
    const at = now();
    const elapsed = at - watch.startedAt;
    const { ack, plan, milestone } = watch;
    const engineSpoke = watch.engineTextAt > 0;
    // Written while the engine starts up: the small model takes about as long as the ack may wait.
    if (ack.phase === "idle" && (watch.work || watch.tools > 0) && !engineSpoke) write(watch, "ack", ack);
    if (!watch.turnId) {
      if (elapsed > UNSTARTED_MS) end(watch);
      return;
    }
    // Its end was never heard (a quarantined event, a retired turn): nothing more to say for it.
    if (!deps.live(watch.threadId, watch.turnId)) return end(watch);
    if (ack.phase === "ready") {
      // a question for a detail is wrong once the turn is working without it
      if (engineSpoke || (ack.asks && watch.tools > 0)) ack.phase = "dropped";
      else if (elapsed >= ACK_MIN_MS && (watch.tools > 0 || (elapsed >= ACK_IDLE_MS && !watch.asksFirst && (watch.thinking || deps.showsThinking?.(watch.threadId) === false)))) post(watch, "ack", ack);
    }
    if (ack.phase === "writing" || (ack.phase === "idle" && !engineSpoke && !watch.tools)) return;

    const spokenBefore = watch.posted.length + watch.engineMessages;
    // After an ack, whoever sent it; the writer skips it when what was said already tells them what they will get.
    const planWanted = spokenBefore >= 1 && spokenBefore <= MAX_SAID_BEFORE_PLAN;
    if (plan.phase === "idle" && elapsed >= PLAN_WRITE_MS && watch.tools > 0 && planWanted && !composing(watch)) write(watch, "plan", plan);
    if (plan.phase === "ready") {
      if (!planWanted) plan.phase = "dropped";
      else if (elapsed >= PLAN_MIN_MS && !watch.waiting && !composing(watch)) post(watch, "plan", plan);
    }

    const lastWord = Math.max(watch.lastWordAt, watch.engineTextAt, watch.milestoneTriedAt);
    const quietFor = at - (lastWord || watch.startedAt);
    if (milestone.phase === "posted" || milestone.phase === "dropped") Object.assign(milestone, { phase: "idle", text: undefined, abort: undefined });
    if (milestone.phase === "idle" && watch.milestones < MAX_MILESTONES && plan.phase !== "writing" && plan.phase !== "ready" &&
        quietFor >= MILESTONE_QUIET_MS && watch.steps.length - watch.stepsAtLastWord >= 2 && !composing(watch) && !watch.waiting) {
      watch.milestones++;
      watch.milestoneTriedAt = at;
      write(watch, "milestone", milestone);
    }
    if (milestone.phase === "ready") {
      if (composing(watch) || at - watch.engineTextAt < MILESTONE_QUIET_MS / 2) milestone.phase = "dropped";
      else if (!watch.waiting) post(watch, "milestone", milestone);
    }
  };

  return {
    /** A direct turn is about to start for the person's message. */
    start(input: BeatStart): void {
      const old = watches.get(input.threadId);
      if (old) end(old);
      if (input.unattended || !input.text.trim() || !deps.enabled()) return;
      const watch: Watch = {
        botId: input.botId, threadId: input.threadId, ask: input.text, work: looksLikeWork(input.text, input.attachments), startedAt: now(),
        asksFirst: ASKS_FIRST.test(deps.bot(input.botId)?.soul ?? ""),
        tools: 0, toolsDone: 0, engineTextAt: 0, engineMessages: 0, said: [], streaming: false, thinking: false, planRewritten: false, steps: [], stepsAtLastWord: 0, lastWordAt: 0, waiting: false,
        ack: { phase: "idle" }, plan: { phase: "idle" }, milestone: { phase: "idle" }, milestones: 0, milestoneTriedAt: 0, posted: [],
        timer: setInterval(() => tick(watch), TICK_MS),
      };
      watch.timer.unref?.();
      watches.set(input.threadId, watch);
      tick(watch);
    },

    onEvent(event: RuntimeEvent): void {
      const watch = watches.get(event.threadId);
      if (!watch) return;
      if (event.type === "turn.started") {
        if (!watch.turnId && event.turnId) watch.turnId = event.turnId;
        else if (event.turnId && event.turnId !== watch.turnId) end(watch);
        return;
      }
      if (event.turnId && watch.turnId && event.turnId !== watch.turnId) return;
      switch (event.type) {
        case "item.started":
          if (event.itemType === "reasoning") watch.thinking = true;
          if (event.itemType !== "tool") return;
          watch.tools++;
          watch.streaming = false;
          {
            const step = derivedLabel(event, "en", undefined, STEP_CHARS)?.label;
            if (step && watch.steps.at(-1) !== step) watch.steps.push(step);
          }
          break;
        case "item.completed":
          if (event.itemType === "tool") watch.toolsDone++;
          else if (event.itemType === "assistant_text" && event.text.trim()) {
            watch.engineMessages++;
            watch.streaming = false;
            // Written before this message: once more, so it does not repeat it.
            if ((watch.plan.phase === "writing" || watch.plan.phase === "ready") && !watch.planRewritten) {
              watch.plan.abort?.abort();
              Object.assign(watch.plan, { phase: "idle", text: undefined, abort: undefined });
              watch.planRewritten = true;
            }
            watch.said.push(event.text.replace(/\s+/g, " ").trim().slice(0, SAID_CHARS));
            watch.engineTextAt = now();
          }
          break;
        case "content.delta":
          if (event.streamKind === "reasoning_text") watch.thinking = true;
          if (event.streamKind === "assistant_text" && event.delta.trim()) {
            watch.engineTextAt = now();
            watch.streaming = true;
          }
          break;
        case "request.opened":
          watch.waiting = true;
          break;
        case "request.resolved":
          watch.waiting = false;
          break;
        case "turn.completed":
        case "cap.exhausted":
        case "session.exited":
          end(watch);
          return;
        case "runtime.error":
          if (event.terminal) end(watch);
          return;
        default:
          return;
      }
      tick(watch);
    },

    /** The lines sent in the bot's name during the thread's last turn, said once to the engine with the next message. */
    note(threadId: string): string {
      const lines = notes.get(threadId);
      notes.delete(threadId);
      return beatsNote(lines ?? []);
    },
  };
}

export type TurnBeats = ReturnType<typeof createTurnBeats>;
