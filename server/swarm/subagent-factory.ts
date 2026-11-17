import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SubagentSpec {
  name: string;
  role: string;
  brief: string;
  modelInstanceId?: string;
  workspaceMode: "inherit" | "share" | "branch";
  parentThreadId: string;
}

export type SubagentStatus = "idle" | "working" | "stopped" | "killed";

export interface SubagentHandle {
  id: string;
  spec: SubagentSpec;
  workspacePath: string;
  status: SubagentStatus;
  createdAt: number;
  lastActiveAt: number;
  kill: () => Promise<void>;
  dispatch: (instruction: string) => Promise<{ reply: string }>;
}

export class SubagentConcurrencyLimitError extends Error {
  constructor(limit: number) {
    super(`Subagent concurrency limit reached (${limit}). Terminate an idle worker before spawning a new one.`);
    this.name = "SubagentConcurrencyLimitError";
  }
}

export class SubagentFactory {
  private activeSubagents = new Map<string, SubagentHandle>();
  private readonly maxConcurrency: number;

  constructor(maxConcurrency = 3) {
    this.maxConcurrency = maxConcurrency;
  }

  async spawnSubagent(spec: SubagentSpec): Promise<SubagentHandle> {
    const runningCount = Array.from(this.activeSubagents.values()).filter(
      (s) => s.status === "working" || s.status === "idle"
    ).length;

    if (runningCount >= this.maxConcurrency) {
      throw new SubagentConcurrencyLimitError(this.maxConcurrency);
    }

    const id = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const isBranch = spec.workspaceMode === "branch";
    const workspacePath = isBranch
      ? mkdtempSync(join(tmpdir(), `dusk-subagent-${spec.name}-`))
      : process.cwd();

    const now = Date.now();
    const handle: SubagentHandle = {
      id,
      spec,
      workspacePath,
      status: "idle",
      createdAt: now,
      lastActiveAt: now,
      kill: async () => {
        handle.status = "killed";
        if (isBranch) {
          rmSync(workspacePath, { recursive: true, force: true });
        }
        this.activeSubagents.delete(id);
      },
      dispatch: async (instruction: string) => {
        handle.status = "working";
        handle.lastActiveAt = Date.now();
        // Dispatches to subagent worker loop
        const simulatedOutcome = `[${spec.name}] Completed: ${instruction.slice(0, 40)}`;
        handle.status = "idle";
        return { reply: simulatedOutcome };
      },
    };

    this.activeSubagents.set(id, handle);
    return handle;
  }

  listSubagents(parentThreadId?: string): SubagentHandle[] {
    const all = Array.from(this.activeSubagents.values());
    return parentThreadId ? all.filter((s) => s.spec.parentThreadId === parentThreadId) : all;
  }

  async killAll(): Promise<void> {
    const promises = Array.from(this.activeSubagents.values()).map((s) => s.kill());
    await Promise.all(promises);
    this.activeSubagents.clear();
  }
}
