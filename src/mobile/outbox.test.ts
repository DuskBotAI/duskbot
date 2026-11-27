import { createElement, type Dispatch } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, StoreProvider, useStore, type Action } from "@/state/store";
import { installSendOutbox, type OutboxSend } from "@/state/send-outbox";
import { createOutbox, onBackOnline, OUTBOX_MAX_AGE_MS, OUTBOX_MAX_TRIES, replayAction } from "./outbox";

function memoryPrefs() {
  const values = new Map<string, string>();
  return { values, prefs: { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value); }, remove: async (key: string) => { values.delete(key); } } };
}
const send = (sendId: string, at = 1_000): OutboxSend => ({ kind: "bot", ownerId: "bot", threadId: "thread", sendId, text: `text ${sendId}`, at });
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

afterEach(() => { initialState.bots = []; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("outbox", () => {
  it("keeps an unsent message across a restart and sends it again with the same sendId, oldest first, one at a time", async () => {
    const { prefs } = memoryPrefs();
    const first = createOutbox(prefs, "k", () => 2_000);
    await first.ready;
    first.hold(send("a"));
    first.hold(send("b"));
    expect(first.keep("a")).toBe(true);
    expect(first.keep("b")).toBe(true);
    await settle();

    const second = createOutbox(prefs, "k", () => 3_000);
    const dispatched: Action[] = [];
    await second.flush((action) => { dispatched.push(action); if ("sendId" in action && action.sendId) second.hold(send(action.sendId)); });
    expect(dispatched).toEqual([replayAction(send("a"))]);
    second.release("a");
    expect(dispatched.map((action) => "sendId" in action && action.sendId)).toEqual(["a", "b"]);
    second.release("b");
    expect(second.pending()).toEqual([]);
    await settle();
    expect(await prefs.get("k")).toBeNull();
  });

  it("keeps a saved send when another is held before the outbox finishes loading", async () => {
    const values = new Map<string, string>([["k", JSON.stringify([{ ...send("a"), tries: 1 }])]]);
    let resumeRead!: () => void;
    const readGate = new Promise<void>((resolve) => { resumeRead = resolve; });
    const prefs = {
      get: async (key: string) => { const snapshot = values.get(key) ?? null; await readGate; return snapshot; },
      set: async (key: string, value: string) => { values.set(key, value); },
      remove: async (key: string) => { values.delete(key); },
    };
    const first = createOutbox(prefs, "k", () => 2_000);
    first.hold(send("b"));
    resumeRead();
    await first.ready;
    await settle();
    expect(first.pending().map((one) => one.sendId)).toEqual(["a", "b"]);
    expect(JSON.parse(values.get("k")!).map((one: { sendId: string }) => one.sendId)).toEqual(["a", "b"]);

    const second = createOutbox(prefs, "k", () => 3_000);
    await second.ready;
    expect(second.pending().map((one) => one.sendId)).toEqual(["a", "b"]);
  });

  it("stops at a send that is lost again and picks up on the next flush", async () => {
    const { prefs } = memoryPrefs();
    const outbox = createOutbox(prefs, "k", () => 2_000);
    await outbox.ready;
    outbox.hold(send("a")); outbox.keep("a");
    outbox.hold(send("b")); outbox.keep("b");
    const dispatched: string[] = [];
    const dispatch = (action: Action) => { if ("sendId" in action && action.sendId) { dispatched.push(action.sendId); outbox.hold(send(action.sendId)); } };
    await outbox.flush(dispatch);
    expect(outbox.keep("a")).toBe(true);
    expect(dispatched).toEqual(["a"]);
    await outbox.flush(dispatch);
    expect(dispatched).toEqual(["a", "a"]);
  });

  it("hands a send back after too many tries or a day", async () => {
    const { prefs } = memoryPrefs();
    let now = 2_000;
    const outbox = createOutbox(prefs, "k", () => now);
    await outbox.ready;
    outbox.hold(send("a"));
    for (let i = 1; i < OUTBOX_MAX_TRIES; i++) expect(outbox.keep("a")).toBe(true);
    expect(outbox.keep("a")).toBe(false);
    outbox.hold(send("b", now));
    now += OUTBOX_MAX_AGE_MS;
    expect(outbox.keep("b")).toBe(false);
    expect(outbox.pending()).toEqual([]);
  });

  it("ignores a saved list it cannot read", async () => {
    const { prefs, values } = memoryPrefs();
    values.set("k", "{not json");
    const outbox = createOutbox(prefs, "k");
    await outbox.ready;
    expect(outbox.pending()).toEqual([]);
    values.set("k", JSON.stringify([{ kind: "bot", ownerId: "bot" }]));
    const other = createOutbox(prefs, "k");
    await other.ready;
    expect(other.pending()).toEqual([]);
  });

  it("puts a new send behind one already waiting in its chat, and sends them in the order written", async () => {
    const { prefs } = memoryPrefs();
    const outbox = createOutbox(prefs, "k", () => 2_000);
    await outbox.ready;
    outbox.hold(send("a")); expect(outbox.keep("a")).toBe(true);
    const dispatched: string[] = [];
    const dispatch = (action: Action) => { if ("sendId" in action && action.sendId) { dispatched.push(action.sendId); outbox.hold(send(action.sendId)); } };
    outbox.hold(send("b"));
    expect(outbox.waitBehind("b")).toBe(true);
    outbox.hold({ ...send("other"), threadId: "elsewhere" });
    expect(outbox.waitBehind("other"), "another chat never waits").toBe(false);
    outbox.release("other");
    await outbox.flush(dispatch);
    expect(dispatched).toEqual(["a"]);
    outbox.release("a");
    expect(dispatched).toEqual(["a", "b"]);
    outbox.release("b");
    expect(outbox.pending()).toEqual([]);
  });

  it("tries again when the network returns, not only on resume, until stopped", () => {
    const network = new EventTarget();
    let resume: (() => void) | null = null;
    const run = vi.fn();
    const stop = onBackOnline({ onResume: (listener) => { resume = listener; return () => { resume = null; }; } }, run, network);
    network.dispatchEvent(new Event("online"));
    resume!();
    expect(run).toHaveBeenCalledTimes(2);
    stop();
    network.dispatchEvent(new Event("online"));
    expect(run).toHaveBeenCalledTimes(2);
    expect(resume).toBeNull();
  });
});

describe("the store with an outbox", () => {
  const SEND = "/api/bots/bot/messages";
  function mount(request: typeof fetch) {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", request);
    vi.stubGlobal("window", new EventTarget());
    let dispatch!: Dispatch<Action>;
    function Capture() { dispatch = useStore().dispatch; return null; }
    renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
    return dispatch;
  }

  it("keeps a send whose answer never came, without giving the draft back, and releases one the server took", async () => {
    const { prefs } = memoryPrefs();
    const outbox = createOutbox(prefs, "k", () => Date.now());
    await outbox.ready;
    const stop = installSendOutbox(outbox);
    let online = false;
    const dispatch = mount(vi.fn<typeof fetch>(async (path) => {
      if (path !== SEND) return new Response("{}");
      if (!online) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ ok: true, threadId: "thread", message: { id: "m1", role: "user", kind: "text", text: "hello", at: 1, sendId: "send-0123456789abcdef" } }), { status: 202 });
    }));
    const onError = vi.fn();
    dispatch({ type: "send", botId: "bot", threadId: "thread", text: "hello", sendId: "send-0123456789abcdef", onError });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onError).not.toHaveBeenCalled();
    expect(outbox.pending().map((one) => one.sendId)).toEqual(["send-0123456789abcdef"]);
    online = true;
    await outbox.flush(dispatch);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outbox.pending()).toEqual([]);
    stop();
  });

  it("holds a later send behind one already waiting in the outbox, and delivers both in the order written", async () => {
    const { prefs } = memoryPrefs();
    const outbox = createOutbox(prefs, "k", () => Date.now());
    await outbox.ready;
    const stop = installSendOutbox(outbox);
    let online = false;
    const posted: string[] = [];
    const dispatch = mount(vi.fn<typeof fetch>(async (path, init) => {
      if (path !== SEND) return new Response("{}");
      if (!online) throw new TypeError("Failed to fetch");
      const { text, sendId } = JSON.parse(String(init?.body)) as { text: string; sendId: string };
      posted.push(text);
      return new Response(JSON.stringify({ ok: true, threadId: "thread", message: { id: `m-${sendId}`, role: "user", kind: "text", text, at: 1, sendId } }), { status: 202 });
    }));
    const onError = vi.fn();
    dispatch({ type: "send", botId: "bot", threadId: "thread", text: "first", sendId: "send-first-0123456789", onError });
    await vi.advanceTimersByTimeAsync(120_000);
    online = true;
    dispatch({ type: "send", botId: "bot", threadId: "thread", text: "second", sendId: "send-second-012345678", onError });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(posted, "the later send never overtakes the waiting one").toEqual([]);
    await outbox.flush(dispatch);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(posted).toEqual(["first", "second"]);
    expect(onError).not.toHaveBeenCalled();
    stop();
  });

  it("gives the draft back when the server refuses, and forgets the send", async () => {
    const { prefs } = memoryPrefs();
    const outbox = createOutbox(prefs, "k");
    await outbox.ready;
    const stop = installSendOutbox(outbox);
    const dispatch = mount(vi.fn<typeof fetch>(async (path) => path === SEND ? new Response(JSON.stringify({ error: "no" }), { status: 409 }) : new Response("{}")));
    const onError = vi.fn();
    dispatch({ type: "send", botId: "bot", threadId: "thread", text: "hello", sendId: "send-0123456789abcdee", onError });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledOnce();
    expect(outbox.pending()).toEqual([]);
    stop();
  });
});
