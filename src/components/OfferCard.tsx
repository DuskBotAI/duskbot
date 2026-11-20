// A suggestion dusk bot made on its own: the find and the offer as the server wrote them, with Do it, Not now and Don't
// suggest this. Do it starts the work as the person's own request; the others teach it what to leave alone.
import { useState } from "react";
import { Loader2 } from "../icons";

import { t } from "@/lib/i18n";
import { friendlyError } from "@/lib/plain-error";
import { openThread } from "@/state/thread-navigation";
import { api, useStore, type Message } from "@/state/store";
import type { OfferAnswer } from "../../shared/offer";
import { CARD_BUTTON_MD, cardPrimary, cardSecondary, cardTertiary } from "./AskCard";
import { ChatMarkdown } from "./ChatMarkdown";
import { SIMPLE_BOT_BUBBLE, SIMPLE_BUBBLE_MAX } from "./chat-bubble";
import { cn } from "@/lib/cn";

export function OfferCard({ threadId, message }: { threadId?: string; message: Message }) {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState<OfferAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const offer = message.offer;
  if (!offer) return null;
  const doIt = cardPrimary(CARD_BUTTON_MD);
  const started = offer.started && offer.started.threadId !== threadId ? offer.started : undefined;

  const reply = async (answer: OfferAnswer) => {
    if (saving || !threadId) return;
    setSaving(answer);
    setError(null);
    try {
      await api("/api/offers/answer", { method: "POST", body: JSON.stringify({ threadId, messageId: message.id, offerId: offer.id, answer }) });
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setSaving(null);
    }
  };
  const spinner = <Loader2 size={14} className="animate-spin" />;

  return (
    <div data-offer={offer.id} className="text-ink">
      <div data-chat-bubble="simple" className={cn("w-fit", SIMPLE_BUBBLE_MAX, SIMPLE_BOT_BUBBLE)}><ChatMarkdown text={message.text ?? ""} /></div>
      {offer.answer ? (
        <p dir="auto" className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] text-ink-secondary">
          <span>{offer.answer === "do" ? t("chat.offer.started", { name: offer.botName }) : offer.answer === "notNow" ? t("chat.offer.notNowDone") : t("chat.offer.neverDone")}</span>
          {started && (
            <button type="button" data-testid="offer-open" onClick={() => openThread(dispatch, started, state)} className="font-medium text-ink underline-offset-2 hover:underline">
              {t("chat.offer.open")}
            </button>
          )}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" data-testid="offer-do" onClick={() => void reply("do")} disabled={saving !== null} className={doIt.className} style={doIt.style}>
            {saving === "do" ? spinner : t("chat.offer.doIt")}
          </button>
          <button type="button" data-testid="offer-not-now" onClick={() => void reply("notNow")} disabled={saving !== null} className={cardSecondary(CARD_BUTTON_MD)}>
            {saving === "notNow" ? spinner : t("chat.offer.notNow")}
          </button>
          <button type="button" data-testid="offer-never" onClick={() => void reply("never")} disabled={saving !== null} className={cardTertiary(CARD_BUTTON_MD)}>
            {saving === "never" ? spinner : t("chat.offer.never")}
          </button>
        </div>
      )}
      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
