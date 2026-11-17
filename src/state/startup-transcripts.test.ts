// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StoreProvider, useStore, type Action, type AppState, type Bot, type Group, type Message } from "./store";
import { LAST_CONVERSATION_KEY } from "../lib/last-conversation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: "fixture:1" }); }
}

const line = (id: string): Message => ({ id, role: "bot", kind: "text", text: id, at: 1 });
const bot = (id: string): Bot => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "", color: "green", notifications: true, unread: false,
  modelSelection: { instanceId: "fake", model: "fake" }, messages: [line(`${id}-preview`)],
  activeLeafId: `${id}-preview`, tasks: [{ threadId: `${id}-thread`, title: id, createdAt: 1 }],
});
const group: Group = { id: "room", threadId: "room-thread", name: "Room", memberIds: [], defaultResponder: { kind: "mentions" },
  bulletin: "", unread: false, createdAt: 1, messages: [line("room-preview")] };
const json = (body: unknown) => new Response(JSON.stringify(body));
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  FixtureEventSource.opened = [];
  vi.unstubAllGlobals();
});

async function fixture(transcripts?: (path: string) => unknown) {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) });
  localStorage.setItem(LAST_CONVERSATION_KEY, "one");
  const pending = new Map<string, (body: unknown) => void>();
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/bots?")) return json({ bots: [bot("one"), bot("two"), bot("three")], groups: [group], loadedThreads: ["one-thread"] });
    if (path.startsWith("/api/threads/")) return new Promise<Response>((resolve, reject) => {
      pending.set(path, (body) => resolve(json(body)));
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
    if (path.startsWith("/api/transcripts?") && transcripts) return json(transcripts(path));
    if (path === "/api/instances") return json({ instances: [] });
    if (path.startsWith("/api/routines?")) return json({ routines: [], runs: [] });
    if (path === "/api/webhooks") return json({ webhooks: [] });
    return json({});
  });
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("EventSource", FixtureEventSource);
  let state!: AppState;
  let dispatch!: (action: Action) => void;
  function Probe() { ({ state, dispatch } = useStore()); return null; }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(createElement(StoreProvider, null, createElement(Probe))));
  const stream = FixtureEventSource.opened[0]!;
  await act(async () => { stream.send({ kind: "hello", resumed: false, cursor: "fixture:0" }); });
  return {
    state: () => state, request,
    dispatch: (action: Action) => act(async () => dispatch(action)),
    select: (id: string) => act(async () => dispatch({ type: "select", id })),
    send: (frame: object) => act(async () => { stream.send(frame); }),
    answer: (thread: string, messages: Message[]) => act(async () => {
      pending.get(`/api/threads/${thread}/messages?limit=200`)?.({ messages, activeLeafId: messages.at(-1)?.id ?? null, hasMore: true });
    }),
  };
}

it("shares rapid sidebar loads, caches visited bots and rooms, and keeps messages and edits streamed during the load", async () => {
  const app = await fixture();
  expect(app.request.mock.calls.some(([path]) => path === "/api/bots?messages=200&selected=one")).toBe(true);
  await app.select("two");
  await app.select("three");
  await app.select("two");
  expect(app.request.mock.calls.filter(([path]) => path === "/api/threads/two-thread/messages?limit=200")).toHaveLength(1);
  await app.send({ kind: "message.patch", threadId: "two-thread", message: { ...line("two-preview"), text: "edited while loading" } });
  await app.send({ kind: "message", threadId: "two-thread", message: line("two-live") });
  await app.answer("three-thread", [line("three-history"), line("three-preview")]);
  expect(app.state().selectedId).toBe("two");
  await app.answer("two-thread", [line("two-history"), line("two-preview")]);
  expect(app.state().bots.find((owner) => owner.id === "two")!.messages.map((message) => message.text))
    .toEqual(["two-history", "edited while loading", "two-live"]);

  await app.select("room");
  await app.send({ kind: "message", threadId: "room-thread", message: line("room-live") });
  await app.answer("room-thread", [line("room-history"), line("room-preview")]);
  expect(app.state().groups[0]!.messages.map((message) => message.id)).toEqual(["room-history", "room-preview", "room-live"]);
  const reads = app.request.mock.calls.filter(([path]) => path.startsWith("/api/threads/")).length;
  await app.select("one");
  await app.select("two");
  await app.select("three");
  await app.select("room");
  expect(app.request.mock.calls.filter(([path]) => path.startsWith("/api/threads/"))).toHaveLength(reads);
});

