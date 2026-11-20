// What a request in a chat started that keeps running beside it: a thread the bot opened on itself (start_thread) and a
// background job it started without the person's card. A person's Stop on that chat stops them too, as long as the
// request that started them is still the chat's current one. Teammates' hand-offs end through the handoff tree, and
// automations or jobs the person set up earlier are never in here.

export type TurnWorker =
  | { kind: "thread"; botId: string; threadId: string; queuedId?: string }
  | { kind: "job"; botId: string; jobId: string };

export interface TurnWorkersDeps {
  /** The generations of the chat's current request (its turn and the carry-ons it took), or undefined when none runs. */
  generations(threadId: string): ReadonlySet<string> | undefined;
  stopThread(worker: Extract<TurnWorker, { kind: "thread" }>): Promise<void>;
  stopJob(worker: Extract<TurnWorker, { kind: "job" }>): void;
}

const KEPT_PER_CHAT = 32;

export function createTurnWorkers(deps: TurnWorkersDeps) {
  const byChat = new Map<string, Array<{ generation: string; worker: TurnWorker }>>();

  const current = (threadId: string) => {
    const generations = deps.generations(threadId);
    return (byChat.get(threadId) ?? []).filter((entry) => generations?.has(entry.generation));
  };

  return {
    started(threadId: string, generation: string, worker: TurnWorker): void {
      byChat.set(threadId, [...current(threadId), { generation, worker }].slice(-KEPT_PER_CHAT));
    },

    /** Stops every worker the chat's current request started; returns how many it stopped. */
    async stop(threadId: string): Promise<number> {
      const workers = current(threadId).map((entry) => entry.worker);
      byChat.delete(threadId);
      await Promise.all(workers.map(async (worker) => {
        if (worker.kind === "job") deps.stopJob(worker);
        else await deps.stopThread(worker).catch(() => undefined);
      }));
      return workers.length;
    },

    forget(threadId: string): void {
      byChat.delete(threadId);
    },
  };
}

export type TurnWorkers = ReturnType<typeof createTurnWorkers>;
