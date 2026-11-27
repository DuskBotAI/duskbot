import { useCallback, useState, type ReactNode } from "react";
import { Share } from "../../icons";

import { t } from "@/lib/i18n";
import { BOT_SHARING_ENABLED } from "../../../shared/bot-sharing";
import { useStore, type Bot } from "@/state/store";
import { Toast } from "../ui/Toast";
import { saveAccess } from "./access";
import { ShareBotDialog, type AccessChange } from "./ShareBotDialog";

/** The team's name, or null anywhere but a team. */
export function useTeamName(): string | null {
  const { state } = useStore();
  const team = (state.config as { team?: { name?: unknown } } | null | undefined)?.team;
  return typeof team?.name === "string" && team.name ? team.name : null;
}

/** A bot's Share button on a team: opens who has access. `headerMenu` holds what else the button offers there. */
export function ShareBotButton({ bot, className, headerMenu, iconSize = 16 }: { bot: Bot; className: string; headerMenu?: ReactNode; iconSize?: number }) {
  const teamName = useTeamName();
  const [open, setOpen] = useState(false);
  const [change, setChange] = useState<AccessChange | null>(null);
  const settled = useCallback(() => setChange(null), []);
  if (!teamName || !BOT_SHARING_ENABLED) return null;
  return (
    <>
      <button type="button" data-panel-share data-share-bot-button aria-label={t("botAccess.share")} title={t("botAccess.share")}
        aria-haspopup="dialog" onClick={() => setOpen(true)} className={className}>
        <Share size={iconSize} aria-hidden="true" className="pointer-events-none" />
      </button>
      {open && <ShareBotDialog bot={bot} teamName={teamName} onClose={() => setOpen(false)} onChanged={setChange} headerMenu={headerMenu} />}
      {change && <UndoToast key={`${change.text}:${JSON.stringify(change.after)}`} text={change.text}
        onUndo={() => saveAccess(bot.id, change.before)} onDone={settled} />}
    </>
  );
}

/** "Bob can now chat · Undo", Grok's undo toast; Undo puts the sharing back as it was. */
export function UndoToast({ text, onUndo, onDone, failedText, timeoutMs }: {
  text: string; onUndo: () => Promise<unknown>; onDone: () => void;
  failedText?: string;
  timeoutMs?: number;
}) {
  const [failed, setFailed] = useState(false);
  const [undoing, setUndoing] = useState(false);
  return <Toast data-access-toast="" text={failed ? failedText ?? t("botAccess.undoFailed") : text} tone={failed ? "error" : "done"} onDone={onDone} timeoutMs={timeoutMs}
    action={failed ? undefined : { label: t("common.undo"), disabled: undoing, onClick: () => {
      setUndoing(true);
      void onUndo().then(onDone, () => setFailed(true)).finally(() => setUndoing(false));
    } }} />;
}
