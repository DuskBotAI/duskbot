import { isToolStep } from "@/lib/activity-runs";
import type { Message } from "@/state/store";
import type { LiveStep } from "../../../shared/turn-progress";

export type CommandStep = Message & { tool: NonNullable<Message["tool"]> & { step: LiveStep } };

export function isCommandStep(message: Message): message is CommandStep {
  return isToolStep(message) && message.tool.step?.activity === "command";
}

export function commandText(step: LiveStep): string {
  return step.detail ?? step.target;
}

export type CommandState = "running" | "done" | "failed" | "ended";

export function commandState(tool: Pick<NonNullable<Message["tool"]>, "ok">, live: boolean): CommandState {
  if (tool.ok === undefined) return live ? "running" : "ended";
  return tool.ok ? "done" : "failed";
}
