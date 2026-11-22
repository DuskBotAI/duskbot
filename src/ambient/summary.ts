// The app page's summary of its bots for the island and the dock: what each is doing, its newest line, and what waits
// on the person. Read from the store and the live turn statuses the page already keeps.
import type { Bot, InstanceInfo, Message } from "@/state/store";
import type { TurnLive } from "@/state/turn-status";
import { botShowsUnread, openAsksOf } from "@/lib/bot-unread";
import { stateForBot } from "@/lib/mascot";
import { t } from "@/lib/i18n";
import { turnNowPhrases } from "@/lib/live-activity";
import { pendingApprovals, type Pending } from "@/components/PendingApproval";
import { lastLine, lastPreviewable, openWait, sidebarPreviewMessages, waitingLine } from "@/components/sidebar-preview";
import { plainPreviewText } from "@/lib/plain-preview";
import { workingThreadId } from "@/components/SidebarWorkingStep";
import { toolLabel, titledCard } from "@/components/ApprovalCard";
import { lowerFirst } from "@/lib/lower-first";
import { answersInOneTap, cardQuestions } from "@/components/QuestionCard";
import { isQuestionCard } from "@/lib/question-card";
import { ambientLabels } from "./labels";
import type { AmbientBot, AmbientMessage, AmbientSnapshot, AmbientStatus, AmbientStep, AmbientViewing, AmbientWait } from "./types";
import { liveReply, shownReplyText } from "@/state/live-reply";
import { isReceipt } from "@/lib/receipts";
import { withoutCitationMarkers } from "@/lib/citations";
import { isClientCancellation } from "../../shared/client-cancel";

/** A proposal (a routine, a skill, a profile, a model, a team setup) needs its full card: the island only opens it. */
export function answerableInPlace(pending: Pending): boolean {
  const card = pending.message.card;
  return !(card?.routineRequest || card?.skillRequest || card?.profileRequest || card?.modelRequest || titledCard(card));
}

function statusOf(bot: Bot, waiting: boolean, live: TurnLive, visible: Message[]): AmbientStatus {
  if (waiting) return "needs-you";
  if (bot.busy) return live.status?.activity === "thinking" ? "thinking" : live.status?.activity === "reply" ? "talking" : "working";
  if (stateForBot({ ...bot, messages: visible }) === "failed") return "error";
  if (botShowsUnread(bot)) return "done";
  return "idle";
}

/** The island shows at most this many of a question's choices; a longer list opens the chat. */
export const ISLAND_CHOICES = 4;

const openQuestion = (message: Message) => {
  const card = message.kind === "options" ? message.card : undefined;
  return card && isQuestionCard(card) && !card.answered && !card.pendingAnswer && !card.dismissed && !card.expired && !card.stopped ? card : null;
};

/** The newest open question in the bot's chat, its choices when one tap answers it, and whether it takes a typed answer. */
export function questionOf(visible: Message[]): { card: NonNullable<Message["card"]>; choices: string[] | null; custom: boolean } | null {
  const message = visible.findLast((entry) => openQuestion(entry));
  const card = message && openQuestion(message);
  if (!card) return null;
  const questions = cardQuestions(card);
  const only = questions.length === 1 && !questions[0]!.multiSelect && !card.accessRequest ? questions[0]! : null;
  const choices = only && answersInOneTap(questions) ? only.options.map((option) => option.label) : null;
  // what main lets through unchanged (electron/ambient-state.mjs), so a tap answers with the very same words
  const fits = choices && choices.length <= ISLAND_CHOICES && choices.every((label) => label.length <= 60 && label === label.replace(/\s+/g, " ").trim());
  // a longer list opens the chat rather than offering only a typed answer
  return { card, choices: fits ? choices : null, custom: Boolean(only && only.custom !== false && (fits || !choices)) };
}

/** Whether the bot waits on the person: a question, an approval or a card of choices in any of its chats. */
export function waitsOnPerson(bot: Bot, visible: Message[] = sidebarPreviewMessages(bot)): boolean {
  return bot.activity === "waiting-on-you" || (bot.tasks ?? []).some((task) => task.activity === "waiting-on-you") || openAsksOf(bot) > 0 || pendingApprovals(visible).length > 0 || Boolean(openWait(bot, visible));
}

const STEPS = new Set<AmbientStep>(["thinking", "reply", "read", "fetch", "web", "search", "command", "write", "edit", "tool"]);
const stepOf = (live: TurnLive): AmbientStep | null => {
  const activity = live.status?.activity;
  return activity && STEPS.has(activity as AmbientStep) ? (activity as AmbientStep) : null;
};

/** Every bot's summary holds this many of its newest messages, each cut to this length; the bot a surface shows holds
 * up to AmbientViewing.limit of them, each cut to the longer length. */
export const CHAT_MESSAGES = 6;
const CHAT_CHARS = 500;
export const VIEWED_CHARS = 2000;
/** The longest stretch of one chat a surface may ask for. */
export const VIEWED_MAX = 120;
const STREAM_CHARS = 4000;

/** The newest things said in the chat, as plain text: the person's messages and the bot's replies, nothing else. */
export function chatOf(visible: readonly Message[], limit = CHAT_MESSAGES, chars = CHAT_CHARS): AmbientMessage[] {
  const said: AmbientMessage[] = [];
  for (let index = visible.length - 1; index >= 0 && said.length < limit; index--) {
    const message = visible[index]!;
    if (message.kind !== "text" || isReceipt(message)) continue;
    const raw = withoutCitationMarkers(message.text ?? "");
    // a long stretch keeps its lines, each read plain; a preview is one line
    const text = (chars > CHAT_CHARS ? raw.split(/\n+/).map(plainPreviewText).filter(Boolean).join("\n") : plainPreviewText(raw)).slice(0, chars);
    if (!text || (message.role !== "user" && isClientCancellation(message.text ?? ""))) continue;
    said.unshift({ id: message.id, from: message.role === "user" ? "you" : "bot", text, at: message.at });
  }
  return said;
}

