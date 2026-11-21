// A send shows at once as an optimistic user message; the server's copy, which carries the same sendId, replaces it.
import { ApiError } from "./api";
import type { Message } from "./store";
import { listenLiveFrames, onLiveEventsOpen } from "../lib/live-events";
import { holdCloudWaking } from "../lib/cloud-power";
import { t } from "../lib/i18n";

export const optimisticMessageId = (sendId: string): string => `optimistic-${sendId}`;

export function optimisticUserMessage(
  text: string,
  sendId: string,
  replyToId?: string,
  parentId?: string | null,
  channelMode?: "chat" | "goal",
): Message {
  return {
    id: optimisticMessageId(sendId),
    role: "user",
    kind: "text",
    text,
    at: Date.now(),
    parentId: parentId ?? null,
    replyToId,
    sendId,
    channelMode,
  };
}

/** Whether the server's copy of a send is in these messages. */
export function sendArrived(messages: readonly Message[] | undefined, sendId: string): boolean {
  return Boolean(messages?.some((message) => message.sendId === sendId && message.id !== optimisticMessageId(sendId)));
}

/** Long enough to ride out a linked server's tunnel stalling for most of a minute (seen live: 39 s over the relay). */
export const LOST_SEND_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 20_000] as const;

/** A proxy in front of the server answered (the link to a VPS is down or timed out, a Cloud edge is waking it): the
 * send may have reached the server or may reach it soon, and the server never delivers one sendId twice. */
export function sendAnswerLost(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 502 || error.status === 503 || error.status === 504;
  return (error as { name?: unknown } | null)?.name !== "AbortError";
}

/** The send did not reach the server: it is unreachable, not just slow to answer an attempt that was cut short. */
export function sendNotDelivered(error: unknown): boolean {
  return sendAnswerLost(error) && !(error instanceof SendAttemptCutError);
}

let attemptLimitMs: number | null = null;

/** An attempt older than this when the live stream opens again is asked again at once: it went out while the place
 * was away and may be sitting on a dead connection. */
export const SEND_REOPEN_CUT_MS = 1_000;
/** how many cut attempts a send makes before the outbox holds it for the next reconnect or resume */
export const SEND_ATTEMPT_CUTS = 15;

/** The live stream opening again, or the device's network returning while the stream never noticed it was gone. */
function onPlaceBack(run: () => void): () => void {
  const stopOpen = onLiveEventsOpen(run);
  const network = globalThis.window;
  network?.addEventListener("online", run);
  return () => { stopOpen(); network?.removeEventListener("online", run); };
}

/** Each send attempt gets `ms` to be answered before the same sendId goes again on a new request; a live stream that
 * opens again cuts it short too. The server answers every request for one sendId with the one receipt
 * (server/send-idempotency.ts), so asking again never sends twice. Off by default: the phone installs it. */
export function limitSendAttempts(ms: number): () => void {
  attemptLimitMs = ms;
  return () => { if (attemptLimitMs === ms) attemptLimitMs = null; };
}

/** The attempt went unanswered past its limit, or the place came back while it waited. */
export class SendAttemptCutError extends Error {
  constructor() { super("The send was asked again on a fresh request."); this.name = "SendAttemptCutError"; }
}

/** How long a send waits for a Cloud to wake before it gives up, and how often it asks meanwhile. */
export const CLOUD_WAKE_SEND_MS = 3 * 60_000;
export const CLOUD_WAKE_RETRY_MS = 5_000;

/** The Cloud's edge is starting its stopped machine: the send never reached the server yet. */
export function cloudWakingAnswer(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503 && error.body?.error === "waking";
}

/** A Cloud that did not wake within CLOUD_WAKE_SEND_MS: the send was not delivered. */
export class CloudWakeTimeoutError extends Error {
  constructor() { super(t("send.cloudWakeTimeout")); this.name = "CloudWakeTimeoutError"; }
}

export interface SendDelivery {
  threadId: string;
  sendId: string;
  text: string;
  replyToId?: string;
  channelMode?: "chat" | "goal";
}

function confirmsSend(body: unknown, threadId: string): boolean {
  if (!body || typeof body !== "object") return false;
  const receipt = body as { ok?: unknown; threadId?: unknown; message?: { id?: unknown }; queued?: unknown; queueId?: unknown; handled?: unknown };
  return receipt.ok === true && receipt.threadId === threadId &&
    (typeof receipt.message?.id === "string" || (receipt.queued === true && typeof receipt.queueId === "string") || receipt.handled === true);
}

