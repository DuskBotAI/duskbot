// The side responder's prompt and its answer. While a turn works, the person's new message gets a quick reply from a
// small fast model in the bot's voice, and that reply says what happens to the running task: nothing (answer), a note
// passed into it (steer), a separate ask taken on beside it (task), or it ends (stop) or makes way for the new ask (redirect).
import { z } from "zod";

import { redactSecretsInText } from "./redact.ts";

export type SideKind = "answer" | "steer" | "task" | "stop" | "redirect";

export interface SideDecision {
  kind: SideKind;
  reply: string;
}

export interface SideLine {
  who: "person" | "bot";
  text: string;
}

export interface SideTaskState {
  /** The request the running task works on. */
  ask: string;
  minutes: number;
  /** The status line's words for what it does right now. */
  status?: string;
  /** What it has done so far, in plain words, newest last. */
  steps: readonly string[];
  checklist?: { title?: string; done: number; total: number; next?: string };
  /** What the bot has told the person during this task. */
  said: readonly string[];
  /** Separate asks the person added while it runs, taken on beside it. */
  added?: readonly string[];
}

export interface SidePromptInput {
  name: string;
  soul?: string;
  task: SideTaskState;
  /** The conversation before the new message, oldest first. */
  recent: readonly SideLine[];
  message: string;
  /** The running task reads a note right away; otherwise it reads it when the current step ends. */
  notesNow: boolean;
  /** A new separate ask can run beside the task now; otherwise it starts once the task is done. */
  tasksNow?: boolean;
}

const SOUL_CHARS = 800;
const ASK_CHARS = 800;
const LINE_CHARS = 300;
const MESSAGE_CHARS = 1_500;
const STEPS = 8;
const RECENT = 8;
export const REPLY_CHARS = 900;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function sideReplyPrompt(input: SidePromptInput): string {
  const { name, task } = input;
  const soul = clip(input.soul ?? "", SOUL_CHARS);
  const steps = task.steps.slice(-STEPS).map((step) => `- ${clip(step, 120)}`).join("\n") || "- (no steps yet)";
  const said = task.said.slice(-3).map((line) => `- ${clip(line, LINE_CHARS)}`).join("\n");
  const list = task.checklist;
  const recent = input.recent.slice(-RECENT).map((line) => `${line.who === "person" ? "Person" : name}: ${clip(line.text, LINE_CHARS)}`).join("\n");
  return [
    `You are ${name}, in a chat. You are in the middle of a task for the person and keep working on it; their new message arrived while you work. Write your quick reply to it and decide what happens to the task.`,
    soul ? `About ${name}, in its own setup: ${soul}` : `${name} is a helpful assistant.`,
    "",
    "The task you are working on (what the person asked):",
    "<<<",
    clip(task.ask, ASK_CHARS) || "(not known)",
    ">>>",
    ...(task.added?.length ? ["Also asked during this task, being done alongside it:", ...task.added.slice(-STEPS).map((ask) => `- ${clip(ask, 160)}`)] : []),
    `Working on it for about ${Math.max(1, Math.round(task.minutes))} min.${task.status ? ` Right now: ${clip(task.status, 80)}.` : ""}`,
    "Steps so far, newest last:",
    steps,
    ...(list ? [`Checklist${list.title ? ` "${clip(list.title, 80)}"` : ""}: ${list.done} of ${list.total} done${list.next ? `, next: ${clip(list.next, 100)}` : ""}.`] : []),
    ...(said ? ["What you told the person during this task:", said] : []),
    "",
    "The conversation before the new message, oldest first:",
    recent || "(none)",
    "",
    "The person's new message:",
    "<<<",
    clip(input.message, MESSAGE_CHARS),
    ">>>",
    "",
    "Pick one kind:",
    "- answer: a question or small talk, about the task, its progress, you, or anything else you can answer from what is above or what you know; the task carries on untouched. A question about the task, its progress or you is always answer. Never pick answer for a request to find, make, check or do something, or for a question about something outside this task that needs looking up (weather, prices, news, their accounts): that is task, which you can look up.",
    `- steer: extra information, a correction or a preference for the task in progress. Reply with a short acknowledgement of what you will do with it. ${input.notesNow
      ? "It reaches the work right away."
      : "It reaches the work as soon as the current step finishes: say so in a few words."}`,
    `- task: a new, separate request that leaves the task in progress as it is (something else to find, make, check or do), or a question about something else that you cannot answer from what is above or what you know (is it raining there, what a price is now, the news): you look it up. Reply with a short acknowledgement naming what you will do. ${input.tasksNow === false
      ? "It starts as soon as the task in progress is done: say so in a few words."
      : "You do it alongside the task in progress, which keeps going: say so in a few words."}`,
    "- stop: they want the task stopped or cancelled and nothing new. Confirm in a few words.",
    "- redirect: they say to drop or replace the task in progress (instead, forget that, not that) for something different they describe. Confirm in a few words what you will do instead. A new request that does not drop the task is task, not redirect.",
    "Never stop or redirect for a question, thanks, praise, impatience, extra details or a new request. When unsure, pick answer, steer or task.",
    "",
    "Rules for the reply:",
    `- Write as ${name}, in the first person, in the language of the new message. To the person you are the one doing the work: never mention another process, a helper, a model, tools or the app.`,
    "- Short and plain: one to three sentences, at most 60 words. No greeting, no emoji.",
    "- You can look anything up as a task, so never say you cannot check or see something. Never state results, numbers, prices or facts that are not given above, and never promise a time. If you do not know yet, say the task is still running. Never say a new request is done.",
    "",
    'Answer with exactly one line of JSON and nothing else: {"kind": "answer" | "steer" | "task" | "stop" | "redirect", "reply": "..."}',
  ].join("\n");
}

