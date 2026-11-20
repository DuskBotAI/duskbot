import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicError } from "../voice-input/mic-capture";
import { callReplyOwner } from "../spoken-reply-stream";
import { VoiceCallSession, type CallActions, type CallIo } from "./session";
import type { CallPlayer, SystemVoice } from "./player";

const QUIET = 0.0005;
const VOICE = 0.05;

function harness(opts: { heard?: string[]; micError?: MicError; model?: "ready" | "downloading"; listener?: boolean } = {}) {
  let clock = 0;
  let feed: ((frame: Float32Array) => void) | null = null;
  const heard = [...(opts.heard ?? ["what's on my calendar"])];
  const requests: string[] = [];
  const chimes: string[] = [];
  const mic = { setMuted: vi.fn(), close: vi.fn() };
  const player = {
    speaking: false,
    begin: vi.fn(() => ({ push: vi.fn(), end: vi.fn(async () => {}), prepare: vi.fn(async (t: string) => [t]), identify: vi.fn(), cancel: vi.fn(), fail: vi.fn() })),
    say: vi.fn(async () => {}),
    stop: vi.fn(() => { player.speaking = false; }),
    duck: vi.fn(),
    level: () => 0,
    close: vi.fn(),
  };
  let downloads = opts.model === "downloading" ? 3 : 0;
  let system: SystemVoice | null = null;
  let said: ((text: string) => void) | null = null;
  const listener = { active: false, failed: false, start: vi.fn(() => { listener.active = true; }), stop: vi.fn(() => { listener.active = false; }) };
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/voice/local") {
      const model = downloads > 0 ? { phase: "downloading", received: 50, total: 100, hear: false, speak: false } : { phase: "ready", hear: true, speak: true };
      if (downloads > 0) downloads -= 1;
      return Response.json({ available: true, model });
    }
    if (url === "/api/voice/local/prepare") return Response.json({ model: { phase: "ready" } }, { status: 202 });
    if (url === "/api/voice/local/transcribe?partial=1") return Response.json({ text: heard[0] ?? "" });
    if (url === "/api/voice/local/transcribe") return Response.json({ text: heard.shift() ?? "" });
    if (url === "/api/tts/prepare") return Response.json({ utterances: [JSON.parse(String(init?.body)).text] });
    return new Response("{}", { status: 404 });
  });
  const io: Partial<CallIo> = {
    fetch: fetchImpl as unknown as typeof fetch,
    openMic: async (onFrame) => {
      if (opts.micError) throw opts.micError;
      feed = onFrame;
      return mic;
    },
    player: (_render, _prepare, _events, voice) => {
      system = voice;
      return player as unknown as CallPlayer;
    },
    now: () => clock,
    pollMs: 400,
    chime: async (kind) => { chimes.push(kind); },
    systemVoice: () => ({ use: () => true, speak: async () => {} }),
    systemListener: (onSaid) => {
      if (!opts.listener) return null;
      said = onSaid;
      return listener;
    },
  };
  const actions: CallActions & { sent: Array<[string, string]>; decided: Array<[string, boolean]>; answered: Array<[string, string]> } = {
    sent: [], decided: [], answered: [],
    send(text, callId) { this.sent.push([text, callId]); },
    decide(requestId, allow) { this.decided.push([requestId, allow]); },
    answer(messageId, text) { this.answered.push([messageId, text]); },
  };
  const session = new VoiceCallSession({ id: "bot-1", threadId: "thread-1" }, actions, { voice: "af_heart", speed: 1, io });
  const frames = async (amplitude: number, count: number) => {
    for (let i = 0; i < count; i += 1) {
      clock += 32;
      feed?.(new Float32Array(512).fill(amplitude));
      await vi.advanceTimersByTimeAsync(32);
    }
  };
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
  };
  return { session, actions, player, mic, frames, settle, requests, chimes, listener, systemVoice: () => system, saySystem: (text: string) => said?.(text), advance: async (ms: number) => { clock += ms; await vi.advanceTimersByTimeAsync(ms); } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("VoiceCallSession", () => {
  it("sends what the person said once they stop, marked as said on this call", async () => {
    const { session, actions, frames, settle } = harness();
    await session.start();
    expect(session.state.phase).toBe("listening");
    expect(callReplyOwner("thread-1")).toEqual({ botId: "bot-1" });
    await frames(QUIET, 15);
    await frames(VOICE, 25);
    expect(session.state.phase).toBe("hearing");
    await frames(QUIET, 25);
    await settle();
    expect(actions.sent).toEqual([["what's on my calendar", session.callId]]);
    expect(session.state.phase).toBe("thinking");
    expect(session.timings).toHaveLength(1);
    expect(session.timings[0]!.endpoint).toBeGreaterThanOrEqual(540);
    session.close();
    expect(callReplyOwner("thread-1")).toBeNull();
  });

  it("sends nothing for a click or for words it could not make out", async () => {
    const { session, actions, frames, settle } = harness({ heard: [""] });
    await session.start();
    await frames(QUIET, 15);
    await frames(VOICE, 1);
    await frames(QUIET, 25);
    await frames(VOICE, 20);
    await frames(QUIET, 25);
    await settle();
    expect(actions.sent).toEqual([]);
    expect(session.state.phase).toBe("listening");
  });

  it("waits after a trailing 'and', then sends both halves as one line", async () => {
    const { session, actions, frames, settle } = harness({ heard: ["book a table for two and", "make it eight pm"] });
    await session.start();
    await frames(QUIET, 15);
    await frames(VOICE, 20);
    await frames(QUIET, 22);
    await settle();
    expect(actions.sent).toEqual([]);
    await frames(VOICE, 20);
    await frames(QUIET, 22);
    await settle();
    expect(actions.sent.map(([text]) => text)).toEqual(["book a table for two and make it eight pm"]);
  });

  it("sends a trailing 'and' on its own once the pause runs out", async () => {
    const { session, actions, frames, settle, advance } = harness({ heard: ["so um"] });
    await session.start();
    await frames(QUIET, 15);
    await frames(VOICE, 20);
    await frames(QUIET, 22);
    await settle();
    await advance(1_000);
    expect(actions.sent.map(([text]) => text)).toEqual(["so um"]);
  });

  it("cuts the bot off when the person keeps talking over it", async () => {
    const { session, player, frames } = harness();
    await session.start();
    await frames(QUIET, 15);
    player.speaking = true;
    await frames(VOICE, 7);
    expect(player.duck).toHaveBeenCalledWith(true);
    expect(player.stop).not.toHaveBeenCalled();
    await frames(VOICE, 10);
    expect(player.stop).toHaveBeenCalled();
    expect(session.state.phase).toBe("hearing");
  });

  it("only dips the bot for a short noise, then lets it finish", async () => {
    const { session, player, actions, frames, settle, requests } = harness();
    await session.start();
    await frames(QUIET, 15);
    player.speaking = true;
    await frames(VOICE, 7);
    await frames(QUIET, 4);
    expect(player.duck).toHaveBeenLastCalledWith(true);
    await frames(QUIET, 22);
    await settle();
    expect(player.duck).toHaveBeenLastCalledWith(false);
    expect(player.stop).not.toHaveBeenCalled();
    expect(actions.sent).toEqual([]);
    expect(requests.filter((r) => r.includes("/transcribe"))).toEqual([]);
  });

  it("reads out an approval and takes a spoken yes as the answer", async () => {
    const { session, player, actions, frames, settle } = harness({ heard: ["yes go ahead"] });
    await session.start();
    session.update({ busy: true, approval: { requestId: "req-1", prompt: "Can Scout run a command?" }, question: null, step: null });
    expect(player.say).toHaveBeenCalledWith("Can Scout run a command?");
    await frames(QUIET, 15);
    await frames(VOICE, 20);
    await frames(QUIET, 25);
    await settle();
    expect(actions.decided).toEqual([["req-1", true]]);
    expect(actions.sent).toEqual([]);
  });

  it("reads a step the bot starts, but not one from before the call", async () => {
    const { session, player } = harness();
    session.skipSteps(["old"]);
    await session.start();
    session.update({ busy: true, approval: null, question: null, step: { id: "old", spoken: "Searching the web" } });
    expect(player.say).not.toHaveBeenCalled();
    session.update({ busy: true, approval: null, question: null, step: { id: "new", spoken: "Checking your calendar" } });
    expect(player.say).toHaveBeenCalledWith("Checking your calendar");
  });

  it("hears nothing while muted", async () => {
    const { session, mic, actions, frames, settle } = harness();
    await session.start();
    await frames(QUIET, 15);
    session.setMuted(true);
    expect(mic.setMuted).toHaveBeenCalledWith(true);
    await frames(VOICE, 20);
    await frames(QUIET, 25);
    await settle();
    expect(actions.sent).toEqual([]);
    expect(session.state.muted).toBe(true);
  });

  it("says when the microphone is blocked", async () => {
    const { session } = harness({ micError: new MicError("microphone-blocked") });
    await session.start();
    expect(session.state).toMatchObject({ phase: "error", error: { kind: "microphone-blocked" } });
  });

  it("starts at once while the voice downloads, leaning on the computer's own, and takes the built-in one as it lands", async () => {
    const { session, actions, listener, systemVoice, saySystem, settle } = harness({ model: "downloading", listener: true });
    await session.start();
    expect(session.state.phase).toBe("listening");
    expect(listener.start).toHaveBeenCalled();
    expect(systemVoice()?.use()).toBe(true);
    saySystem("hello there");
    await settle();
    expect(actions.sent.map(([text]) => text)).toEqual(["hello there"]);
    expect(session.state.heard).toBe("");
    await vi.advanceTimersByTimeAsync(1_600);
    expect(systemVoice()?.use()).toBe(false);
    expect(listener.stop).toHaveBeenCalled();
    expect(listener.active).toBe(false);
  });

  it("hands the call back to Take turns where the built-in voice cannot run", async () => {
    const { session, requests } = harness();
    requests.length = 0;
    const blocked = new VoiceCallSession({ id: "b", threadId: "t" }, { send() {}, decide() {}, answer() {} }, {
      voice: "af_heart", speed: 1,
      io: { fetch: (async () => Response.json({ available: false, model: { phase: "missing" } })) as unknown as typeof fetch, openMic: async () => ({ setMuted() {}, close() {} }), systemVoice: () => null, systemListener: () => null, now: () => 0, pollMs: 400, chime: async () => {} },
    });
    await blocked.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(blocked.state).toMatchObject({ phase: "error", error: { kind: "unsupported" } });
    session.close();
  });

  it("clears the live caption when a line is sent, and starts the next one from its own first words", async () => {
    const { session, frames, settle } = harness({ heard: ["right so the plan works", "what about friday"] });
    const shown: string[] = [];
    session.subscribe(() => {
      if (shown.at(-1) !== session.state.heard) shown.push(session.state.heard);
    });
    await session.start();
    await frames(QUIET, 15);
    await frames(VOICE, 30);
    expect(session.state.heard).toBe("right so the plan works");
    await frames(QUIET, 22);
    await settle();
    expect(session.state.heard).toBe("");
    await frames(VOICE, 2);
    await frames(VOICE, 2);
    expect(session.state.phase).toBe("hearing");
    expect(["", "what about friday"]).toContain(session.state.heard);
    await frames(VOICE, 26);
    expect(session.state.heard).toBe("what about friday");
    expect(shown).not.toContain("right so the plan works what about friday");
    session.setMuted(true);
    expect(session.state.heard).toBe("");
  });

  it("chimes once when the call connects and once when it ends, and never for a call that did not connect", async () => {
    const { session, chimes } = harness();
    await session.start();
    expect(chimes).toEqual(["start"]);
    session.endChime();
    session.close();
    expect(chimes).toEqual(["start", "end"]);
    const failed = harness({ micError: new MicError("microphone-blocked") });
    await failed.session.start();
    failed.session.close();
    expect(failed.chimes).toEqual([]);
  });
});
