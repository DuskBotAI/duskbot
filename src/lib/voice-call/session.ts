import { NO, YES } from "../../../shared/call-consent";
import { t } from "../i18n";
import { claimCallReplies } from "../spoken-reply-stream";
import type { SpeechStream } from "../tts";
import { MicError } from "../voice-input/mic-capture";
import { CAPTURE_RATE, FRAME_MS, FrameRing, joinFrames, openCallMic, wavBytes, type CallMic } from "./capture";
import { playChime, type ChimeKind } from "./chime";
import { SystemListener, systemListenerAvailable, systemSpeak, systemVoiceAvailable } from "./fallback";
import { CallPlayer, type PlayerEvents, type Prepare, type Render, type SystemVoice } from "./player";
import { crestOf, levelDb, soundsUnfinished, Vad } from "./vad";

export type CallPhase = "connecting" | "listening" | "hearing" | "thinking" | "speaking" | "error";
export type CallErrorKind = "microphone-blocked" | "microphone-missing" | "microphone-failed" | "voice-failed" | "unsupported";

export interface CallSnapshot {
  phase: CallPhase;
  muted: boolean;
  /** What the person is saying, as heard so far. */
  heard: string;
  /** The sentence the bot is saying. */
  caption: string;
  error: { kind: CallErrorKind; message?: string } | null;
  startedAt: number | null;
  /** The last answered turn's timings. */
  lastTurn: TurnTiming | null;
}

/** One spoken turn's timings in ms, from the moment the person stopped talking. */
export interface TurnTiming {
  endpoint: number;
  transcribed: number;
  sent: number;
  firstAudio: number | null;
  words: number;
}

export interface CallFacts {
  busy: boolean;
  approval: { requestId: string; prompt: string } | null;
  question: { requestId: string; messageId: string; prompt: string } | null;
  /** A step the bot just started, with what to say about it. */
  step: { id: string; spoken: string } | null;
}

export interface CallActions {
  send(text: string, callId: string): void;
  decide(requestId: string, allow: boolean): void;
  answer(messageId: string, text: string): void;
}

/** The computer's own recognizer, used until the built-in one is on this computer. */
export interface FallbackListener {
  readonly active: boolean;
  readonly failed: boolean;
  start(): void;
  stop(): void;
}

export interface CallIo {
  fetch: typeof fetch;
  openMic: (onFrame: (frame: Float32Array) => void) => Promise<CallMic>;
  player: (render: Render, prepare: Prepare, events: PlayerEvents, system: SystemVoice | null) => CallPlayer;
  now: () => number;
  /** Null where the computer has no voice of its own. */
  systemVoice: (speed: () => number, language?: string) => SystemVoice | null;
  /** Null where the computer has no recognizer of its own. */
  systemListener: (onSaid: (text: string) => void, language?: string) => FallbackListener | null;
  /** How often to look again while the models are still on their way. */
  pollMs: number;
  chime: (kind: ChimeKind) => Promise<void>;
}

type ModelPhase = { phase: "missing" | "ready" | "downloading" | "failed"; hear?: boolean; speak?: boolean };

const PRE_ROLL_FRAMES = 10;
const PARTIAL_EVERY_MS = 700;
const BARGE_CONFIRM_MS = 160;
const UNFINISHED_HOLD_MS = 900;
const STEP_GAP_MS = 6_000;
const REPLY_WAIT_MS = 15_000;

const defaultIo = (): CallIo => ({
  fetch: (...args) => globalThis.fetch(...args),
  openMic: openCallMic,
  player: (render, prepare, events, system) => new CallPlayer(render, prepare, events, system),
  now: () => performance.now(),
  systemVoice: (speed, language) => (systemVoiceAvailable() ? { use: () => true, speak: (text, signal) => systemSpeak(text, { speed: speed(), signal, language }) } : null),
  systemListener: (onSaid, language) => (systemListenerAvailable() ? new SystemListener(onSaid, language) : null),
  pollMs: 1_500,
  chime: (kind) => playChime(kind),
});

