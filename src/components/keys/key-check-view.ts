import { t } from "@/lib/i18n";

/** The server's plain answer for a pasted key. */
export type KeyCheckOutcome = "works" | "busy" | "wrong_key" | "no_credit" | "wrong_model" | "unreachable";

export interface KeyCheckAnswer { ok?: unknown; reason?: unknown; result?: unknown; model?: unknown; suggestedModel?: unknown }

export interface KeyCheckView {
  outcome: KeyCheckOutcome;
  tone: "ok" | "warn" | "bad";
  title: string;
  line: string;
  /** wrong key or wrong model: nothing is saved */
  blocks: boolean;
  /** no credit or not checked: saved only after Save anyway */
  confirm: boolean;
  /** the address was refused before the key went anywhere */
  address: boolean;
  suggestedModel?: string;
}

const OUTCOMES = new Set<string>(["works", "busy", "wrong_key", "no_credit", "wrong_model", "unreachable"]);

function outcomeOf(answer: KeyCheckAnswer): KeyCheckOutcome {
  if (typeof answer.result === "string" && OUTCOMES.has(answer.result)) return answer.result as KeyCheckOutcome;
  if (answer.ok === true) return "works";
  return answer.reason === "rejected" ? "wrong_key" : "unreachable";
}

export function keyCheckView(answer: KeyCheckAnswer, provider: string): KeyCheckView {
  const outcome = outcomeOf(answer);
  const address = answer.reason === "address";
  const model = typeof answer.model === "string" ? answer.model : "";
  const suggestedModel = outcome === "wrong_model" && typeof answer.suggestedModel === "string" ? answer.suggestedModel : undefined;
  const base = { outcome, blocks: outcome === "wrong_key" || outcome === "wrong_model", confirm: outcome === "no_credit" || outcome === "unreachable", address };
  switch (outcome) {
    case "works": return { ...base, tone: "ok", title: t("keys.check.works.title"), line: t("keys.check.works.line", { provider }) };
    case "busy": return { ...base, tone: "ok", title: t("keys.check.works.title"), line: t("keys.check.busy.line", { provider }) };
    case "wrong_key": return { ...base, tone: "bad", title: t("keys.check.wrongKey.title"), line: t("keys.check.wrongKey.line", { provider }) };
    case "no_credit": return { ...base, tone: "warn", title: t("keys.check.noCredit.title"), line: t("keys.check.noCredit.line", { provider }) };
    case "wrong_model": return { ...base, tone: "bad", title: t("keys.check.wrongModel.title"), line: t("keys.check.wrongModel.line", { provider, model }), ...(suggestedModel ? { suggestedModel } : {}) };
    case "unreachable": return address
      ? { ...base, tone: "warn", title: t("keys.check.address.title"), line: t("keys.testAddress") }
      : { ...base, tone: "warn", title: t("keys.check.unreachable.title", { provider }), line: t("keys.check.unreachable.line") };
  }
}

export const keyWorks = (view: KeyCheckView | null): boolean => view?.outcome === "works" || view?.outcome === "busy";
