import { createElement, type Dispatch } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { initialState, StoreProvider, useStore, type Action, type Bot } from "./store";
import { followSentTurn, resetSentTurns, sentTurn, SENT_TURN_GIVE_UP_MS } from "./sent-turn";

const SEND = "/api/bots/bot/messages";
const SEND_ID = "send-0123456789abcdef";
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const idle = { id: "bot", threadId: "thread", name: "Pepper", busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "thread", title: "", createdAt: 1, busy: false }] } as unknown as Bot;

/** The owner's trail: the server answered "hi" 6.9 s after Enter, and nothing of the bot showed until it did. */
function sendWith(answer: () => Promise<Response>, bot: Bot = idle) {
  vi.useFakeTimers();
  initialState.bots = [bot];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>((path) => path === SEND ? answer() : Promise.resolve(response({}))));
  vi.stubGlobal("window", {});
  let dispatch!: Dispatch<Action>;
  function Capture() { dispatch = useStore().dispatch; return null; }
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
  dispatch({ type: "send", botId: "bot", threadId: "thread", text: "hi", sendId: SEND_ID, onError: () => {} });
}
const later = (ms: number, body: unknown, status = 202) => () => new Promise<Response>((resolve) => setTimeout(() => resolve(response(body, status)), ms));
const started = { ok: true, threadId: "thread", message: { id: "m1", role: "user", kind: "text", text: "hi", at: 1, sendId: SEND_ID } };

afterEach(() => { initialState.bots = []; resetSentTurns(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("starts the bot's turn the moment the message is sent, before the server answers", async () => {
  sendWith(later(6_900, started));
  expect(sentTurn("thread"), "the same tick as Enter").toMatchObject({ sendId: SEND_ID, phase: "sending" });
  await vi.advanceTimersByTimeAsync(6_000);
  expect(sentTurn("thread")?.phase).toBe("sending");
  await vi.advanceTimersByTimeAsync(1_000);
  await flush();
  followSentTurn("thread", true);
  expect(sentTurn("thread"), "the server's running turn carries on from the send").toMatchObject({ phase: "running" });
  followSentTurn("thread", false);
  expect(sentTurn("thread"), "and its end ends it").toBeNull();
});

it("lets go when the server took the send but its turn was never seen running", async () => {
  sendWith(later(50, started));
  await vi.advanceTimersByTimeAsync(60);
  await flush();
  expect(sentTurn("thread")?.phase).toBe("sending");
  await vi.advanceTimersByTimeAsync(SENT_TURN_GIVE_UP_MS);
  expect(sentTurn("thread")).toBeNull();
});

it.each([
  ["queued", { ok: true, threadId: "thread", queued: true, queueId: "q1" }, 202],
  ["refused", { error: "no" }, 409],
])("shows no turn for a send the server %s", async (_case, body, status) => {
  sendWith(later(50, body, status));
  await vi.advanceTimersByTimeAsync(60);
  await flush();
  expect(sentTurn("thread")).toBeNull();
});

it("leaves a turn already running alone: a follow-up is not a new turn", () => {
  sendWith(later(50, started), { ...idle, busy: true } as Bot);
  expect(sentTurn("thread")).toBeNull();
});

it("shows no turn while the server is out of reach, only the bubble on its way", async () => {
  let calls = 0;
  sendWith(() => { calls++; return Promise.reject(new TypeError("Failed to fetch")); });
  await flush();
  expect(calls).toBe(1);
  expect(sentTurn("thread"), "the server never got the message: the bot is not at it").toBeNull();
  await vi.advanceTimersByTimeAsync(3_100);
  expect(calls, "the send is still being retried").toBeGreaterThan(1);
  expect(sentTurn("thread")).toBeNull();
});
