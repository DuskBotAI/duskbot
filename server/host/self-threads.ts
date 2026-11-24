// Who may open a job on itself with start_thread: work a person, or their routine, asked for in this conversation. A
// teammate's hand-off, or a job the bot opened on itself, finishes its own work: a new thread is a new request, outside
// the depth, budget and stop of the one it would serve, so a chain could grow there without end.
import type { Coordinator, HandoffView } from "../coordinator.ts";

export const SELF_THREAD_REFUSAL = "Only a person's own request can open separate threads on yourself, and this turn works on a teammate's hand-off or on a thread you opened yourself. Do the work here, and end with what is still left, so whoever asked can decide. Do not retry.";

/** `handoff`: this turn runs a teammate's hand-off. `requestLine`: the latest line from the user role in this conversation,
 * which a bot's own opening or a teammate's ask marks with `peerAsk`; a person's or a routine's line has none. */
export function selfThreadRefusal(input: { handoff: boolean; requestLine: { peerAsk?: unknown } | undefined }): string | undefined {
  return input.handoff || input.requestLine?.peerAsk ? SELF_THREAD_REFUSAL : undefined;
}

export interface OpenSelfThreadResult {
  status: number;
  body: Record<string, unknown>;
}

/** Runs `start_thread` when a bot opens a thread on itself: either enqueued as a reporting `selfJob` on the runtime
 * (root direct turn when `reportBack` is not false), or started as a plain detached thread whose result stays there. */
export async function openSelfThread(input: {
  bot: { id: string; name: string; color: string };
  fromThreadId: string;
  generation: string;
  title: string;
  message: string;
  sourceTitle: string;
  inRoom: boolean;
  external: boolean;
  reportBack: boolean;
  handoff: boolean;
  requestLine: { peerAsk?: unknown } | undefined;
  coordinator: Coordinator;
  createTask: () => { threadId: string; title: string } | null;
  deleteTask: (threadId: string) => void;
  recordOpened: (task: { threadId: string; title: string }) => void;
  onSelfJobEnqueued: (job: HandoffView) => void;
  startDetached: (threadId: string, opening: string) => Promise<Record<string, unknown>>;
  childLimit: () => number;
  botLimit: () => number;
}): Promise<OpenSelfThreadResult> {
  const refused = selfThreadRefusal({ handoff: input.handoff, requestLine: input.requestLine });
  if (refused) return { status: 409, body: { error: refused } };
  const task = input.createTask();
  if (!task) return { status: 500, body: { error: "couldn't create that thread" } };
  const requesting = input.coordinator.node(input.generation);
  let job: HandoffView | undefined;
  if (input.reportBack && !input.inRoom && !input.external && requesting && requesting.parentId === undefined) {
    try {
      job = input.coordinator.enqueue(
        { threadId: input.fromThreadId, botId: input.bot.id },
        input.generation,
        undefined,
        { threadId: task.threadId, botId: input.bot.id },
        input.message,
        { mode: "work", reply: "resume", thread: "new", selfJob: true },
      ).node;
    } catch (error) {
      input.deleteTask(task.threadId);
      return { status: 409, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  }
  input.recordOpened(task);
  if (job) {
    input.onSelfJobEnqueued(job);
    return {
      status: 201,
      body: {
        threadId: task.threadId,
        title: task.title,
        botId: input.bot.id,
        botName: input.bot.name,
        self: true,
        reportBack: true,
        assignmentId: job.id,
        limit: input.childLimit(),
      },
    };
  }
  const opening = `[Thread you opened yourself${input.sourceTitle ? ` from #${input.sourceTitle}` : ""}. The request below is your own words, not the person's: do the work here and end with a clear result they can read.]\n\n${input.message}`;
  const outcome = await input.startDetached(task.threadId, opening);
  return {
    status: 201,
    body: { threadId: task.threadId, title: task.title, botId: input.bot.id, botName: input.bot.name, self: true, limit: input.botLimit(), ...outcome },
  };
}
