import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SubagentConcurrencyLimitError, SubagentFactory } from "./subagent-factory.ts";

describe("Subagent Spawning & Swarm Lifecycle", () => {
  it("spawns subagent in isolated branch workspace and tears down cleanly", async () => {
    const factory = new SubagentFactory(3);

    const subagent = await factory.spawnSubagent({
      name: "parser",
      role: "Codebase Parser",
      brief: "Parse AST and extract exports",
      workspaceMode: "branch",
      parentThreadId: "room-shop",
    });

    expect(subagent.status).toBe("idle");
    expect(existsSync(subagent.workspacePath)).toBe(true);

    const result = await subagent.dispatch("Extract exports from server/index.ts");
    expect(result.reply).toContain("[parser] Completed");

    await subagent.kill();
    expect(subagent.status).toBe("killed");
    expect(existsSync(subagent.workspacePath)).toBe(false);
  });

  it("enforces concurrency limit to prevent resource exhaustion", async () => {
    const factory = new SubagentFactory(2);

    await factory.spawnSubagent({
      name: "worker-1",
      role: "Worker 1",
      brief: "Job 1",
      workspaceMode: "inherit",
      parentThreadId: "thread-1",
    });

    await factory.spawnSubagent({
      name: "worker-2",
      role: "Worker 2",
      brief: "Job 2",
      workspaceMode: "inherit",
      parentThreadId: "thread-1",
    });

    await expect(
      factory.spawnSubagent({
        name: "worker-3",
        role: "Worker 3",
        brief: "Job 3",
        workspaceMode: "inherit",
        parentThreadId: "thread-1",
      })
    ).rejects.toThrow(SubagentConcurrencyLimitError);

    await factory.killAll();
  });
});