const decisionShape = z.object({
  kind: z.enum(["answer", "steer", "task", "stop", "redirect"]),
  reply: z.string(),
});

/** The model's decision, or null when it wrote anything but one valid decision with a usable reply. */
export function parseSideDecision(raw: string): SideDecision | null {
  const text = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = decisionShape.safeParse(value);
  if (!parsed.success) return null;
  const reply = redactSecretsInText(parsed.data.reply.replace(/\r/g, "").trim());
  if (!reply || reply.length > REPLY_CHARS || reply.includes("```")) return null;
  return { kind: parsed.data.kind, reply };
}

/** The note the running turn reads with the person's words when they steer it. */
export function steerNote(reply: string): string {
  return `[dusk bot: you already answered this message in the chat with ${JSON.stringify(reply)}. Take it into the work you are doing now; do not reply to it on its own.]`;
}

/** The note a continuation reads when the running turn could not take the message mid-turn. */
export function continuationNote(reply: string): string {
  return `[dusk bot: the person sent this while your last turn was running, so that turn was paused or ended, and you answered in the chat with ${JSON.stringify(reply)}. Take it into the task you were working on: carry on with what is left of it, and if that part is already done, adjust the result to fit.]`;
}

/** The note the new turn reads after the person redirected the running one. */
export function redirectNote(reply: string): string {
  return `[dusk bot: the person asked you to drop what you were doing for this, so that task was stopped. You answered in the chat with ${JSON.stringify(reply)}. Do this now.]`;
}

/** The note the running turn reads with a separate ask the person added while it works. */
export function taskNote(reply: string): string {
  return `[dusk bot: this is a separate new task, sent while you work on the earlier one; you already answered it in the chat with ${JSON.stringify(reply)}. Keep the earlier task going and do this one alongside it, running independent steps at the same time where you can. Send each result as soon as it is ready, opening with which ask it finishes, and keep the other ask in view until both are done.]`;
}

/** The note the next turn reads with a separate ask that waited for the running turn to end. */
export function queuedTaskNote(reply: string): string {
  return `[dusk bot: the person sent this separate task while your last turn was running, and you answered in the chat with ${JSON.stringify(reply)}. Do it now; if the earlier task is not finished, finish that too, and open each result with which ask it finishes.]`;
}

/** The note with a message sent right after the one that started the turn, before the bot said anything. */
export function burstNote(earlier: string): string {
  const before = earlier ? `their message before it, ${JSON.stringify(earlier.slice(0, 1_500))}` : "their message before it";
  return `[dusk bot: the person sent this right after ${before}, before you replied. Read both as one message and answer them together, once.]`;
}