it("discards a delayed preview load when a full thread replacement has already arrived", async () => {
  const app = await fixture();
  await app.select("two");
  await app.send({ kind: "bot", bot: { ...bot("two"), threadId: "replacement", tasks: [{ threadId: "replacement", title: "Replacement", createdAt: 2 }], messages: [line("replacement-message")] } });
  await app.answer("two-thread", [line("stale-message")]);
  const shown = app.state().bots.find((owner) => owner.id === "two")!;
  expect(shown.threadId).toBe("replacement");
  expect(shown.messages.map((message) => message.id)).toEqual(["replacement-message"]);
  expect(shown.transcriptLoaded).toBe(true);
});

it("invalidates visited transcripts when a replacement server snapshot is needed", async () => {
  const app = await fixture();
  await app.select("two");
  await app.answer("two-thread", [line("old-history"), line("two-preview")]);
  await app.select("one");
  await app.send({ kind: "hello", resumed: false, cursor: "replacement:0" });
  await app.select("two");
  expect(app.request.mock.calls.filter(([path]) => path === "/api/threads/two-thread/messages?limit=200")).toHaveLength(2);
  await app.answer("two-thread", [line("fresh-history"), line("two-preview")]);
  expect(app.state().bots.find((owner) => owner.id === "two")!.messages.map((message) => message.id)).toEqual(["fresh-history", "two-preview"]);
});

it("waits for the initial full transcript before reading earlier pages", async () => {
  const app = await fixture();
  await app.select("two");
  await app.dispatch({ type: "loadOlderMessages", threadId: "two-thread" });
  expect(app.request.mock.calls.filter(([path]) => path.includes("before="))).toHaveLength(0);
  expect(app.state().loadingOlder["two-thread"]).toBeUndefined();
  await app.answer("two-thread", [line("two-history"), line("two-preview")]);
  expect(app.state().bots.find((owner) => owner.id === "two")!.messages.map((message) => message.id)).toEqual(["two-history", "two-preview"]);
});

it("coalesces live branch updates during the initial read and retries an overtaken snapshot", async () => {
  const app = await fixture();
  await app.select("two");
  for (const activeLeafId of ["live-one", "live-two", "live-three"]) await app.send({ kind: "thread", threadId: "two-thread", activeLeafId });
  const reads = () => app.request.mock.calls.filter(([path]) => path === "/api/threads/two-thread/messages?limit=200");
  expect(reads()).toHaveLength(1);
  await app.answer("two-thread", [line("overtaken"), line("two-preview")]);
  await vi.waitFor(() => expect(reads()).toHaveLength(2));
  await app.answer("two-thread", [line("two-history"), line("live-three")]);
  expect(app.state().bots.find((owner) => owner.id === "two")!.messages.map((message) => message.id)).toEqual(["two-history", "live-three"]);
});

it("finds the first unread reply after expanding a preview that omitted its read cursor", async () => {
  const app = await fixture();
  await app.send({ kind: "bot", bot: { ...bot("two"), unread: true,
    tasks: [{ threadId: "two-thread", title: "Two", createdAt: 1, unread: true, lastReadMessageId: "read-user" }] } });
  await app.select("two");
  const user: Message = { ...line("read-user"), role: "user" };
  await app.answer("two-thread", [user, line("first-unread"), line("two-preview")]);
  expect(app.state().unreadDivider).toEqual({ threadId: "two-thread", messageId: "first-unread" });
  expect(app.state().unreadDividerPending).toBeUndefined();
});