function streamingOf(threadId: string): { streaming?: string } {
  const text = liveReply(threadId)?.text;
  return text ? { streaming: plainPreviewText(shownReplyText(text)).slice(-STREAM_CHARS) } : {};
}

/** The newest turn was started by a routine: its run card is the newest thing, or the newest person row is its start. */
export function fromRoutine(visible: readonly Message[]): boolean {
  const newest = visible.at(-1);
  if (newest?.kind === "routine.run") return true;
  return Boolean(visible.findLast((message) => message.role === "user")?.routineStart);
}

export function ambientBot(bot: Bot, instances: InstanceInfo[], turnLive: (threadId: string) => TurnLive, viewed = 0): AmbientBot {
  const visible = sidebarPreviewMessages(bot);
  const approvals = pendingApprovals(visible);
  const asks = Math.max(openAsksOf(bot), approvals.length);
  const newest = lastPreviewable(visible);
  const waiting = waitsOnPerson(bot, visible);
  const workingOn = bot.busy ? workingThreadId(bot) : bot.threadId;
  const live = turnLive(workingOn);
  const status = statusOf(bot, waiting, live, visible);
  const inPlace = approvals.find(answerableInPlace);
  const wait = status === "needs-you" ? openWait(bot, visible) : undefined;
  const detail = status === "needs-you"
    ? inPlace ? t("ambient.wantsTo", { action: lowerFirst(toolLabel(inPlace.tool)) }) : waitingLine(bot, visible, instances)
    : bot.busy ? turnNowPhrases(live.status, workingOn === bot.threadId ? newest : undefined)?.phrases[0] ?? t("chat.activity.thinking") : "";
  const question = status === "needs-you" ? questionOf(visible) : null;
  const waits: AmbientWait | null = status !== "needs-you" ? null : question ? "question" : approvals.length ? "approval" : wait?.kind ?? "other";
  const answerable = question && question.card.requestId && (question.choices || question.custom);
  return {
    id: bot.id,
    threadId: bot.threadId,
    name: bot.name,
    color: bot.color,
    body: bot.mascotBody ?? null,
    face: bot.mascotFaceColor ?? null,
    avatar: bot.avatarCrop && bot.avatarCrop !== "mascot" && bot.avatarUrl?.startsWith("/") ? bot.avatarUrl : null,
    status,
    detail,
    line: lastLine(bot, visible, instances),
    at: Math.max(newest?.at ?? 0, bot.turnStartedAt ?? 0),
    unread: botShowsUnread(bot),
    asks,
    approval: inPlace ? { requestId: inPlace.requestId, threadId: bot.threadId, title: inPlace.detail || toolLabel(inPlace.tool) } : null,
    waits,
    question: answerable
      ? { requestId: question.card.requestId!, threadId: bot.threadId, title: cardQuestions(question.card)[0]?.question || question.card.title, choices: question.choices ?? [], custom: question.custom }
      : null,
    step: bot.busy ? stepOf(live) : null,
    ...(bot.busy && bot.turnStartedAt ? { since: bot.turnStartedAt } : {}),
    ...(fromRoutine(visible) ? { scheduled: true } : {}),
    chat: viewed ? chatOf(visible, Math.min(VIEWED_MAX, viewed), VIEWED_CHARS) : chatOf(visible),
    // what it is writing now, word by word, in the chat it writes it to
    ...(bot.busy ? streamingOf(workingOn) : {}),
    ...(viewed && bot.hasMore ? { hasMore: true } : {}),
  };
}

/** Which chat the person has open, whether they are looking at the app, and what they watched there (kept by the page
 * between summaries: bot id to the turn or news it showed). */
export interface Watch {
  selectedId: string | null;
  focused: boolean;
  watched: Map<string, string>;
}

/** One running turn (whatever it is doing), or one piece of news: the same until something new happens. */
function watchKey(bot: Bot, ambient: AmbientBot): string {
  return bot.busy ? `busy:${bot.turnStartedAt ?? ""}` : `${ambient.status}:${ambient.at}`;
}

/** A bot is quiet while what it is doing, or what it said, is what the person watched in the focused app or in a
 * surface's chat (the dock's card, an opened island row): opening a chat, switching between chats, or chatting from the
 * dock never changes the island. */
function watching(bot: Bot, ambient: AmbientBot, watch: Watch, viewed: boolean): AmbientBot {
  const key = watchKey(bot, ambient);
  if ((watch.focused && watch.selectedId === bot.id) || viewed) watch.watched.set(bot.id, key);
  else if (watch.watched.has(bot.id) && watch.watched.get(bot.id) !== key) watch.watched.delete(bot.id);
  return watch.watched.get(bot.id) === key ? { ...ambient, quiet: true } : ambient;
}

/** Every bot the sidebar lists, as the surfaces show them. */
export function ambientSnapshot(bots: Bot[], instances: InstanceInfo[], turnLive: (threadId: string) => TurnLive, lang: string, watch?: Watch, viewing?: AmbientViewing | null): AmbientSnapshot {
  const shown = bots.filter((bot) => !bot.hidden && !bot.movedTo);
  return {
    bots: shown.map((bot) => {
      const ambient = ambientBot(bot, instances, turnLive, viewing?.botId === bot.id ? viewing.limit : 0);
      return watch ? watching(bot, ambient, watch, viewing?.botId === bot.id) : ambient;
    }),
    labels: ambientLabels(),
    lang,
  };
}
