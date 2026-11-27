import { useEffect } from "react";
import type { NotificationLogEntry } from "../../../shared/notification";
import type { DeliveredNotification, MobilePlatform } from "../platform";

export interface RawAndroidDelivered {
  id: string | number;
  tag?: string;
  data?: Record<string, unknown>;
}

/** Android tagged pushes share numeric id 0 across conversations, so key delivered entries by id and tag. */
export function androidDeliveredKey(one: Pick<RawAndroidDelivered, "id" | "tag">): string {
  const id = String(one.id);
  return typeof one.tag === "string" && one.tag ? `${id}\0${one.tag}` : id;
}

/** Maps Android delivered pushes, falling back to the native notification tag when background FCM drops custom data. */
export function mapAndroidDelivered(notifications: readonly RawAndroidDelivered[]): DeliveredNotification[] {
  return notifications.map((one) => {
    const data = one.data ?? {};
    const tag = typeof one.tag === "string" && one.tag ? one.tag : undefined;
    const threadId = typeof data.threadId === "string" && data.threadId ? data.threadId : tag;
    const notificationId = typeof data.id === "string" && data.id ? data.id : undefined;
    return {
      id: androidDeliveredKey(one),
      ...(threadId ? { threadId } : {}),
      ...(notificationId ? { notificationId } : {}),
    };
  });
}

/** Pushes still in Notification Center that the person has already seen: about the conversation on screen, read on
 * any device (the desktop, another phone, "mark all read"), or a tag-only Android push whose thread has no unread items left. */
export function seenDelivered(
  delivered: readonly DeliveredNotification[],
  feed: readonly (Pick<NotificationLogEntry, "id" | "read"> & { threadId?: string })[],
  viewing: string | null,
): string[] {
  const read = new Set<string>();
  const readThreads = new Set<string>();
  const unreadThreads = new Set<string>();
  for (const entry of feed) {
    if (entry.read) {
      read.add(entry.id);
      if (entry.threadId) readThreads.add(entry.threadId);
    } else if (entry.threadId) {
      unreadThreads.add(entry.threadId);
    }
  }
  for (const threadId of unreadThreads) readThreads.delete(threadId);
  return delivered
    .filter((one) => (
      (viewing !== null && one.threadId === viewing)
      || (one.notificationId !== undefined && read.has(one.notificationId))
      || (one.notificationId === undefined && one.threadId !== undefined && readThreads.has(one.threadId))
    ))
    .map((one) => one.id);
}

export async function clearSeenNotifications(platform: Pick<MobilePlatform, "deliveredNotifications" | "removeDeliveredNotifications">, feed: readonly (Pick<NotificationLogEntry, "id" | "read"> & { threadId?: string })[], viewing: string | null): Promise<void> {
  if (!platform.deliveredNotifications || !platform.removeDeliveredNotifications) return;
  const seen = seenDelivered(await platform.deliveredNotifications(), feed, viewing);
  if (seen.length) await platform.removeDeliveredNotifications(seen);
}

/** Tells the native layer which conversation is on screen, and clears pushes once seen: when the conversation opens,
 * when a read lands from another device, and each time the app comes back. */
export function useSeenNotifications(platform: MobilePlatform, feed: readonly NotificationLogEntry[], viewing: string | null): void {
  useEffect(() => { platform.setViewingThread?.(viewing); }, [platform, viewing]);
  useEffect(() => () => platform.setViewingThread?.(null), [platform]);
  useEffect(() => { void clearSeenNotifications(platform, feed, viewing); }, [platform, feed, viewing]);
  useEffect(() => platform.onResume?.(() => { void clearSeenNotifications(platform, feed, viewing); }), [platform, feed, viewing]);
}