/** A send whose answer was lost may still have reached the server. It is asked again with the same sendId, which the
 * server never delivers twice, until it answers, refuses, or its copy arrives on the live stream. A slow answer is
 * never given up on: the server may be waiting on an engine before it steers or queues the message. */
export async function sendReconciled<T>(
  post: (signal: AbortSignal) => Promise<T>,
  arrived: () => boolean,
  wait?: (ms: number) => Promise<void>,
  delivery?: SendDelivery,
): Promise<{ body: T } | { arrived: true }> {
  const owned = new AbortController();
  let confirmed = false;
  let confirm!: (value: { arrived: true }) => void;
  const delivered = new Promise<{ arrived: true }>((resolve) => { confirm = resolve; });
  const stop = delivery ? listenLiveFrames({ onFrame: (frame) => {
    if (frame.kind !== "message" || frame.threadId !== delivery.threadId) return;
    const message = frame.message;
    if (message.sendId !== delivery.sendId || message.id === optimisticMessageId(delivery.sendId) ||
      message.role !== "user" || message.kind !== "text" || message.text !== delivery.text.trim() ||
      message.replyToId !== delivery.replyToId || (message.channelMode ?? "chat") !== (delivery.channelMode ?? "chat")) return;
    confirmed = true;
    confirm({ arrived: true });
    owned.abort();
  } }) : () => {};
  const limited = attemptLimitMs !== null;
  const beforeRetry = (ms: number): Promise<unknown> => wait ? Promise.race([wait(ms), delivered]) : new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); stopOpen(); owned.signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    const stopOpen = limited ? onPlaceBack(finish) : () => {};
    if (owned.signal.aborted) finish();
    else owned.signal.addEventListener("abort", finish, { once: true });
  });
  /** one try: cut short after the attempt limit, or when the place answers again on the live stream */
  const attempt = async (): Promise<T> => {
    const limit = attemptLimitMs;
    if (limit === null) return post(owned.signal);
    const cut = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => cut.abort(new SendAttemptCutError()), limit);
    const stopOpen = onLiveEventsOpen(() => { if (Date.now() - startedAt >= SEND_REOPEN_CUT_MS) cut.abort(new SendAttemptCutError()); });
    try {
      return await post(AbortSignal.any([owned.signal, cut.signal]));
    } catch (error) {
      throw cut.signal.aborted && !owned.signal.aborted ? cut.signal.reason : error;
    } finally {
      clearTimeout(timer);
      stopOpen();
    }
  };
  const wake: { since: number | null; endHold: (() => void) | null } = { since: null, endHold: null };
  const attempts = async (): Promise<{ body: T } | { arrived: true }> => {
    for (let lost = 0, cuts = 0; ;) {
      if (confirmed) return { arrived: true };
      try {
        const body = await attempt();
        if (delivery && !confirmsSend(body, delivery.threadId)) throw new Error("The server did not confirm this message.");
        return { body };
      } catch (error) {
        if (!sendAnswerLost(error)) throw error;
        if (arrived()) return { arrived: true };
        let delay: number | undefined;
        if (cloudWakingAnswer(error)) {
          wake.since ??= Date.now();
          wake.endHold ??= holdCloudWaking();
          if (Date.now() - wake.since >= CLOUD_WAKE_SEND_MS) throw new CloudWakeTimeoutError();
          delay = Math.min(CLOUD_WAKE_RETRY_MS, wake.since + CLOUD_WAKE_SEND_MS - Date.now());
        } else if (error instanceof SendAttemptCutError) {
          // its wait was the attempt itself, and a slow server is never given up on soon: ask again now
          delay = cuts++ < SEND_ATTEMPT_CUTS ? 0 : undefined;
        } else delay = LOST_SEND_RETRY_MS[lost++];
        if (delay === undefined) throw error;
        if (delay > 0) await beforeRetry(delay);
        if (arrived()) return { arrived: true };
      }
    }
  };
  try {
    return await Promise.race([attempts(), delivered]);
  } finally {
    wake.endHold?.();
    stop();
    owned.abort();
  }
}
