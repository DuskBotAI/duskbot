import { useState, useSyncExternalStore } from "react";
import { Check, CreditCard, ExternalLink, Image as ImageIcon, MapPin, Store, X } from "../icons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { openExternalLink } from "@/lib/app-links";
import type { Message, OptionCardData } from "@/state/store";
import type { EmailEdits, EmailReview } from "../../shared/email-review";
import type { MessageEdits, MessageReview } from "../../shared/message-review";
import type { PurchaseSummary } from "../../shared/purchase";
import type { ProductsCard } from "../../shared/products";

const FIELD = "w-full min-w-0 rounded-[10px] bg-(--card-fill) px-2.5 py-1.5 text-[14px] leading-5 text-ink placeholder:text-ink-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus";
const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/u;

export interface EmailDraft { to: string; subject: string; body: string }

const drafts = new Map<string, EmailDraft>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The email card's open edit, shared by its body and its buttons; null while it is not being edited. */
export function useEmailDraft(requestId: string): [EmailDraft | null, (next: EmailDraft | null) => void] {
  const read = () => drafts.get(requestId) ?? null;
  const draft = useSyncExternalStore(subscribe, read, read);
  const set = (next: EmailDraft | null) => {
    if (next) drafts.set(requestId, next);
    else drafts.delete(requestId);
    for (const listener of listeners) listener();
  };
  return [draft, set];
}

export const draftOf = (email: EmailReview): EmailDraft => ({ to: email.to.join(", "), subject: email.subject, body: email.body });

/** The edits a draft makes, or null when an address does not read as one or the text is empty. */
export function draftEdits(email: EmailReview, draft: EmailDraft): EmailEdits | null {
  const to = draft.to.split(/[,;]/u).map((part) => part.trim()).filter(Boolean);
  if (!draft.body.trim() || (!email.reply && (!to.length || !to.every((address) => ADDRESS.test(address))))) return null;
  return {
    ...(email.reply ? {} : { to }),
    ...(email.reply ? {} : { subject: draft.subject }),
    body: draft.body,
  };
}

export const messageDraftOf = (message: MessageReview): EmailDraft => ({ to: message.to, subject: "", body: message.text });

/** The edit a message draft makes, or null when its text is empty. */
export const messageDraftEdits = (draft: EmailDraft): MessageEdits | null => draft.body.trim() ? { text: draft.body } : null;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3 text-[13px] leading-5">
      <span className="w-16 shrink-0 text-ink-tertiary">{label}</span>
      <span dir="auto" className="min-w-0 flex-1 break-words text-ink">{children}</span>
    </div>
  );
}

export function EmailReviewView({ email, requestId, editable }: { email: EmailReview; requestId?: string; editable?: boolean }) {
  const [draft, setDraft] = useEmailDraft(requestId ?? "");
  const editing = editable && draft;
  return (
    <div data-email-review="" className="space-y-1.5 rounded-[14px] bg-(--card-code-fill) px-3.5 py-3">
      {editing ? (
        <>
          {!email.reply && <input aria-label={t("emailReview.to")} dir="ltr" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} className={FIELD} />}
          {!email.reply && <input aria-label={t("emailReview.subject")} dir="auto" value={draft.subject} onChange={(event) => setDraft({ ...draft, subject: event.target.value })} className={FIELD} />}
          <textarea aria-label={t("emailReview.body")} dir="auto" rows={8} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} className={cn(FIELD, "max-h-72 resize-y")} />
        </>
      ) : (
        <>
          {email.to.length > 0 && <Row label={t("emailReview.to")}>{email.to.join(", ")}</Row>}
          {email.cc?.length ? <Row label={t("emailReview.cc")}>{email.cc.join(", ")}</Row> : null}
          {email.subject && <Row label={t("emailReview.subject")}><span className="font-medium">{email.subject}</span></Row>}
          <p dir="auto" tabIndex={0} aria-label={t("emailReview.body")} className="max-h-60 overflow-auto whitespace-pre-wrap break-words pt-1.5 text-[14px] leading-[21px] text-ink">{email.body}</p>
        </>
      )}
    </div>
  );
}

