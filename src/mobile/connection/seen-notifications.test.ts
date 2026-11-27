import { expect, it, vi } from "vitest";
import { androidDeliveredKey, clearSeenNotifications, mapAndroidDelivered, seenDelivered } from "./seen-notifications";

const delivered = [
  { id: "a", threadId: "t1", notificationId: "n1" },
  { id: "b", threadId: "t2", notificationId: "n2" },
  { id: "c", threadId: "t3", notificationId: "n3" },
  { id: "d" },
];
const feed = [{ id: "n1", read: false }, { id: "n2", read: true }, { id: "n3", read: false }];

it("clears pushes read on any device and the one for the conversation on screen, and keeps the rest", () => {
  expect(seenDelivered(delivered, feed, null)).toEqual(["b"]);
  expect(seenDelivered(delivered, feed, "t3")).toEqual(["b", "c"]);
  // a push for a notification this phone has not loaded yet stays
  expect(seenDelivered([{ id: "e", threadId: "t9", notificationId: "n9" }], feed, null)).toEqual([]);
});

it("maps Android tagged background pushes with distinct keys and clears them when the thread is read elsewhere", () => {
  // Capacitor's Android bridge returns StatusBarNotification.getId() as an integer (0 for tagged FCM pushes)
  const android = mapAndroidDelivered([
    { id: 0, tag: "t1", data: {} },
    { id: 0, tag: "t2" },
    { id: 0, tag: "t9", data: {} },
  ]);
  expect(android).toEqual([
    { id: androidDeliveredKey({ id: 0, tag: "t1" }), threadId: "t1" },
    { id: androidDeliveredKey({ id: 0, tag: "t2" }), threadId: "t2" },
    { id: androidDeliveredKey({ id: 0, tag: "t9" }), threadId: "t9" },
  ]);
  expect(androidDeliveredKey({ id: 42 })).toBe("42");
  // t1 is completely read; t2 still has a newer unread entry; t9 is not loaded in the feed yet
  const threadedFeed = [
    { id: "n1", threadId: "t1", read: true },
    { id: "n2", threadId: "t2", read: true },
    { id: "n3", threadId: "t2", read: false },
  ];
  expect(seenDelivered(android, threadedFeed, null)).toEqual([androidDeliveredKey({ id: 0, tag: "t1" })]);
  expect(seenDelivered(android, threadedFeed, "t2")).toEqual([
    androidDeliveredKey({ id: 0, tag: "t1" }),
    androidDeliveredKey({ id: 0, tag: "t2" }),
  ]);
});

it("asks the native layer to remove only what was seen, and nothing when nothing was", async () => {
  const removeDeliveredNotifications = vi.fn(async () => {});
  await clearSeenNotifications({ deliveredNotifications: async () => delivered, removeDeliveredNotifications }, feed, "t1");
  expect(removeDeliveredNotifications).toHaveBeenCalledExactlyOnceWith(["a", "b"]);
  removeDeliveredNotifications.mockClear();
  await clearSeenNotifications({ deliveredNotifications: async () => delivered, removeDeliveredNotifications }, [], null);
  expect(removeDeliveredNotifications).not.toHaveBeenCalled();
});
