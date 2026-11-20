import { useState, type ReactNode } from "react";

import { Reply, TextQuote, X } from "../icons";

import { cn } from "@/lib/cn";
import { peerLine } from "@/lib/peer-message";
import { useQuotedMessage } from "@/lib/quoted-messages";
import { replyAuthor, replySnippet, replyThumbnail } from "@/lib/replies";
import { splitSelectionQuote } from "@/lib/selection-quote";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";

export function ReplyQuote({
  message,
  fallbackName,
  onJump,
  onClear,
  compact = false,
}: {
  message: Message;
  fallbackName?: string;
  onJump?: () => void;
  onClear?: () => void;
  compact?: boolean;
}) {
  const name = replyAuthor(message, fallbackName);
  const body = (
    <>
      <Reply size={compact ? 14 : 15} strokeWidth={1.5} aria-hidden="true" className="shrink-0 rtl:-scale-x-100" />
      <ReplyThumbnail message={message} />
      <span className="sr-only">{t("chat.reply.replyingTo", { name })}: </span>
      <span aria-hidden="true" className="shrink-0 font-medium text-ink">{name}</span>
      <span dir="auto" className="min-w-0 flex-1 truncate">{replySnippet(peerLine(message)?.body ?? message.text ?? "")}</span>
    </>
  );
  return (
    <div data-reply-quote className={cn(
      "flex min-w-0 items-center gap-2 rounded-2xl bg-ink/[0.06] text-ink-secondary",
      compact ? "py-1 ps-2.5 pe-2 text-[13px] leading-5" : "py-1.5 ps-3 pe-1.5 text-[13px] leading-5",
    )}>
      {onJump ? (
        <button type="button" onClick={onJump} className="flex min-w-0 flex-1 items-center gap-2 rounded-xl text-start hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" title={t("chat.reply.jump")}>
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{body}</div>
      )}
      {onClear && (
        <button type="button" onClick={onClear} aria-label={t("chat.reply.cancel")} className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** A sent reply's quote, found however far back the quoted message is from the rows this client holds. */
export function ThreadReplyQuote({ threadId, replyToId, loaded, fallbackName, onJump }: {
  threadId: string;
  replyToId: string;
  loaded: Message | undefined;
  fallbackName?: string;
  onJump: (target: Message) => void;
}) {
  const target = useQuotedMessage(threadId, replyToId, loaded);
  if (!target) return null;
  return (
    <div className="mb-2">
      <ReplyQuote message={target} fallbackName={fallbackName} compact onJump={() => onJump(target)} />
    </div>
  );
}

function ReplyThumbnail({ message }: { message: Message }) {
  const thumbnail = replyThumbnail(message);
  const [failed, setFailed] = useState<string | null>(null);
  if (!thumbnail || failed === thumbnail) return null;
  return <img src={thumbnail} alt="" data-reply-thumbnail="" loading="lazy" draggable={false} onError={() => setFailed(thumbnail)}
    className="-my-0.5 size-6 shrink-0 rounded-md bg-inset object-cover" />;
}

export function ComposerReplyStrip({
  message,
  fallbackName,
  onClear,
}: {
  message: Message;
  fallbackName?: string;
  onClear?: () => void;
}) {
  const who = t("chat.reply.replyingTo", { name: replyAuthor(message, fallbackName) });
  const excerpt = replySnippet(peerLine(message)?.body ?? message.text ?? "");
  return (
    <div
      role="group"
      aria-label={who}
      title={who}
      data-composer-reply=""
      className="mb-1 flex min-w-0 items-center gap-2 rounded-2xl bg-ink/[0.06] py-1.5 ps-3 pe-1.5 text-[13px] leading-5 text-ink-secondary"
    >
      <Reply size={15} strokeWidth={1.5} aria-hidden="true" className="shrink-0 rtl:-scale-x-100" />
      <ReplyThumbnail message={message} />
      <span className="sr-only">{who}: </span>
      <span dir="auto" className="min-w-0 flex-1 truncate">{excerpt}</span>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label={t("chat.reply.cancel")}
          title={t("chat.reply.cancel")}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function ComposerSelectionQuote({ quote, onClear }: { quote: string; onClear: () => void }) {
  return (
    <div
      role="group"
      aria-label={t("chat.selection.quoted")}
      data-composer-selection-quote=""
      className="mb-1 flex min-w-0 items-start gap-2 rounded-2xl bg-ink/[0.06] py-1.5 ps-3 pe-1.5 text-[13px] leading-5 text-ink-secondary"
    >
      <TextQuote size={15} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span dir="auto" className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{quote}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={t("chat.selection.remove")}
        title={t("chat.selection.remove")}
        // -my-0.5: the 24px button never makes the row taller than the 20px text line, so the block stays even top and bottom
        className="-my-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <X size={14} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  );
}

export function QuotedText({ text, render }: { text: string; render: (rest: string) => ReactNode }) {
  const split = splitSelectionQuote(text);
  if (!split) return <>{render(text)}</>;
  return <><SentSelectionQuote quote={split.quote} />{split.rest && render(split.rest)}</>;
}

/** The quoted words at the top of a sent message, tinted from the bubble's own text colour so it reads on any bubble. */
export function SentSelectionQuote({ quote }: { quote: string }) {
  return (
    <div data-sent-selection-quote="" className="mb-1.5 flex min-w-0 items-start gap-1.5 rounded-xl bg-[color-mix(in_srgb,currentColor_10%,transparent)] px-2.5 py-1 text-[13px] leading-5 opacity-80">
      <TextQuote size={14} strokeWidth={1.5} aria-hidden="true" className="mt-[3px] shrink-0" />
      <span className="sr-only">{t("chat.selection.quoted")}: </span>
      <span dir="auto" className="line-clamp-4 min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{quote}</span>
    </div>
  );
}