export class VoiceCallSession {
  readonly callId: string;
  private snapshot: CallSnapshot = { phase: "connecting", muted: false, heard: "", caption: "", error: null, startedAt: null, lastTurn: null };
  private readonly watchers = new Set<() => void>();
  private readonly io: CallIo;
  private readonly vad = new Vad();
  private readonly ring = new FrameRing(PRE_ROLL_FRAMES);
  private readonly player: CallPlayer;
  private mic: CallMic | null = null;
  private release: (() => void) | null = null;
  private closed = false;
  private ready = false;
  private utterance: Float32Array[] | null = null;
  private heardPrefix = "";
  /** Which utterance the caption belongs to: a late partial for an earlier one is dropped. */
  private utteranceId = 0;
  private partialBusy = false;
  private lastPartialAt = 0;
  private bargeVoicedMs = 0;
  private barging = false;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private turn = 0;
  private awaitingSince: number | null = null;
  private sawBusy = false;
  private facts: CallFacts = { busy: false, approval: null, question: null, step: null };
  private asked: { kind: "approval"; requestId: string } | { kind: "question"; requestId: string; messageId: string } | null = null;
  private lastStepAt = Number.NEGATIVE_INFINITY;
  private spokenSteps = new Set<string>();
  private pendingTiming: { stoppedAt: number; timing: TurnTiming } | null = null;
  readonly timings: TurnTiming[] = [];
  /** Which halves of the built-in voice are on this computer; until then the computer's own stand in. */
  private halves = { hear: false, speak: false };
  private waiting: Array<() => void> = [];
  private listener: FallbackListener | null = null;
  /** The connect chime: the bot's first words wait for it. */
  private chimed: Promise<void> = Promise.resolve();
  private endChimed = false;
  micLevel = 0;
  voice: string;
  speed: number;
  /** The bot's voice in the voice account set up in Settings, for the "account" choice. */
  accountVoiceId: string | undefined;

