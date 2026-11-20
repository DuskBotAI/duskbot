import { formatQuestionAnswers } from "../../shared/ask-question.ts";
import { liveCardKind } from "../../shared/live-approval.ts";
import type { OptionCardData } from "../../shared/wire.ts";

export interface CardChoice { label: string; reply: { behavior: "allow" | "deny" | "answer"; message?: string } }

const MAX_CHOICES = 8;

/** The buttons a card gets in the owner's chat app, or null when only dusk bot can answer it. Security: the same cards a
 * Live call or a 👍 may answer (liveCardKind): a review, a purchase or a setup change still waits for dusk bot. */
export function cardChoices(card: OptionCardData | undefined): CardChoice[] | null {
  const kind = liveCardKind(card);
  if (!card || !kind || kind === "review") return null;
  if (kind === "approval") return [{ label: "Allow", reply: { behavior: "allow" } }, { label: "Deny", reply: { behavior: "deny", message: "Denied by the user." } }];
  const questions = card.questionRequest?.questions;
  if (!questions) {
    return card.options.length && card.options.length <= MAX_CHOICES
      ? card.options.map((label) => ({ label, reply: { behavior: "answer", message: label } }))
      : null;
  }
  const only = questions.length === 1 && !questions[0]!.multiSelect ? questions[0]! : null;
  if (!only?.options.length || only.options.length > MAX_CHOICES) return null;
  return only.options.map((option) => ({ label: option.label, reply: { behavior: "answer", message: formatQuestionAnswers(questions, [[option.label]]) } }));
}

export function cardText(card: OptionCardData): string {
  return [card.title, card.subtitle].map((part) => part?.trim()).filter(Boolean).join("\n\n") || "dusk bot is waiting for your answer.";
}
