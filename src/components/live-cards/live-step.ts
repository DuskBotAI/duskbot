import { groupActivityRuns, isToolStep, type ActivityTranscriptItem } from "@/lib/activity-runs";
import { localDay } from "@/lib/transcript-derivations";
import type { Message } from "@/state/store";
import { isBrowserStep, type BrowserStep } from "./browser-step";
import { isCommandStep, type CommandStep } from "./command-step";

export type LiveCardKind = "command" | "browser";

export function liveCardKind(message: Message): LiveCardKind | null {
  return isCommandStep(message) ? "command" : isBrowserStep(message) ? "browser" : null;
}

export function isLiveCardStep(message: Message): boolean {
  return liveCardKind(message) !== null;
}

export type LiveSegment =
  | { kind: "command"; steps: CommandStep[]; through: string[] }
  | { kind: "browser"; steps: BrowserStep[]; through: string[] };

export function liveSegments(messages: readonly Message[]): LiveSegment[] {
  const segments: LiveSegment[] = [];
  for (const message of messages) {
    const kind = liveCardKind(message);
    const current = segments.at(-1);
    if (!kind) {
      current?.through.push(message.id);
      continue;
    }
    if (current?.kind === kind) {
      (current.steps as Message[]).push(message);
      current.through.push(message.id);
    } else segments.push({ kind, steps: [message], through: [message.id] } as LiveSegment);
  }
  return segments;
}

const stepsOf = (item: ActivityTranscriptItem): Message[] => (item.kind === "run" ? item.messages : [item.message]);

function continuesBrowsing(before: readonly Message[], next: readonly Message[]): boolean {
  const first = before[0], joining = next[0];
  if (!first || !joining || !before.every(isToolStep) || !next.every(isToolStep)) return false;
  if (first.role !== joining.role || first.from?.botId !== joining.from?.botId || localDay(first.at) !== localDay(joining.at)) return false;
  const last = before.map(liveCardKind).findLast(Boolean);
  const opening = next.map(liveCardKind).find(Boolean);
  return last === "browser" && (opening === "browser" || opening === undefined);
}

export function groupLiveCardRuns(messages: Message[]): ActivityTranscriptItem[] {
  const items: ActivityTranscriptItem[] = [];
  for (const item of groupActivityRuns(messages)) {
    const next = stepsOf(item);
    const previous = items.at(-1);
    const before = previous ? stepsOf(previous) : [];
    if (previous && continuesBrowsing(before, next)) items[items.length - 1] = { kind: "run", id: `run:${before[0]!.id}`, messages: [...before, ...next] };
    else if (item.kind === "message" && isBrowserStep(item.message)) items.push({ kind: "run", id: `run:${item.message.id}`, messages: next });
    else items.push(item);
  }
  return items;
}
