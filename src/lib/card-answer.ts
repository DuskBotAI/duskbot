// The kind comes from the card, never the pressed label: a question answered allow/deny is refused and the bot waits out its timeout.
import { QUESTION_DISMISS_MESSAGE } from "../../shared/ask-question";

interface CardKind {
  tool?: string;
}
export interface CardResponse {
  behavior: "allow" | "deny" | "answer";
  /** "Allow for this task": the rest of the task stops asking for the same reason. */
  always?: true;
  message?: string;
  dismiss?: boolean;
}

export const ALLOW_FOR_TASK = "Allow for this task";

export function answerResponse(card: CardKind, answer: string): CardResponse {
  if (!card.tool) return { behavior: "answer", message: answer };
  if (answer === ALLOW_FOR_TASK) return { behavior: "allow", always: true };
  return { behavior: answer === "Deny" ? "deny" : "allow" };
}

export function dismissResponse(card: CardKind): CardResponse {
  if (card.tool) return { behavior: "deny", message: "Dismissed by user." };
  return {
    behavior: "answer",
    message: QUESTION_DISMISS_MESSAGE,
    dismiss: true,
  };
}
