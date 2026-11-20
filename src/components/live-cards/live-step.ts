import { isToolStep } from "@/lib/activity-runs";
import type { Message } from "@/state/store";
import { isBrowserStep, type BrowserStep } from "./browser-step";
import { isCommandStep, type CommandStep } from "./command-step";

export type StepUnit =
  | { kind: "command"; id: string; step: CommandStep }
  | { kind: "browser"; id: string; steps: BrowserStep[]; through: string[] };

export function stepUnits(messages: readonly Message[]): StepUnit[] {
  const units: StepUnit[] = [];
  let stretch: Extract<StepUnit, { kind: "browser" }> | null = null;
  for (const message of messages) {
    if (isCommandStep(message)) {
      units.push({ kind: "command", id: message.id, step: message });
      stretch = null;
    } else if (isBrowserStep(message)) {
      if (stretch) {
        stretch.steps.push(message);
        stretch.through.push(message.id);
      } else units.push(stretch = { kind: "browser", id: message.id, steps: [message], through: [message.id] });
    } else if (isToolStep(message)) stretch?.through.push(message.id);
    else stretch = null;
  }
  return units;
}

export function latestTurn(messages: readonly Message[], own: (message: Message) => boolean = () => true): Message[] {
  const turnId = messages.findLast((message) => message.turnId && own(message))?.turnId;
  if (turnId) return messages.filter((message) => message.turnId === turnId && own(message));
  return messages.slice(messages.findLastIndex((message) => message.role === "user") + 1).filter(own);
}

export function browsingNow({ steps, through, live, room, turnEnded, replying }: {
  steps: readonly BrowserStep[];
  through: readonly string[];
  live: ReadonlySet<string>;
  room: boolean;
  turnEnded: boolean;
  replying: boolean;
}): boolean {
  const last = steps.at(-1);
  if (!last || turnEnded || replying || !live.has(last.id)) return false;
  const newest = [...live].at(-1);
  return through.includes(newest!) || (room && last.tool.ok === undefined);
}