export function MessageReviewView({ message, requestId, editable }: { message: MessageReview; requestId?: string; editable?: boolean }) {
  const [draft, setDraft] = useEmailDraft(requestId ?? "");
  const editing = editable && draft;
  return (
    <div data-message-review="" className="space-y-1.5 rounded-[14px] bg-(--card-code-fill) px-3.5 py-3">
      {message.to ? <Row label={t("messageReview.to")}>{message.to}</Row> : <Row label={t("messageReview.on")}>{message.app}</Row>}
      {message.reply && <p className="text-[13px] leading-5 text-ink-tertiary">{t("messageReview.reply")}</p>}
      {editing ? (
        <textarea aria-label={t("messageReview.text")} dir="auto" rows={6} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} className={cn(FIELD, "max-h-72 resize-y")} />
      ) : (
        <p dir="auto" tabIndex={0} aria-label={t("messageReview.text")} className="max-h-60 overflow-auto whitespace-pre-wrap break-words pt-1.5 text-[14px] leading-[21px] text-ink">{message.text}</p>
      )}
      {message.attachments ? <p className="text-[13px] leading-5 text-ink-secondary">{t(message.attachments === 1 ? "messageReview.attachments.one" : "messageReview.attachments", { count: message.attachments })}</p> : null}
    </div>
  );
}

export function PurchaseSummaryView({ purchase }: { purchase: PurchaseSummary }) {
  return (
    <div data-purchase-summary="" className="space-y-2.5 rounded-[14px] bg-(--card-code-fill) px-3.5 py-3">
      <p dir="auto" className="flex items-center gap-1.5 text-[13px] text-ink-secondary">
        <Store size={13} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate">{purchase.merchant}</span>
      </p>
      <ul data-purchase-items="" tabIndex={0} aria-label={t("purchase.recordTitle", { merchant: purchase.merchant })} className="max-h-40 space-y-1 overflow-y-auto overscroll-contain">
        {purchase.items.map((item, index) => (
          <li key={index} className="flex min-w-0 items-baseline gap-2 text-[14px] leading-5 text-ink">
            <span className="shrink-0 tabular-nums text-ink-secondary">{item.quantity} ×</span>
            <span dir="auto" className="min-w-0 flex-1 break-words">{item.name}</span>
            {item.price && <span className="shrink-0 tabular-nums">{item.price}</span>}
          </li>
        ))}
      </ul>
      <div className="space-y-1">
        {purchase.shipping && <Row label={t("purchase.shipping")}>{purchase.shipping}</Row>}
        <div className="flex items-baseline justify-between gap-3 text-[15px] font-semibold leading-[22px] text-ink">
          <span>{t("purchase.total")}</span>
          <span className="tabular-nums">{purchase.total}</span>
        </div>
      </div>
      {(purchase.paymentMethod || purchase.address || purchase.delivery) && (
        <div className="space-y-1">
          {purchase.paymentMethod && <p dir="auto" className="flex items-center gap-1.5 text-[13px] text-ink-secondary"><CreditCard size={13} aria-hidden="true" className="shrink-0" />{purchase.paymentMethod}</p>}
          {purchase.address && <p dir="auto" className="flex items-start gap-1.5 text-[13px] text-ink-secondary"><MapPin size={13} aria-hidden="true" className="mt-0.5 shrink-0" /><span className="min-w-0 break-words">{purchase.address}</span></p>}
          {purchase.delivery && <Row label={t("purchase.arrives")}>{purchase.delivery}</Row>}
        </div>
      )}
    </div>
  );
}

/** What a settled purchase, email or message card says happened. */
function reviewOutcome(card: OptionCardData): { done: boolean; line: string } {
  const allowed = card.answered === "allow" && !card.expired;
  if (card.purchase) {
    if (card.purchase.recorded) return { done: true, line: t("purchase.recorded") };
    return { done: allowed, line: t(allowed ? "purchase.confirmed" : card.answered === "unavailable" || card.expired ? "purchase.expired" : "purchase.cancelled") };
  }
  return { done: allowed, line: t(allowed ? "emailReview.sent" : card.answered === "unavailable" || card.expired ? "emailReview.expired" : "emailReview.notSent") };
}

