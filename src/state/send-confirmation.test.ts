import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "../../shared/wire";
import { openLiveEvents, publishLiveFrame, publishMissedFrames } from "../lib/live-events";
import { ApiError } from "./api";
import { limitSendAttempts, LOST_SEND_RETRY_MS, optimisticMessageId, SEND_ATTEMPT_CUTS, SendAttemptCutError, sendAnswerLost, sendReconciled, type SendDelivery } from "./optimistic-send";

const delivery: SendDelivery = { threadId: "thread-one", sendId: "send-0123456789abcdef", text: "Hello", replyToId: "reply-one" };
const message = (patch = {}): ServerFrame => ({ kind: "message", threadId: delivery.threadId,
  message: { id: "canonical", role: "user", kind: "text", text: delivery.text, at: 1, sendId: delivery.sendId, replyToId: delivery.replyToId, ...patch } });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("canonical send confirmation", () => {
  it("settles a stalled HTTP response from the pinned thread's canonical event and aborts only its request", async () => {
    let owned!: AbortSignal;
    const unrelated = new AbortController();
    const post = vi.fn((signal: AbortSignal) => {
      owned = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const result = sendReconciled(post, () => false, undefined, delivery);
    publishMissedFrames();
    publishLiveFrame(message());
    await expect(result).resolves.toEqual({ arrived: true });
    expect(post).toHaveBeenCalledOnce();
    expect(owned.aborted).toBe(true);
    expect(unrelated.signal.aborted).toBe(false);
  });

  it("does not accept another chat, conflicting text, an optimistic row, or a different channel mode", async () => {
    let finish!: (body: object) => void;
    let settled = false;
    const result = sendReconciled(() => new Promise<object>((resolve) => { finish = resolve; }), () => false, undefined, delivery);
    void result.then(() => { settled = true; });
    publishLiveFrame({ ...message(), threadId: "other-thread" } as ServerFrame);
    for (const patch of [{ text: "Different" }, { sendId: "another-send-id" }, { replyToId: "another-reply" },
      { id: optimisticMessageId(delivery.sendId) }, { role: "bot" }, { channelMode: "goal" }]) publishLiveFrame(message(patch));
    await flush();
    expect(settled).toBe(false);
    const receipt = { ok: true, threadId: delivery.threadId, message: { id: "accepted" } };
    finish(receipt);
    await expect(result).resolves.toEqual({ body: receipt });
  });

  it("keeps HTTP success and a queue receipt when the live event is missing", async () => {
    for (const body of [{ ok: true, threadId: delivery.threadId, message: { id: "accepted" } }, { ok: true, queued: true, queueId: "queue", threadId: delivery.threadId }]) {
      await expect(sendReconciled(async () => body, () => false, undefined, delivery)).resolves.toEqual({ body });
    }
  });

  it("retries an unconfirmed success instead of silently losing an optimistic message", async () => {
    const body = { ok: true, threadId: delivery.threadId, message: { id: "accepted" } };
    const post = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce(body);
    await expect(sendReconciled(post, () => false, async () => {}, delivery)).resolves.toEqual({ body });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("keeps asking through a tunnel that stalls for most of a minute, with the same send", async () => {
    // a message typed while the relay stalled went back into the composer after 4 s and never reached the bot
    const body = { ok: true, threadId: delivery.threadId, message: { id: "accepted" } };
    const waited: number[] = [];
    let failures = 5;
    const post = vi.fn(async () => { if (failures-- > 0) throw new TypeError("Failed to fetch"); return body; });
    await expect(sendReconciled(post, () => false, async (ms) => { waited.push(ms); }, delivery)).resolves.toEqual({ body });
    expect(post).toHaveBeenCalledTimes(6);
    expect(waited.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(30_000);
    expect(LOST_SEND_RETRY_MS.reduce((sum: number, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(45_000);
  });

  it("preserves a server refusal and never retries it", async () => {
    const post = vi.fn(async () => { throw new ApiError("Not permitted", 403); });
    await expect(sendReconciled(post, () => false, undefined, delivery)).rejects.toMatchObject({ status: 403 });
    publishLiveFrame(message());
    expect(post).toHaveBeenCalledOnce();
  });

  it("confirms during a retry wait without sending again or leaving a timer behind", async () => {
    vi.useFakeTimers();
    const post = vi.fn(async () => { throw new TypeError("Connection lost"); });
    const result = sendReconciled(post, () => false, undefined, delivery);
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    publishLiveFrame(message());
    await expect(result).resolves.toEqual({ arrived: true });
    await vi.runAllTimersAsync();
    expect(post).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits out a slow steered or queued receipt without a live event instead of failing or resending", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    for (const body of [{ ok: true, steered: true, threadId: delivery.threadId, message: { id: "steered" } },
      { ok: true, queued: true, queueId: "queue", threadId: delivery.threadId }]) {
      let signal!: AbortSignal;
      const post = vi.fn((owned: AbortSignal) => { signal = owned; return new Promise((resolve) => setTimeout(() => resolve(body), 120_000)); });
      const result = sendReconciled(post, () => false, undefined, delivery);
      await vi.advanceTimersByTimeAsync(119_000);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(result).resolves.toEqual({ body });
      expect(post).toHaveBeenCalledOnce();
    }
  });

  it("keeps many rapid sends independent when events arrive out of order across chats", async () => {
    const posts: Array<ReturnType<typeof vi.fn>> = [];
    const sends = Array.from({ length: 20 }, (_, index) => {
      const own = { ...delivery, threadId: `thread-${index % 2}`, sendId: `send-${index.toString().padStart(16, "0")}`, text: `Line ${index}` };
      const post = vi.fn((signal: AbortSignal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
      posts.push(post);
      return { own, result: sendReconciled(post, () => false, undefined, own) };
    });
    for (const { own } of [...sends].reverse()) publishLiveFrame({ kind: "message", threadId: own.threadId,
      message: { id: `accepted-${own.sendId}`, role: "user", kind: "text", text: own.text, at: 1, sendId: own.sendId, replyToId: own.replyToId } });
    expect(await Promise.all(sends.map((send) => send.result))).toEqual(Array.from({ length: 20 }, () => ({ arrived: true })));
    expect(posts.every((post) => post.mock.calls.length === 1)).toBe(true);
  });
});

describe("a phone's send on a dead connection", () => {
  const body = { ok: true, threadId: delivery.threadId, message: { id: "accepted" } };
  const hangs = (signal: AbortSignal) => new Promise<object>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  const reopen = () => {
    const source = { onopen: null as (() => void) | null, onerror: null, onmessage: null, close: () => {} };
    const stop = openLiveEvents({ onFrame: () => {}, onSnapshotRequired: async () => true }, {
      createEventSource: () => source, isOnline: () => true, isVisible: () => true, now: Date.now,
    });
    source.onopen?.();
    stop();
  };
  let stopLimit = () => {};
  afterEach(() => stopLimit());

  it("asks again on a new request after the attempt limit instead of waiting on the native 600 s timeout", async () => {
    vi.useFakeTimers();
    stopLimit = limitSendAttempts(20_000);
    const post = vi.fn(hangs).mockImplementationOnce(hangs).mockImplementationOnce(async () => body);
    const result = sendReconciled(post, () => false, undefined, delivery);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(post).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ body });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("asks again at once when the live stream opens again, the place being back", async () => {
    vi.useFakeTimers();
    stopLimit = limitSendAttempts(20_000);
    const post = vi.fn(hangs).mockImplementationOnce(hangs).mockImplementationOnce(async () => body);
    const result = sendReconciled(post, () => false, undefined, delivery);
    await vi.advanceTimersByTimeAsync(5_000);
    reopen();
    await expect(result).resolves.toEqual({ body });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("ends a retry wait when the live stream opens again", async () => {
    vi.useFakeTimers();
    stopLimit = limitSendAttempts(20_000);
    const post = vi.fn().mockRejectedValueOnce(new TypeError("Load failed")).mockRejectedValueOnce(new TypeError("Load failed"))
      .mockRejectedValueOnce(new TypeError("Load failed")).mockResolvedValueOnce(body);
    const result = sendReconciled(post, () => false, undefined, delivery);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(post).toHaveBeenCalledTimes(3);
    reopen();
    await expect(result).resolves.toEqual({ body });
    expect(post).toHaveBeenCalledTimes(4);
  });

  it("ends a retry wait when the phone's network returns while the live stream never dropped", async () => {
    vi.useFakeTimers();
    const network = new EventTarget();
    vi.stubGlobal("window", network);
    stopLimit = limitSendAttempts(20_000);
    const post = vi.fn().mockRejectedValueOnce(new TypeError("Load failed")).mockRejectedValueOnce(new TypeError("Load failed"))
      .mockRejectedValueOnce(new TypeError("Load failed")).mockResolvedValueOnce(body);
    const result = sendReconciled(post, () => false, undefined, delivery);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(post).toHaveBeenCalledTimes(3);
    network.dispatchEvent(new Event("online"));
    await expect(result).resolves.toEqual({ body });
    expect(post).toHaveBeenCalledTimes(4);
    vi.unstubAllGlobals();
  });

  it("hands the send to the outbox after its cut tries", async () => {
    vi.useFakeTimers();
    stopLimit = limitSendAttempts(1_000);
    const post = vi.fn(hangs);
    const result = sendReconciled(post, () => false, undefined, delivery);
    const settled = expect(result).rejects.toBeInstanceOf(SendAttemptCutError);
    await vi.advanceTimersByTimeAsync((SEND_ATTEMPT_CUTS + 1) * 1_000);
    await settled;
    expect(post).toHaveBeenCalledTimes(SEND_ATTEMPT_CUTS + 1);
    expect(sendAnswerLost(new SendAttemptCutError())).toBe(true);
  });

  it("leaves a desktop's slow send alone: no limit is installed there", async () => {
    vi.useFakeTimers();
    const post = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(body), 120_000)));
    const result = sendReconciled(post, () => false, undefined, delivery);
    reopen();
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(result).resolves.toEqual({ body });
    expect(post).toHaveBeenCalledOnce();
  });
});
