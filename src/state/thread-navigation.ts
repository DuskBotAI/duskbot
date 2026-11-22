import type { Action, AppState } from "./store";
import { openOwnTeamChat, teamChats } from "./team-chats";

interface NotificationThreadOwner {
  id: string;
  threadId: string;
  mainThreadId?: string;
  tasks?: Array<RowThread>;
}

type RowThread = { threadId: string; activity?: string; unread?: boolean; busy?: boolean; routineRunId?: unknown; archivedAt?: unknown; updatedAt?: number; createdAt?: number };

interface NotificationRoutingState {
  bots: NotificationThreadOwner[];
  groups: NotificationThreadOwner[];
}

export function visibleNotificationThread(
  state: NotificationRoutingState & Pick<AppState, "activeView" | "selectedId">,
): string | null {
  if (state.activeView !== "chat") return null;
  return (
    state.bots.find((candidate) => candidate.id === state.selectedId)?.threadId ??
    state.groups.find((candidate) => candidate.id === state.selectedId)?.threadId ??
    null
  );
}

export function botOpensTo(bot: Pick<NotificationThreadOwner, "threadId" | "mainThreadId" | "tasks">, threadsShown = false): string {
  return !threadsShown && bot.mainThreadId && bot.tasks?.some((task) => task.threadId === bot.mainThreadId)
    ? bot.mainThreadId : bot.threadId;
}

export function awayFromMainThread(bot: Pick<NotificationThreadOwner, "threadId" | "mainThreadId" | "tasks">): boolean {
  return botOpensTo(bot) !== bot.threadId;
}

/** On a team's Cloud, the person's own conversation with the bot, never the team's main chat (team-chats.ts). */
export function openBot(
  dispatch: (action: Action) => void,
  bot: Pick<NotificationThreadOwner, "id" | "threadId" | "mainThreadId" | "tasks"> & { yourAccess?: string },
  threadsShown = false,
): string | null {
  if (openOwnTeamChat(dispatch, bot, (threadId) => openBotThread(dispatch, bot, threadId, threadsShown))) return null;
  const opened = botOpensTo(bot, threadsShown);
  if (opened === bot.threadId) dispatch({ type: "select", id: bot.id });
  else openBotThread(dispatch, bot, opened, threadsShown);
  return opened;
}

const threadStamp = (task: RowThread) => task.updatedAt ?? task.createdAt ?? 0;

function newestOf(bot: Pick<NotificationThreadOwner, "threadId" | "mainThreadId" | "tasks">, picked: (task: RowThread) => boolean): string | null {
  const home = botOpensTo(bot);
  const found = (bot.tasks ?? []).filter((task) => !task.routineRunId && picked(task))
    .sort((a, b) => Number(b.threadId === home) - Number(a.threadId === home) || threadStamp(b) - threadStamp(a));
  return found[0]?.threadId ?? null;
}

export function markedThread(bot: Pick<NotificationThreadOwner, "threadId" | "mainThreadId" | "tasks">): string | null {
  return newestOf(bot, (task) => task.activity === "waiting-on-you");
}

/** The conversation the bot is busy in right now, such as a job another bot handed it; the one it opens to when that one is busy. */
export function workingThread(bot: Pick<NotificationThreadOwner, "threadId" | "mainThreadId" | "tasks">): string | null {
  return newestOf(bot, (task) => task.archivedAt === undefined && (task.busy === true || task.activity === "working"));
}

/** A click on a bot's row or tile opens the thread its mark is about, else the one it is working in; with neither, or with
 * that thread already on screen, the bot as ever. Every other way into a bot is `openBot`. On a team a bot's row is the
 * person's own chat. Returns the thread it opened, or null for a team's own chat. */
export function openBotRow(
  dispatch: (action: Action) => void,
  bot: Pick<NotificationThreadOwner, "id" | "threadId" | "mainThreadId" | "tasks"> & { yourAccess?: string },
  onScreen: boolean,
): string | null {
  const marked = teamChats() ? null : markedThread(bot) ?? workingThread(bot);
  if (!marked || marked === botOpensTo(bot) || (onScreen && marked === bot.threadId)) return openBot(dispatch, bot);
  openBotThread(dispatch, bot, marked);
  return marked;
}

/** With threads hidden the switch alone selects the bot, so the thread left behind keeps its unread mark. */
export function openBotThread(
  dispatch: (action: Action) => void,
  bot: Pick<NotificationThreadOwner, "id" | "threadId">,
  threadId: string,
  threadsShown = false,
) {
  if (threadsShown || threadId === bot.threadId) dispatch({ type: "select", id: bot.id });
  dispatch({ type: "switchTask", botId: bot.id, threadId });
}

/** A hand-off's chip for work in a room: the thread it names while the room still has it, else the room. */
export function openRoomThread(dispatch: (action: Action) => void, comm: { groupId: string; threadId?: string }, groups: readonly NotificationThreadOwner[]) {
  dispatch({ type: "select", id: comm.groupId });
  const room = groups.find((candidate) => candidate.id === comm.groupId);
  if (comm.threadId && room?.tasks?.some((task) => task.threadId === comm.threadId)) dispatch({ type: "switchGroupTask", groupId: comm.groupId, threadId: comm.threadId });
}

export interface ThreadTarget {
  botId: string;
  threadId: string;
}

interface ThreadOpeningState extends NotificationRoutingState {
  bots: Array<NotificationThreadOwner & { name: string }>;
}

/** The one way a click on a bot's message reaches its thread, wherever the thread is and whoever started it: a room's, or
 * any bot's own. A thread that is gone says so on its bot, never silently on some other chat. */
export function openThread(
  dispatch: (action: Action) => void,
  target: ThreadTarget,
  state: ThreadOpeningState,
  threadsShown = false,
): boolean {
  const owns = (owner: NotificationThreadOwner) =>
    owner.threadId === target.threadId || (owner.tasks ?? []).some((task) => task.threadId === target.threadId);
  // A room notification carries the asker bot with the room's thread id; switching the bot to it would 404.
  const group = state.groups.find(owns), owner = group ? undefined : state.bots.find(owns);
  const named = state.bots.find((candidate) => candidate.id === target.botId);
  if (group) {
    dispatch({ type: "select", id: group.id });
    if (group.threadId !== target.threadId) dispatch({ type: "switchGroupTask", groupId: group.id, threadId: target.threadId });
  } else if (owner) openBotThread(dispatch, owner, target.threadId, threadsShown);
  else if (named) openBot(dispatch, named, threadsShown);
  dispatch({ type: "revealThread", threadId: target.threadId });
  if (group || owner) return true;
  dispatch({ type: "notice", notice: { kind: "thread-gone", botName: named?.name ?? null } });
  return false;
}