function recordTitle(card: OptionCardData): string {
  if (card.purchase) return t("purchase.recordTitle", { merchant: card.purchase.merchant });
  if (card.messageReview) return t(card.messageReview.post ? "messageReview.postRecordTitle" : "messageReview.recordTitle", { app: card.messageReview.app });
  return t("emailReview.recordTitle", { app: card.email?.app ?? "" });
}

/** A purchase, email or message card once answered: what was bought or sent, kept in the chat as the record. */
export function ReviewRecord({ card }: { card: OptionCardData }) {
  const outcome = reviewOutcome(card);
  return (
    <div data-review-record={card.purchase ? "purchase" : card.messageReview ? "message" : "email"} className="w-full max-w-[460px] space-y-2 rounded-[20px] bg-panel p-3">
      <p className="px-1 text-[14px] font-semibold leading-5 text-ink">{recordTitle(card)}</p>
      {card.purchase ? <PurchaseSummaryView purchase={card.purchase} /> : card.email ? <EmailReviewView email={card.email} /> : card.messageReview ? <MessageReviewView message={card.messageReview} /> : null}
      <p className="flex items-center gap-1.5 px-1 text-[13px] text-ink-secondary">
        {outcome.done ? <Check size={14} className="text-success" aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
        {outcome.line}
      </p>
    </div>
  );
}

export const showsReviewRecord = (card: OptionCardData | undefined): boolean =>
  Boolean(card && (card.purchase || card.email || card.messageReview) && (card.answered || card.expired || card.dismissed));

/** Products a bot found, side by side: photo, name, price, shop and a link. Photos load once the person asks. */
export function ProductsMessage({ message }: { message: Message }) {
  const card: ProductsCard | undefined = message.products;
  const [photos, setPhotos] = useState(false);
  if (!card?.items.length) return null;
  const hasPhotos = card.items.some((item) => item.image);
  return (
    <div data-products="" className="w-full min-w-0 max-w-full">
      {(card.title || (hasPhotos && !photos)) && (
        <div className="mb-1.5 flex items-center gap-2 px-1">
          {card.title && <p dir="auto" className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-secondary">{card.title}</p>}
          {hasPhotos && !photos && (
            <button type="button" onClick={() => setPhotos(true)} title={t("attach.externalHidden")}
              className="ms-auto inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[12px] text-ink-secondary hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              <ImageIcon size={12} aria-hidden="true" />{t("products.showPhotos")}
            </button>
          )}
        </div>
      )}
      <ul role="list" aria-label={card.title ?? t("products.label")} className="-mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
        {card.items.map((item, index) => (
          <li key={index} className="flex w-44 shrink-0 snap-start flex-col overflow-hidden rounded-[16px] bg-panel pointer-coarse:w-40">
            <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-(--card-fill)">
              {item.image && photos
                ? <img src={item.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" draggable={false} className="size-full object-contain" />
                : <Store size={22} aria-hidden="true" className="text-ink-tertiary" />}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-0.5 px-2.5 pb-2.5 pt-2">
              <p dir="auto" className="line-clamp-2 text-[13px] font-medium leading-[18px] text-ink" title={item.name}>{item.name}</p>
              {item.price && <p className="text-[14px] font-semibold tabular-nums leading-5 text-ink">{item.price}</p>}
              {(item.merchant || item.note) && <p dir="auto" className="line-clamp-2 text-[12px] leading-4 text-ink-tertiary">{[item.merchant, item.note].filter(Boolean).join(" · ")}</p>}
              <a href={item.url} target="_blank" rel="noopener noreferrer"
                onClick={(event) => { event.preventDefault(); void openExternalLink(item.url); }}
                className="mt-auto inline-flex items-center gap-1 self-start rounded-full pt-1.5 text-[12px] font-medium text-accent-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                {t("products.view")}<ExternalLink size={11} aria-hidden="true" />
              </a>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
