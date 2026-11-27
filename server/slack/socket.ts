import { WebSocket } from "ws";
import { z } from "zod";
import { allowedSocketUrl, SlackApiError, type SlackApi } from "./api.ts";

export type SlackSocketState = "connecting" | "online" | "offline" | "error";
export interface SlackSocketDeps {
  appToken: () => string | null;
  api: SlackApi;
  onEvent: (payload: Record<string, unknown>, meta: { envelopeId: string; type: string; retryAttempt: number }) => void | Promise<void>;
  ackAfterEvent?: boolean;
  onState: (state: SlackSocketState, error?: string) => void;
  WebSocketImpl?: typeof WebSocket;
  random?: () => number;
  log?: (line: string) => void;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  pingIntervalMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

type Timer = { cancel(): void };
const record = z.record(z.string(), z.unknown());
const refusedTokens = new Set(["invalid_auth", "not_authed", "token_revoked", "account_inactive"]);

export function createSlackSocket(deps: SlackSocketDeps): { start(): void; stop(): void; state(): SlackSocketState } {
  const Socket = deps.WebSocketImpl ?? WebSocket;
  const random = deps.random ?? Math.random;
  const log = deps.log ?? (() => {});
  const setTimer = deps.setTimer ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  });
  const base = deps.backoffBaseMs ?? 1000;
  const max = deps.backoffMaxMs ?? 60_000;
  const seen = new Set<string>();
  let running = false;
  let status: SlackSocketState = "offline";
  let generation = 0;
  let attempt: object | null = null;
  let socket: WebSocket | null = null;
  let closing: Promise<void> | null = null;
  let reconnect: Timer | null = null;
  let ping: Timer | null = null;
  let pong: Timer | null = null;
  let stable: Timer | null = null;
  let backoff = base;

  function state(value: SlackSocketState, error?: string) {
    status = value;
    deps.onState(value, error);
  }

  function release(terminate = false) {
    generation++;
    attempt = null;
    ping?.cancel();
    pong?.cancel();
    stable?.cancel();
    ping = pong = stable = null;
    const old = socket;
    socket = null;
    if (!old || old.readyState === WebSocket.CLOSED) return;
    const done = new Promise<void>((resolve) => old.once("close", () => resolve()));
    closing = done;
    void done.then(() => { if (closing === done) closing = null; });
    if (terminate) old.terminate();
    else old.close(1000);
  }

  function retry() {
    if (!running || reconnect) return;
    const delay = backoff * (0.8 + random() * 0.4);
    backoff = Math.min(max, backoff * 2);
    const epoch = generation;
    reconnect = setTimer(() => {
      if (!running || generation !== epoch) return;
      reconnect = null;
      void connect();
    }, delay);
  }

  function lost() {
    release(true);
    state("offline");
    retry();
  }

  function fatal(error: string) {
    running = false;
    reconnect?.cancel();
    reconnect = null;
    release();
    state("error", error);
  }

  async function deliver(payload: Record<string, unknown>, envelopeId: string, retryAttempt: number) {
    try {
      await deps.onEvent(payload, { envelopeId, type: "events_api", retryAttempt });
    } catch {
      log("Slack event handling failed.");
    }
  }

  async function connect() {
    if (!running || socket || attempt || reconnect) return;
    const current = {};
    attempt = current;
    const epoch = generation;
    const active = () => running && generation === epoch && attempt === current;
    try {
      if (closing) await closing;
      if (!active()) return;
      const token = deps.appToken();
      if (!token) {
        running = false;
        attempt = null;
        state("offline");
        return;
      }
      state("connecting");
      if (!active()) return;
      const result = await deps.api.call<{ url?: unknown }>("apps.connections.open", token);
      if (!active()) return;
      if (typeof result.url !== "string" || !allowedSocketUrl(result.url, deps.api.testOrigin)) {
        attempt = null;
        log("Slack sent an unexpected connection address.");
        state("error", "Slack sent an unexpected connection address.");
        retry();
        return;
      }
      const ws = new Socket(result.url, { handshakeTimeout: 15_000, maxPayload: 4 * 1024 * 1024 });
      socket = ws;
      const live = () => active() && socket === ws;
      const fail = () => { if (live()) lost(); };
      const schedulePing = () => {
        ping = setTimer(() => {
          if (!live()) return;
          ping = null;
          if (!pong) {
            pong = setTimer(() => {
              if (!live()) return;
              log("Slack socket did not answer a ping.");
              lost();
            }, 10_000);
          }
          try { ws.ping(undefined, undefined, (error) => { if (error) fail(); }); }
          catch { fail(); }
          if (live()) schedulePing();
        }, deps.pingIntervalMs ?? 30_000);
      };
      ws.on("open", () => { if (live()) schedulePing(); });
      ws.on("pong", () => {
        if (!live()) return;
        pong?.cancel();
        pong = null;
      });
      ws.on("close", fail);
      ws.on("error", () => {
        if (!live()) return;
        log("Slack socket connection failed.");
        lost();
      });
      ws.on("message", (data) => {
        if (!live()) return;
        let frame: Record<string, unknown>;
        try { frame = record.parse(JSON.parse(data.toString())); }
        catch { log("Slack sent an invalid socket message."); return; }
        if (typeof frame.envelope_id === "string") {
          const id = frame.envelope_id;
          const acknowledge = () => {
            if (!live()) return;
            try { ws.send(JSON.stringify({ envelope_id: id }), (error) => { if (error) fail(); }); }
            catch { fail(); }
          };
          const remember = () => {
            seen.add(id);
            if (seen.size > 500) seen.delete(seen.values().next().value!);
          };
          if (!deps.ackAfterEvent || frame.type !== "events_api" || seen.has(id)) acknowledge();
          if (!live() || seen.has(id)) return;
          if (!deps.ackAfterEvent || frame.type !== "events_api") remember();
          if (frame.type !== "events_api") return;
          const payload = record.safeParse(frame.payload);
          if (!payload.success) { log("Slack sent an invalid socket message."); if (deps.ackAfterEvent) acknowledge(); return; }
          const attempt = typeof frame.retry_attempt === "number" ? frame.retry_attempt : 0;
          if (deps.ackAfterEvent) {
            void Promise.resolve().then(() => deps.onEvent(payload.data, { envelopeId: id, type: "events_api", retryAttempt: attempt }))
              .then(() => { if (live()) { remember(); acknowledge(); } })
              .catch(() => log("Slack event handling failed."));
          } else void deliver(payload.data, id, attempt);
        } else if (frame.type === "hello") {
          if (status === "online") return;
          stable = setTimer(() => { if (live()) backoff = base; }, 60_000);
          state("online");
        } else if (frame.type === "disconnect") {
          if (frame.reason === "link_disabled") { fatal("Socket Mode is off for this app."); return; }
          release();
          state("offline");
          void connect();
        }
      });
    } catch (error) {
      if (!active()) return;
      if (error instanceof SlackApiError && refusedTokens.has(error.code)) {
        fatal("Slack refused the app-level token.");
      } else {
        log("Slack socket connection failed.");
        lost();
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      backoff = base;
      void connect();
    },
    stop() {
      running = false;
      reconnect?.cancel();
      reconnect = null;
      release();
      state("offline");
    },
    state: () => status,
  };
}

export function createSlackSockets(make: (botId: string) => SlackSocketDeps): {
  ensure(botId: string): void; stop(botId: string): void; stopAll(): void; state(botId: string): SlackSocketState | null;
} {
  const sockets = new Map<string, ReturnType<typeof createSlackSocket>>();
  return {
    ensure(botId) {
      if (sockets.has(botId)) return;
      const socket = createSlackSocket(make(botId));
      sockets.set(botId, socket);
      socket.start();
    },
    stop(botId) { sockets.get(botId)?.stop(); sockets.delete(botId); },
    stopAll() { for (const socket of sockets.values()) socket.stop(); sockets.clear(); },
    state: (botId) => sockets.get(botId)?.state() ?? null,
  };
}
