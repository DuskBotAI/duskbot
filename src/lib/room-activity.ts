import type { Message } from "@/state/store";
import { isStatusActivity } from "@/lib/activity-runs";
import { failedTurnCause } from "../../shared/failed-turn";
import { isLiveCardStep } from "@/components/live-cards/live-step";

export function roomActivityVisible(message: Message, showToolCalls: boolean, liveCards = false): boolean {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool) return false;
  // a member that hasn't answered yet is the working line's; one that never did is the card's
  if (tool.rescue) return false;
  if (message.comm || message.threadRef || message.relay || message.dataResult || isStatusActivity(message)) return true;
  // a reply that never came shows in the card above the composer, not as a row
  if (failedTurnCause(tool.name) !== null) return tool.partial === true;
  return showToolCalls || (liveCards && isLiveCardStep(message));
}
