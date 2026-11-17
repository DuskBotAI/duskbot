import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PersistentTaskQueue } from "./task-queue.ts";

describe("Persistent FIFO Task Queue & Crash Resiliency", () => {
  let tempDir: string;
  let dbPath: string;
  let queue: PersistentTaskQueue;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dusk-queue-test-"));
    dbPath = join(tempDir, "test-tasks.wal.sqlite");
    queue = new PersistentTaskQueue(dbPath);
  });

  afterEach(() => {
    queue.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("enqueues and drains tasks in FIFO order respecting priorities", () => {
    queue.enqueue({
      taskId: "task-1",
      botId: "echo",
      threadId: "thread-1",
      title: "Sort support tickets",
      payloadJson: JSON.stringify({ action: "sort" }),
      priority: 1,
    });

    queue.enqueue({
      taskId: "task-2",
      botId: "echo",
      threadId: "thread-1",
      title: "URGENT: Alert operator",
      payloadJson: JSON.stringify({ action: "alert" }),
      priority: 10,
    });

    queue.enqueue({
      taskId: "task-3",
      botId: "echo",
      threadId: "thread-1",
      title: "Clean trash",
      payloadJson: JSON.stringify({ action: "clean" }),
      priority: 1,
    });

    const first = queue.getNextPending("echo");
    expect(first?.taskId).toBe("task-2");
    expect(first?.priority).toBe(10);

    queue.updateStatus("task-2", "completed");

    const second = queue.getNextPending("echo");
    expect(second?.taskId).toBe("task-1");

    queue.updateStatus("task-1", "completed");

    const third = queue.getNextPending("echo");
    expect(third?.taskId).toBe("task-3");
  });

  it("recovers in-flight tasks as paused upon unexpected reboot/restart", () => {
    queue.enqueue({
      taskId: "task-reboot",
      botId: "nova",
      threadId: "thread-2",
      title: "Long crawling job",
      payloadJson: JSON.stringify({ url: "https://example.com" }),
    });

    queue.updateStatus("task-reboot", "in_progress");
    queue.close();

    const restartedQueue = new PersistentTaskQueue(dbPath);
    const tasks = restartedQueue.listTasks("nova");
    const recovered = tasks.find((t) => t.taskId === "task-reboot");

    expect(recovered?.status).toBe("paused");
    expect(recovered?.error).toContain("application reboot");

    restartedQueue.close();
  });
});
