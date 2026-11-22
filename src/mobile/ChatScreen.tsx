import { useEffect, useRef } from "react";
import { Monitor } from "../icons";
import { useStore, type Bot, type Group } from "@/state/store";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { BotAvatar } from "@/components/Avatar";
import { GroupAvatar } from "@/components/GroupAvatar";
import { t } from "@/lib/i18n";
import { BackGlyph, RoundButton } from "./RoundButton";
import { ConnectionPill, useLiveConnection } from "./connection/ConnectionProblem";
import { PhoneChatMenu } from "./PhoneChatMenu";
import { usePlatform } from "./platform";
import { installMessageTimes } from "./message-times";
import { installSwipeReply } from "./swipe-reply";
import { BAR_RANK, useNativeBar } from "./chrome";
import { useNavLeaving } from "./NavStack";

const PRESS_CLICK_MS = 1000;

/** The shared chat, with floating glass nav in place of its header row: back, the bot's pill (its profile) centred,
 * and the computer. The shared header keeps its height under the nav, so the transcript starts where it always does. */
export function ChatScreen({ bot, group, members, onBack, onProfile, onComputer }: {
  bot?: Bot;
  group?: Group;
  members: Bot[];
  onBack: () => void;
  onProfile: () => void;
  onComputer: () => void;
}) {
  const { state } = useStore();
  const name = group?.name ?? bot?.name ?? "";
  const live = Boolean(bot && (bot.busy || state.computerControl[bot.id]?.held));
  const link = useLiveConnection();
  const leaving = useNavLeaving();
  useNativeBar(BAR_RANK.chat, leaving ? null : "none", {});
  const pressedAt = useRef(-Infinity);
  // the native glass header draws back, title and computer only, from where these sit on the page
  const glass = usePlatform().glass;
  const more = Boolean(bot && !group && !glass);
  const chatRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const chat = chatRef.current;
    if (!chat) return;
    const stopTimes = installMessageTimes(chat);
    const stopReply = installSwipeReply(chat, glass);
    return () => { stopTimes(); stopReply(); };
  }, [glass]);
  return (
    <div ref={chatRef} data-mobile-chat className="relative flex h-full flex-col">
      {group ? <GroupView key={group.id} group={group} /> : bot ? <ChatView bot={bot} /> : null}
      <div aria-hidden className="m-edge-top z-[29] h-[calc(var(--m-safe-top)+16px)]" />
      <nav
        aria-label={t("mobile.chat.nav", { name })}
        data-glass-nav=""
        className={`pointer-events-none absolute inset-x-0 top-0 z-30 grid items-center gap-2 px-4 pt-[var(--m-safe-top)] ${more ? "grid-cols-[minmax(44px,1fr)_minmax(0,auto)_minmax(96px,1fr)]" : "grid-cols-[1fr_auto_1fr]"}`}
      >
        <RoundButton floating glass data-glass="back" label={t("mobile.chat.back")} onClick={onBack} className="pointer-events-auto">
          <BackGlyph size={22} strokeWidth={2} />
        </RoundButton>
        <div className="relative flex min-w-0 justify-center">
          <button
            type="button"
            // the sheet rises as the finger lands, not when it lifts; the click that follows (or a key, or the native pill's
            // tap over the glass bridge) opens it only when the press did not
            onPointerDown={(event) => { if (event.button === 0) { pressedAt.current = performance.now(); onProfile(); } }}
            onClick={() => { if (performance.now() - pressedAt.current > PRESS_CLICK_MS) onProfile(); }}
            data-glass="title"
            aria-label={group ? t("room.panel.openAria", { name }) : t("mobile.chat.openProfile", { name })}
            className="mobile-press m-glass pointer-events-auto flex h-11 min-w-0 max-w-[calc(100vw-136px)] items-center gap-2 rounded-full pl-2.5 pr-4 text-ink"
          >
            <span data-glass-avatar="" className="flex shrink-0">
              {group
                ? <GroupAvatar members={members} size={24} />
                : bot && <BotAvatar bot={bot} size={24} state="idle" animated={false} />}
            </span>
            <span data-glass-name="" className="min-w-0 truncate text-[17px] font-medium">{name}</span>
          </button>
          <ConnectionPill notice={link.notice === "reconnecting" ? null : link.notice} trying={link.trying} onRetry={link.retry} testId="mobile-chat-cloud-status" className="absolute top-[calc(100%+8px)] h-8 px-3" />
        </div>
        <div className="flex justify-end gap-2">
          {more && bot && <PhoneChatMenu bot={bot} />}
          <RoundButton floating glass data-glass="right" label={live ? `${t("mobile.chat.computer")}, ${t("place.live")}` : t("mobile.chat.computer")} onClick={onComputer} className="pointer-events-auto">
            <Monitor size={19} strokeWidth={1.8} />
            {live && <span aria-hidden data-glass-live="" className="absolute right-2.5 top-2.5 size-2 rounded-full bg-success" />}
          </RoundButton>
        </div>
      </nav>
    </div>
  );
}
