import { describe, expect, it } from "vitest";

import { createTurnWorkers, type TurnWorker } from "./turn-workers.ts";

describe("turn workers", () => {
  it("a stop ends what the current request started, and nothing an earlier request started", async () => {
    const current = new Map<string, Set<string>>([["parent", new Set(["g2", "g3"])]]);
    const stopped: TurnWorker[] = [];
    const workers = createTurnWorkers({
      generations: (threadId) => current.get(threadId),
      stopThread: async (worker) => { stopped.push(worker); },
      stopJob: (worker) => { stopped.push(worker); },
    });
    workers.started("parent", "g1", { kind: "job", botId: "b", jobId: "old-watch" });
    workers.started("parent", "g2", { kind: "thread", botId: "b", threadId: "child" });
    workers.started("parent", "g3", { kind: "job", botId: "b", jobId: "new-job" });

    expect(await workers.stop("parent")).toBe(2);
    expect(stopped).toEqual([{ kind: "thread", botId: "b", threadId: "child" }, { kind: "job", botId: "b", jobId: "new-job" }]);
    expect(await workers.stop("parent")).toBe(0);
  });

  it("keeps going when one worker fails to stop", async () => {
    const stopped: string[] = [];
    const workers = createTurnWorkers({
      generations: () => new Set(["g"]),
      stopThread: async (worker) => { if (worker.threadId === "a") throw new Error("gone"); stopped.push(worker.threadId); },
      stopJob: () => {},
    });
    workers.started("p", "g", { kind: "thread", botId: "b", threadId: "a" });
    workers.started("p", "g", { kind: "thread", botId: "b", threadId: "c" });
    expect(await workers.stop("p")).toBe(2);
    expect(stopped).toEqual(["c"]);
  });
});
