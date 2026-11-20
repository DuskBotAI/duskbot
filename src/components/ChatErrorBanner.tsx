import { useState, type ReactNode } from "react";
import { t } from "@/lib/i18n";
import { friendlyError } from "@/lib/plain-error";
import { api, useStore, type AppState } from "@/state/store";
import { ErrorDetailsCopy } from "./ErrorDetailsCopy";
import { ConnectAiDialog } from "./onboarding/ConnectAi";
import { Icon } from "./Icon";
import { NoticeGlyph } from "./ui/Notice";
import type { PixelIconName } from "./ui/PixelIcon";

// a prompt notice: one 12/16 line above the message box on the notice tone (--color-notice), as every banner there is
export const NOTICE_LINE = "flex items-start gap-1.5 rounded-[12px] bg-(--color-notice) px-3 py-2 text-[12px] leading-4";

export function ChatNotice({ notice }: { notice: AppState["notice"] }) {
  if (!notice) return null;
  return (
    <div className="w-full px-5">
      <div role="status" className={`mb-2 ${NOTICE_LINE} text-ink-secondary`}>
        {notice.kind === "note"
          ? <>{notice.found || notice.connect ? <span className="min-w-0 flex-1">{notice.text}</span> : notice.text}{notice.found && <UseFoundAi found={notice.found} />}{notice.connect && <ConnectAiButton />}</>
          : notice.kind === "steer-images"
            ? t("composer.queued.steerImagesHeld")
            : notice.kind === "bot-gone"
              ? t("thread.botGone")
              : notice.botName ? t("conversation.goneShowing", { name: notice.botName }) : t("conversation.gone")}
      </div>
    </div>
  );
}

/** Opens the connect flow for a send no AI could take; the note clears once one is connected, and they send again. */
function ConnectAiButton() {
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" data-connect-ai-note="" onClick={() => setOpen(true)}
      className="-my-1 shrink-0 rounded-full bg-ink/[0.06] px-2.5 py-1 text-[12px] leading-4 text-ink hover:bg-ink/[0.1]">
      {t("onboarding.meet.connectAi")}
    </button>
    {open && <ConnectAiDialog tested={null} onClose={() => { setOpen(false); dispatch({ type: "notice", notice: null }); }} />}
  </>;
}

/** Turns on an AI the person's send found waiting, then clears the note; they send again. */
function UseFoundAi({ found }: { found: { instanceId: string; name: string } }) {
  const { dispatch, refreshInstances } = useStore();
  const [busy, setBusy] = useState(false);
  const use = () => {
    setBusy(true);
    void api(`/api/instances/${encodeURIComponent(found.instanceId)}`, { method: "PATCH", body: JSON.stringify({ chosen: true }) })
      .then(() => refreshInstances().catch(() => {}))
      .then(() => dispatch({ type: "notice", notice: null }), () => setBusy(false));
  };
  return (
    <button type="button" data-use-found-ai={found.instanceId} disabled={busy} onClick={use}
      className="-my-1 shrink-0 rounded-full bg-ink/[0.06] px-2.5 py-1 text-[12px] leading-4 text-ink hover:bg-ink/[0.1] disabled:opacity-50">
      {busy ? t("engines.found.using") : t("engines.found.use")}
    </button>
  );
}

// the error tray: one coloured glyph, a 14/20 title, quiet words and ink pill actions on the notice tone, no line
const CARD = "flex items-start gap-2.5 rounded-[14px] border border-transparent bg-(--color-notice) px-3 py-2.5 text-[13px] leading-[18px] text-ink";
export const CARD_ACTION = "ui-button ui-button-sm ui-button-pill border-transparent bg-ink/[0.06] text-ink hover:bg-ink/[0.1]";

export function ChatErrorCard({ tone = "danger", icon, title, details, children, actions, onDismiss, className = "" }: {
  tone?: "danger" | "warning" | "info";
  /** what the notice is about, as a pixel picture; the tone's own when absent */
  icon?: PixelIconName;
  title: ReactNode;
  /** The technical words behind a plain title: reported and copyable for support, never shown. */
  details?: string | null;
  children?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} data-chat-error="" className={`${CARD} ${className}`}>
      <NoticeGlyph tone={tone} icon={icon} />
      <div className="min-w-0 flex-1 break-words">
        <span className="block font-medium">{title}</span>
        {details && <ErrorDetailsCopy details={details} />}
        {children}
        {actions && <div className="mt-2 flex flex-wrap items-center gap-1.5">{actions}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("chat.error.dismiss")}
          title={t("chat.error.dismiss")}
          className="-my-0.5 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink/68 hover:bg-ink/6 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus pointer-coarse:size-11 pointer-coarse:-my-2.5"
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}

export function ChatErrorBanner({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) return null;
  const plain = friendlyError(message);
  return (
    <div className="mb-2 w-full px-5">
      <ChatErrorCard title={plain} details={plain !== message ? message : null} onDismiss={onDismiss} />
    </div>
  );
}