it("keeps a visited transcript through a replacement snapshot and confirms it in place, never as its preview", async () => {
  const app = await fixture();
  await app.select("two");
  await app.answer("two-thread", [line("two-history"), line("two-preview")]);
  const before = app.state().bots.find((owner) => owner.id === "two")!.messages;
  await app.select("one");
  await app.send({ kind: "hello", resumed: false, cursor: "replacement:0" });
  const held = app.state().bots.find((owner) => owner.id === "two")!;
  expect(held.messages).toBe(before);
  expect(held.transcriptLoaded).toBe(true);
  expect(held.transcriptStale).toBe(true);
  await app.send({ kind: "message", threadId: "two-thread", message: line("two-live") });
  expect(app.state().bots.find((owner) => owner.id === "two")!.messages.map((message) => message.id)).toEqual(["two-history", "two-preview", "two-live"]);
  await app.select("two");
  await app.send({ kind: "message", threadId: "two-thread", message: line("two-during") });
  await app.answer("two-thread", [line("two-history"), line("two-preview"), line("two-missed"), line("two-live")]);
  const confirmed = app.state().bots.find((owner) => owner.id === "two")!;
  expect(confirmed.messages.map((message) => message.id)).toEqual(["two-history", "two-preview", "two-missed", "two-live", "two-during"]);
  expect(confirmed.messages[0]).toBe(before[0]);
  expect(confirmed.transcriptStale).toBeUndefined();
});

it("opens a chat from the device's cache at once and confirms it with the newest page, appending in place", async () => {
  const app = await fixture();
  const cached = [line("three-old"), line("three-preview")];
  await app.dispatch({ type: "transcriptsCached", transcripts: [{ threadId: "three-thread", messages: cached, hasMore: false, activeLeafId: "three-preview", savedAt: 1 }] });
  const seeded = app.state().bots.find((owner) => owner.id === "three")!;
  expect(seeded.messages).toBe(cached);
  expect(seeded.transcriptStale).toBe(true);
  await app.select("three");
  await app.answer("three-thread", [line("three-old"), line("three-preview"), line("three-new")]);
  const confirmed = app.state().bots.find((owner) => owner.id === "three")!;
  expect(confirmed.messages.map((message) => message.id)).toEqual(["three-old", "three-preview", "three-new"]);
  expect(confirmed.messages[0]).toBe(cached[0]);
  expect(confirmed.transcriptStale).toBeUndefined();
});

it("loads every chat in one read once the snapshot lands, so opening any of them reads nothing more", async () => {
  const page = (thread: string, ids: string[]) => ({ threadId: thread, messages: ids.map((id) => line(id)), hasMore: false, activeLeafId: ids.at(-1) });
  const app = await fixture(() => ({ threads: [page("two-thread", ["two-history", "two-preview"]), page("three-thread", ["three-history", "three-preview"]), page("room-thread", ["room-history", "room-preview"])] }));
  await vi.waitFor(() => expect(app.state().bots.find((owner) => owner.id === "three")!.transcriptLoaded).toBe(true));
  const bulk = app.request.mock.calls.filter(([path]) => path.startsWith("/api/transcripts?"));
  expect(bulk).toHaveLength(1);
  expect(bulk[0]![0]).toBe("/api/transcripts?limit=50&threads=room-thread,three-thread,two-thread");
  expect(app.state().bots.find((owner) => owner.id === "two")!.messages.map((message) => message.id)).toEqual(["two-history", "two-preview"]);
  expect(app.state().groups[0]!.messages.map((message) => message.id)).toEqual(["room-history", "room-preview"]);
  await app.select("two");
  await app.select("room");
  expect(app.request.mock.calls.filter(([path]) => path.startsWith("/api/threads/"))).toHaveLength(0);
});

it("reports a failing bulk read once, then retries further apart instead of every three seconds", async () => {
  vi.useFakeTimers();
  try {
    const app = await fixture(() => { throw new Error("transcripts offline"); });
    const attempts = () => app.request.mock.calls.filter(([path]) => String(path).startsWith("/api/transcripts?")).length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6_100); });
    expect(attempts()).toBe(3);
    expect(app.state().error).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