  constructor(
    private readonly bot: { id: string; threadId: string },
    private readonly actions: CallActions,
    opts: { voice: string; speed: number; accountVoiceId?: string; io?: Partial<CallIo>;
      /** The bot's own call language (BCP 47); undefined listens and speaks in the computer's own. */
      language?: string },
  ) {
    this.accountVoiceId = opts.accountVoiceId;
    this.io = { ...defaultIo(), ...opts.io };
    this.voice = opts.voice;
    this.speed = opts.speed;
    this.callId = `vc-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    const system = this.io.systemVoice(() => this.speed, opts.language);
    this.player = this.io.player(
      (text, signal) => this.render(text, signal),
      (text, signal) => this.prepareText(text, signal),
      {
        onBlockStart: (text) => this.blockStarted(text),
        onIdle: () => this.refresh(),
        onError: () => {},
      },
      system ? { use: () => this.voice !== "account" && !this.halves.speak, speak: (text, signal) => system.speak(text, signal) } : null,
    );
    this.listener = this.io.systemListener((text) => this.heardBySystem(text), opts.language);
  }

  subscribe(fn: () => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  get state(): CallSnapshot {
    return this.snapshot;
  }

  botLevel(): number {
    return this.player.level();
  }

  private set(patch: Partial<CallSnapshot>): void {
    if (this.closed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of Array.from(this.watchers)) fn();
  }

  /** The phase follows from who holds the floor. */
  private refresh(): void {
    if (this.closed || this.snapshot.phase === "error" || !this.ready) return;
    const now = this.io.now();
    if (this.awaitingSince !== null && !this.facts.busy && (this.sawBusy || now - this.awaitingSince > REPLY_WAIT_MS) && !this.player.speaking) {
      this.awaitingSince = null;
    }
    const phase: CallPhase = this.utterance && !this.barging
      ? "hearing"
      : this.player.speaking
        ? "speaking"
        : this.awaitingSince !== null || (this.facts.busy && !this.asked)
          ? "thinking"
          : "listening";
    if (phase !== this.snapshot.phase) this.set({ phase, ...(phase === "listening" ? { caption: "" } : {}) });
    this.syncListener();
  }

  /** The computer's recognizer listens only while the built-in one is missing and nobody else holds the floor: it has no
   * echo canceller, so it must never hear the bot. */
  private syncListener(): void {
    const listener = this.listener;
    if (!listener) return;
    const want = this.ready && !this.closed && !this.halves.hear && !listener.failed && !this.snapshot.muted && !this.player.speaking;
    if (want && !listener.active) listener.start();
    else if (!want && listener.active) listener.stop();
  }

  private heardBySystem(text: string): void {
    if (this.closed || this.halves.hear) return;
    this.utterance = null;
    this.vad.reset();
    const now = this.io.now();
    this.set({ heard: text });
    this.submit(text, { stoppedAt: now, endpointAt: now, transcribedAt: now });
  }

  /** Resolves once the named half has arrived. */
  private whenReady(half: "hear" | "speak"): Promise<void> {
    if (this.halves[half] || this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (this.halves[half] || this.closed) {
          this.waiting = this.waiting.filter((fn) => fn !== check);
          resolve();
        }
      };
      this.waiting.push(check);
    });
  }

  /** The call starts as soon as the microphone is open, whether or not the built-in voice has arrived yet. */
  async start(): Promise<void> {
    void this.watchVoice().catch(() => undefined);
    try {
      const opened = await this.io.openMic((frame) => this.onFrame(frame));
      if (this.closed) {
        opened.close();
        return;
      }
      this.mic = opened;
      if (this.snapshot.muted) opened.setMuted(true);
    } catch (error) {
      const kind = error instanceof MicError ? error.reason : "microphone-failed";
      this.set({ phase: "error", error: { kind } });
      return;
    }
    if (this.closed || this.snapshot.error?.kind === "unsupported") return;
    this.release = claimCallReplies({ botId: this.bot.id, threadId: this.bot.threadId, sink: { begin: () => this.replyStream() } });
    this.ready = true;
    this.chimed = this.io.chime("start").catch(() => undefined);
    this.set({ phase: "listening", startedAt: Date.now() });
    this.refresh();
  }

  /** Asks for the models (a call's request outranks the background download) and follows them in; a failed download
   * is asked for again later while the computer's own voice carries on. */
  private async watchVoice(): Promise<void> {
    const status = async (): Promise<{ available: boolean; model: ModelPhase }> => {
      const res = await this.io.fetch("/api/voice/local");
      if (!res.ok) throw new Error(`the voice service answered ${res.status}`);
      return res.json();
    };
    const prepare = () => this.io.fetch("/api/voice/local/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
    const first = await status();
    if (!first.available) {
      this.mic?.close();
      this.mic = null;
      this.set({ phase: "error", error: { kind: "unsupported" } });
      return;
    }
    this.take(first.model);
    void prepare();
    let askedAt = this.io.now();
    while (!this.closed && !(this.halves.hear && this.halves.speak)) {
      await new Promise((resolve) => setTimeout(resolve, this.io.pollMs));
      if (this.closed) return;
      const now = await status().catch(() => null);
      if (!now) continue;
      this.take(now.model);
      if (now.model.phase === "failed" && this.io.now() - askedAt > 60_000) {
        askedAt = this.io.now();
        void prepare();
      }
    }
  }

  private take(model: ModelPhase): void {
    const hear = model.phase === "ready" || model.hear === true;
    const speak = model.phase === "ready" || model.speak === true;
    if (hear === this.halves.hear && speak === this.halves.speak) return;
    this.halves = { hear, speak };
    for (const fn of Array.from(this.waiting)) fn();
    this.syncListener();
  }

  private async render(text: string, signal: AbortSignal): Promise<ArrayBuffer> {
    if (this.voice === "account") {
      const res = await this.io.fetch("/api/tts/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, voiceId: this.accountVoiceId }),
        signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `the voice answered ${res.status}`);
      return res.arrayBuffer();
    }
    await this.whenReady("speak");
    const res = await this.io.fetch("/api/voice/local/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice: this.voice, speed: this.speed }),
      signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `the voice answered ${res.status}`);
    return res.arrayBuffer();
  }

  private async prepareText(text: string, signal: AbortSignal): Promise<string[]> {
    const res = await this.io.fetch("/api/tts/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    const body = (await res.json().catch(() => ({}))) as { utterances?: string[] };
    return body.utterances ?? [text];
  }

  private replyStream(): SpeechStream {
    const stream = this.player.begin(() => this.chimed);
    this.refresh();
    return stream;
  }

  private blockStarted(text: string): void {
    const pending = this.pendingTiming;
    if (pending) {
      pending.timing.firstAudio = Math.round(this.io.now() - pending.stoppedAt);
      this.pendingTiming = null;
    }
    this.set({ caption: text, ...(pending ? { lastTurn: { ...pending.timing } } : {}) });
    this.refresh();
  }

  private onFrame(frame: Float32Array): void {
    if (this.closed) return;
    const level = levelDb(frame);
    this.micLevel = 0;
    if (this.snapshot.muted) return;
    const now = this.io.now();
    const botTalking = this.player.speaking;
    const event = this.vad.feed(level, FRAME_MS, now, botTalking, crestOf(frame));
    this.micLevel = this.vad.speaking ? this.vad.gated(level) : 0;
    // The computer's own voice plays outside the echo canceller: while it talks the call takes turns.
    if (!this.ready || (this.player.systemSpeaking && event === "start")) {
      if (event === "start") this.vad.reset();
      return;
    }
    if (this.utterance) this.utterance.push(frame);
    else this.ring.push(frame);

    if (event === "start") {
      if (this.holdTimer) {
        clearTimeout(this.holdTimer);
        this.holdTimer = null;
      }
      this.utterance = this.ring.take();
      this.utteranceId += 1;
      this.set({ heard: this.heardPrefix });
      if (botTalking) {
        this.barging = true;
        this.bargeVoicedMs = 0;
        this.player.duck(true);
      }
      this.refresh();
      return;
    }
    if (this.barging && this.utterance && this.vad.lastVoiceAt === now) {
      this.bargeVoicedMs += FRAME_MS;
      if (this.bargeVoicedMs >= BARGE_CONFIRM_MS) {
        this.barging = false;
        this.player.stop();
        this.set({ caption: "", heard: this.heardPrefix });
        this.refresh();
      }
    }
    if (this.utterance && !this.barging && now - this.lastPartialAt > PARTIAL_EVERY_MS) {
      this.lastPartialAt = now;
      void this.partial();
    }
    if (event === "end") void this.finishUtterance(now);
  }

  private async partial(): Promise<void> {
    if (this.partialBusy || !this.utterance || !this.halves.hear) return;
    this.partialBusy = true;
    const id = this.utteranceId;
    try {
      const text = await this.transcribe(joinFrames(this.utterance), true);
      if (id === this.utteranceId && this.utterance && text) this.set({ heard: [this.heardPrefix, text].filter(Boolean).join(" ") });
    } catch {
    } finally {
      this.partialBusy = false;
    }
  }

  private async transcribe(samples: Float32Array, partial = false): Promise<string> {
    const res = await this.io.fetch(`/api/voice/local/transcribe${partial ? "?partial=1" : ""}`, { method: "POST", headers: { "content-type": "audio/wav" }, body: wavBytes(samples, CAPTURE_RATE) });
    if (!res.ok) throw new Error(`transcription answered ${res.status}`);
    return String(((await res.json()) as { text?: string }).text ?? "").trim();
  }

  private async finishUtterance(endedAt: number): Promise<void> {
    const frames = this.utterance ?? [];
    this.utterance = null;
    const stoppedAt = this.vad.lastVoiceAt || endedAt;
    if (this.barging) {
      this.barging = false;
      this.player.duck(false);
      this.refresh();
      return;
    }
    this.turn += 1;
    const turn = this.turn;
    this.refresh();
    if (!this.halves.hear) {
      // The computer's recognizer has this turn; with none, the words wait for the built-in one.
      if (this.listener && !this.listener.failed) return;
      await this.whenReady("hear");
      if (this.closed || turn !== this.turn) return;
    }
    const voicedFrames = Math.max(1, frames.length - Math.floor((this.vad.endMs - 160) / FRAME_MS));
    const samples = joinFrames(frames.slice(0, voicedFrames));
    let text = "";
    try {
      text = await this.transcribe(samples);
    } catch {
      text = "";
    }
    if (this.closed || turn !== this.turn) return;
    const transcribedAt = this.io.now();
    const said = [this.heardPrefix, text].filter(Boolean).join(" ").trim();
    if (!text) {
      this.set({ heard: this.heardPrefix });
      if (!this.heardPrefix) this.refresh();
      return;
    }
    this.set({ heard: said });
    if (soundsUnfinished(said)) {
      this.heardPrefix = said;
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        if (this.utterance || this.closed) return;
        this.heardPrefix = "";
        this.submit(said, { stoppedAt, endpointAt: endedAt, transcribedAt });
      }, UNFINISHED_HOLD_MS);
      return;
    }
    this.heardPrefix = "";
    this.submit(said, { stoppedAt, endpointAt: endedAt, transcribedAt });
  }

  private submit(said: string, at: { stoppedAt: number; endpointAt: number; transcribedAt: number }): void {
    const asked = this.asked;
    if (asked?.kind === "approval") {
      if (YES.test(said) || NO.test(said)) {
        this.asked = null;
        this.actions.decide(asked.requestId, YES.test(said));
        this.awaitingSince = this.io.now();
        this.sawBusy = false;
      } else {
        void this.player.say(t("call.confirmYesNo"));
      }
      this.refresh();
      return;
    }
    if (asked?.kind === "question") {
      this.asked = null;
      this.actions.answer(asked.messageId, said);
    } else {
      this.actions.send(said, this.callId);
    }
    this.set({ heard: "" });
    const sentAt = this.io.now();
    const timing: TurnTiming = {
      endpoint: Math.round(at.endpointAt - at.stoppedAt),
      transcribed: Math.round(at.transcribedAt - at.stoppedAt),
      sent: Math.round(sentAt - at.stoppedAt),
      firstAudio: null,
      words: said.split(/\s+/).length,
    };
    this.timings.push(timing);
    this.pendingTiming = { stoppedAt: at.stoppedAt, timing };
    this.awaitingSince = sentAt;
    this.sawBusy = false;
    this.refresh();
  }

  /** What the chat shows now: busy, an approval or question to read out, a step just started. */
  update(facts: CallFacts): void {
    this.facts = facts;
    if (facts.busy) this.sawBusy = true;
    if (!this.ready) return;
    if (this.asked?.kind === "approval" && facts.approval?.requestId !== this.asked.requestId) this.asked = null;
    if (this.asked?.kind === "question" && facts.question?.requestId !== this.asked.requestId) this.asked = null;
    if (facts.approval && !this.asked) {
      this.asked = { kind: "approval", requestId: facts.approval.requestId };
      void this.player.say(facts.approval.prompt);
    } else if (facts.question && !this.asked) {
      this.asked = { kind: "question", requestId: facts.question.requestId, messageId: facts.question.messageId };
      void this.player.say(facts.question.prompt);
    } else if (facts.step && facts.busy && !this.spokenSteps.has(facts.step.id)) {
      this.spokenSteps.add(facts.step.id);
      const now = this.io.now();
      if (!this.player.speaking && !this.utterance && now - this.lastStepAt > STEP_GAP_MS) {
        this.lastStepAt = now;
        void this.player.say(facts.step.spoken);
      }
    }
    this.refresh();
  }

  /** Steps that were already in the chat before the call started are never read out. */
  skipSteps(ids: Iterable<string>): void {
    for (const id of ids) this.spokenSteps.add(id);
  }

  setMuted(muted: boolean): void {
    this.mic?.setMuted(muted);
    if (muted) {
      this.utterance = null;
      this.vad.reset();
      if (this.barging) {
        this.barging = false;
        this.player.duck(false);
      }
    }
    this.set(muted ? { muted, heard: "" } : { muted });
    this.refresh();
  }

  setVoice(voice: string, speed: number): void {
    this.voice = voice;
    this.speed = speed;
  }

  /** The person tapped the bot quiet. */
  interrupt(): void {
    this.player.stop();
    this.set({ caption: "", heard: "" });
    this.refresh();
  }

  preview(text: string): void {
    void this.player.say(text);
  }

  /** The hang-up sound, once, and only for a call that connected. */
  endChime(): void {
    if (this.endChimed || !this.ready) return;
    this.endChimed = true;
    void this.io.chime("end").catch(() => undefined);
  }

  close(): void {
    if (this.closed) return;
    this.endChime();
    this.closed = true;
    this.listener?.stop();
    for (const fn of Array.from(this.waiting)) fn();
    this.snapshot = { ...this.snapshot, heard: "", caption: "" };
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.release?.();
    this.mic?.close();
    this.player.close();
    this.watchers.clear();
  }
}
