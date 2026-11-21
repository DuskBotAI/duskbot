import { useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { keyInSend, offerToSecretCard, withoutKey, withoutKeys, type KeyInSend } from "@/lib/composer-secret";
import type { Message } from "@/state/store";
import type { FollowUp } from "../../shared/follow-up";
import { CARD_ACTION, ChatErrorCard } from "./ChatErrorBanner";

/** Above the composer when the words about to go hold a key: keep it out (into the open Secrets card, or out of the
 * words), or send anyway. Nothing is sent until one is chosen. */
export function ComposerKeyWarning({ botName, cardLabel, onKeepOut, onSendAnyway, onDismiss }: {
  botName: string;
  /** the open Secrets card's label; null when no card waits for a value */
  cardLabel: string | null;
  onKeepOut: () => void;
  onSendAnyway: () => void;
  onDismiss: () => void;
}) {
  return (
    <div data-composer-key-warning="" className="mb-2" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onDismiss(); } }}>
      <ChatErrorCard
        tone="warning"
        icon="key"
        title={t("composer.key.title")}
        onDismiss={onDismiss}
        actions={<>
          <button type="button" autoFocus data-key-keep-out onClick={onKeepOut} className={cn(CARD_ACTION, "font-medium")}>
            {t(cardLabel ? "composer.key.toCard" : "composer.key.remove")}
          </button>
          <button type="button" data-key-send-anyway onClick={onSendAnyway} className={CARD_ACTION}>{t("composer.key.sendAnyway")}</button>
        </>}
      >
        <span className="mt-0.5 block text-ink-secondary">
          {cardLabel ? t("composer.key.cardBody", { label: cardLabel, name: botName }) : t("composer.key.body", { name: botName })}
        </span>
      </ChatErrorCard>
    </div>
  );
}

/** The composer's hold on a send whose words hold a key. `holds` stops such a send and shows the warning; `warning`
 * draws it, with Send anyway calling `send` again past the check. Any change to `reset` drops a shown warning. */
export function useKeyGate({ text, reset, messages, botName, keep, focus }: {
  text: string;
  reset: string;
  messages: readonly Message[] | undefined;
  botName: string;
  /** puts the words, keys taken out, back in the field */
  keep: (rest: string) => void;
  /** returns the caret to the field once the warning is gone, unless the key's Secrets card took it */
  focus: () => void;
}) {
  const [held, setHeld] = useState<(KeyInSend & { followUp: FollowUp | undefined }) | null>(null);
  const allowed = useRef(false);
  useEffect(() => setHeld(null), [reset]);
  const holds = (body: string, followUp: FollowUp | undefined): boolean => {
    const key = allowed.current ? null : keyInSend(body, messages);
    setHeld(key && { ...key, followUp });
    return key !== null;
  };
  const warning = (send: (followUp: FollowUp | undefined) => void): ReactNode => held && (
    <ComposerKeyWarning
      botName={botName}
      cardLabel={held.cardId ? messages?.find((message) => message.id === held.cardId)?.secret?.label ?? null : null}
      onKeepOut={() => {
        setHeld(null);
        if (held.cardId) {
          offerToSecretCard(held.cardId, held.key);
          keep(withoutKey(text, held.key));
        } else {
          keep(withoutKeys(text));
          focus();
        }
      }}
      onSendAnyway={() => {
        allowed.current = true;
        try { send(held.followUp); } finally { allowed.current = false; }
      }}
      onDismiss={() => { setHeld(null); focus(); }}
    />
  );
  return { holds, warning };
}
