import { plainPreviewText } from "@/lib/plain-preview";
import { useMemo, useState, type ComponentType } from "react";
import { BotAvatar, MausAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, openBotThread, openRoomThread, useStore } from "@/state/store";
import type { NotificationLogEntry } from "../../../shared/notification";
import { haptic } from "../haptics";
import { Sheet } from "../Sheet";
import { listTime } from "../time";
import { SettingsSection } from "./SettingsRow";
import { EmptyState } from "../Illustration";
import type { SheetPageProps } from "./registry";

export function groupNotifications(entries: readonly NotificationLogEntry[], now = Date.now()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups: Record<"today" | "yesterday" | "earlier", NotificationLogEntry[]> = { today: [], yesterday: [], earlier: [] };
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    groups[entry.at >= today.getTime() ? "today" : entry.at >= yesterday.getTime() ? "yesterday" : "earlier"].push(entry);
  }
  return groups;
}

export type NotificationStack = { key: string; latest: NotificationLogEntry; entries: NotificationLogEntry[]; unread: boolean };

/** One row per bot or room within a day: its newest note on top, the older ones counted under it. */
export function stackByOwner(entries: readonly NotificationLogEntry[]): NotificationStack[] {
  const stacks = new Map<string, NotificationStack>();
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    const key = entry.groupId ? `group:${entry.groupId}` : `bot:${entry.botId ?? entry.id}`;
    const stack = stacks.get(key);
    if (stack) { stack.entries.push(entry); stack.unread ||= !entry.read; }
    else stacks.set(key, { key, latest: entry, entries: [entry], unread: !entry.read });
  }
  return [...stacks.values()];
}

export const NotificationsSheet: ComponentType<SheetPageProps<"notifications">> = ({ open, onClose, onOpenChat }) => {
  const { state, dispatch } = useStore();
  const [reading, setReading] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<"read" | "missing" | null>(null);
  const groups = useMemo(() => groupNotifications(state.notifications), [state.notifications]);
  const unread = state.notifications.some((entry) => !entry.read);

  const readAll = async () => {
    if (reading) return;
    setReading(true);
    setError(null);
    const ids = state.notifications.filter((entry) => !entry.read).map((entry) => entry.id);
    try {
      await api("/api/notifications/read-all", { method: "POST" });
      dispatch({ type: "notificationsRead", ids });
    } catch {
      setError("read");
      haptic("error");
    } finally {
      setReading(false);
    }
  };

  const openEntry = async (stack: NotificationStack) => {
    const entry = stack.latest;
    if (opening) return;
    setOpening(entry.id);
    setError(null);
    try {
      const unreadIds = stack.entries.filter((item) => !item.read || item.id === entry.id).map((item) => item.id);
      await Promise.all(unreadIds.map((id) => api(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "POST" })));
      for (const id of unreadIds) dispatch({ type: "notificationRead", id });
      if (entry.groupId) {
        if (!state.groups.some((group) => group.id === entry.groupId)) { setError("missing"); haptic("error"); return; }
        onOpenChat(entry.groupId);
        openRoomThread(dispatch, { groupId: entry.groupId, threadId: entry.threadId }, state.groups);
      } else {
        const bot = state.bots.find((candidate) => candidate.id === entry.botId);
        if (!bot) { setError("missing"); haptic("error"); return; }
        onOpenChat(bot.id);
        openBotThread(dispatch, bot, entry.threadId, true);
      }
    } catch {
      setError("read");
      haptic("error");
    } finally {
      setOpening(null);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={t("mobile.notifications.title")} full actions={unread ? [{ key: "readAll", label: t("mobile.notifications.readAll"), symbol: "checkmark.circle", disabled: reading, onPress: () => { void readAll(); } }] : undefined} trailing={unread ? <button type="button" disabled={reading} onClick={() => { void readAll(); }} className="mobile-press flex min-h-11 items-center"><span className="flex h-11 items-center rounded-full bg-ink/[0.05] px-4 text-[15px] font-semibold text-ink">{t("mobile.notifications.readAll")}</span></button> : undefined}>
      {error && <p role="alert" className="px-6 py-3 text-[15px] text-danger">{t(error === "missing" ? "mobile.notifications.chatMissing" : "mobile.notifications.readError")}</p>}
      {state.notifications.length === 0 ? (
        <EmptyState art="mailbox" title={t("mobile.notifications.emptyTitle")} body={t("mobile.notifications.emptyBody")} className="pt-20" />
      ) : (
        <div className="px-2 pt-2" aria-busy={reading || Boolean(opening)}>
          {(["today", "yesterday", "earlier"] as const).map((day) => groups[day].length > 0 && (
            <SettingsSection key={day} title={t(`mobile.notifications.${day}`)}>
              <ul>
                {stackByOwner(groups[day]).map((stack) => {
                  const entry = stack.latest;
                  const bot = state.bots.find((candidate) => candidate.id === entry.botId);
                  const more = stack.entries.length - 1;
                  return (
                    <li key={stack.key}>
                      <button type="button" disabled={Boolean(opening)} onClick={() => { void openEntry(stack); }} aria-label={stack.unread ? t("mobile.notifications.unread", { title: entry.title }) : undefined} className="mobile-row flex min-h-[76px] w-full items-start gap-3 rounded-2xl px-4 py-3 text-left disabled:opacity-60">
                        <span className="shrink-0 pt-0.5">{bot ? <BotAvatar bot={bot} size={40} animated={false} label="" /> : <MausAvatar color="blue" size={40} animated={false} label="" />}</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className={cn("min-w-0 flex-1 truncate text-[16px] leading-5 text-ink", stack.unread ? "font-semibold" : "font-medium")}>{entry.title}</span>
                            <time dateTime={new Date(entry.at).toISOString()} className="shrink-0 text-[14px] font-medium tabular-nums text-ink-secondary">{listTime(entry.at)}</time>
                            <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", stack.unread ? "bg-ink" : "bg-transparent")} />
                          </span>
                          <span className="mt-1 line-clamp-2 text-[15px] leading-5 text-ink-secondary">{plainPreviewText(entry.body)}</span>
                          {more > 0 && <span className="mt-1.5 inline-flex h-6 items-center rounded-full bg-ink/[0.06] px-2.5 text-[13px] font-semibold text-ink-secondary">{t("mobile.notifications.more", { count: more })}</span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </SettingsSection>
          ))}
        </div>
      )}
    </Sheet>
  );
};
