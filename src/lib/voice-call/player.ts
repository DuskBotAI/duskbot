import type { SpeechStream } from "../tts";
import { loudnessChain } from "../tts/loudness";

export type Render = (text: string, signal: AbortSignal) => Promise<ArrayBuffer>;
export type Prepare = (text: string, signal: AbortSignal) => Promise<string[]>;

const AHEAD = 2;
/** A breath between sentences: back to back they sound read, not said. */
const SENTENCE_GAP_S = 0.09;
const FADE_S = 0.06;
const DUCKED = 0.18;

/** The computer's own voice, for blocks said before the built-in voice is ready. */
export interface SystemVoice {
  use(): boolean;
  speak(text: string, signal: AbortSignal): Promise<void>;
}

export interface PlayerEvents {
  /** Fires once for each block as its sound starts. */
  onBlockStart?(text: string, index: number): void;
  onIdle?(): void;
  onError?(message: string): void;
}

export class CallPlayer {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private generation = 0;
  private busyStreams = 0;
  private playheadEnd = 0;
  private readonly render: Render;
  private readonly prepareText: Prepare;
  private readonly events: PlayerEvents;
  private readonly system: SystemVoice | null;
  private systemStop: AbortController | null = null;
  /** The computer's voice is talking: it plays outside the page, where the echo canceller cannot hear it. */
  systemSpeaking = false;
  private systemLevelPhase = 0;

  constructor(render: Render, prepareText: Prepare, events: PlayerEvents = {}, system: SystemVoice | null = null) {
    this.render = render;
    this.prepareText = prepareText;
    this.events = events;
    this.system = system;
  }

  private audio(): { context: AudioContext; gain: GainNode } {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 512;
      this.samples = new Float32Array(this.analyser.fftSize);
      this.gain.connect(this.analyser);
      this.analyser.connect(loudnessChain(this.context, this.context.destination));
    }
    void this.context.resume().catch(() => {});
    return { context: this.context, gain: this.gain! };
  }

  get speaking(): boolean {
    return this.sources.size > 0 || this.busyStreams > 0 || this.systemSpeaking;
  }

  /** 0 to 1, what the bot's voice sounds like right now. */
  level(): number {
    // the computer's voice cannot be measured from the page: a gentle talking motion stands in for it
    if (this.systemSpeaking) {
      this.systemLevelPhase += 0.21;
      return 0.32 + 0.18 * Math.abs(Math.sin(this.systemLevelPhase) * Math.sin(this.systemLevelPhase * 0.37));
    }
    if (!this.analyser || !this.samples || !this.sources.size) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const s of this.samples) sum += s * s;
    return Math.min(1, Math.sqrt(sum / this.samples.length) * 4);
  }

  duck(on: boolean): void {
    if (!this.context || !this.gain) return;
    const now = this.context.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setTargetAtTime(on ? DUCKED : 1, now, 0.03);
  }

  /** Fades out whatever plays and drops what is queued. */
  stop(): void {
    this.generation += 1;
    this.busyStreams = 0;
    this.systemStop?.abort();
    this.systemStop = null;
    this.systemSpeaking = false;
    const context = this.context;
    const gain = this.gain;
    if (context && gain) {
      const now = context.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + FADE_S);
      for (const source of this.sources) {
        try {
          source.stop(now + FADE_S + 0.01);
        } catch {
        }
      }
      gain.gain.setValueAtTime(1, now + FADE_S + 0.02);
    }
    this.sources.clear();
    this.playheadEnd = 0;
  }

  private play(buffer: AudioBuffer, live: () => boolean): Promise<void> {
    const { context, gain } = this.audio();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    const startAt = Math.max(context.currentTime + 0.01, this.playheadEnd ? this.playheadEnd + SENTENCE_GAP_S : 0);
    this.playheadEnd = startAt + buffer.duration;
    this.sources.add(source);
    return new Promise((resolve) => {
      source.onended = () => {
        this.sources.delete(source);
        if (!this.sources.size && context.currentTime >= this.playheadEnd - 0.02) this.playheadEnd = 0;
        resolve();
      };
      if (!live()) {
        this.sources.delete(source);
        resolve();
        return;
      }
      source.start(startAt);
    });
  }

  /** A stream of blocks for one reply; a new stream silences the one before it. */
  /** `gate`: each block waits for it before it plays (the connect chime finishing). */
  begin(gate?: (text: string, index: number) => Promise<void>): SpeechStream {
    this.stop();
    const mine = this.generation;
    const live = () => this.generation === mine;
    const controller = new AbortController();
    const pending: string[] = [];
    let closed = false;
    let wake: (() => void) | null = null;
    let settle: () => void = () => {};
    const done = new Promise<void>((resolve) => { settle = resolve; });
    this.busyStreams += 1;
    let counted = true;
    const release = () => {
      if (counted && live()) this.busyStreams = Math.max(0, this.busyStreams - 1);
      counted = false;
    };

    type Rendered = { buffer: AudioBuffer } | { system: true } | null;
    const run = async () => {
      const { context } = this.audio();
      const rendering: Promise<Rendered>[] = [];
      const playing: Promise<void>[] = [];
      let index = 0;
      const fill = () => {
        while (rendering.length < AHEAD && index + rendering.length < pending.length) {
          const text = pending[index + rendering.length]!;
          // Decided per sentence: once the built-in voice is ready the next sentence uses it, with no gap.
          if (this.system?.use()) {
            rendering.push(Promise.resolve({ system: true as const }));
            continue;
          }
          rendering.push(this.render(text, controller.signal).then((bytes) => context.decodeAudioData(bytes)).then((buffer) => ({ buffer })).catch((error: unknown) => {
            if (live() && !controller.signal.aborted) this.events.onError?.(error instanceof Error ? error.message : String(error));
            return null;
          }));
        }
      };
      for (;;) {
        fill();
        if (!rendering.length) {
          if (closed || !live()) break;
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const rendered = await rendering.shift()!;
        const at = index;
        index += 1;
        if (!live()) break;
        if (!rendered) continue;
        const text = pending[at]!;
        if (gate) {
          await gate(text, at);
          if (!live()) break;
        }
        if ("system" in rendered) {
          await Promise.all(playing.splice(0));
          if (!live() || !this.system) break;
          const stop = new AbortController();
          this.systemStop = stop;
          this.systemSpeaking = true;
          this.events.onBlockStart?.(text, at);
          await this.system.speak(text, stop.signal);
          if (this.systemStop === stop) {
            this.systemStop = null;
            this.systemSpeaking = false;
          }
          continue;
        }
        const startsIn = Math.max(0, (this.playheadEnd ? this.playheadEnd + SENTENCE_GAP_S : context.currentTime) - context.currentTime);
        setTimeout(() => { if (live()) this.events.onBlockStart?.(text, at); }, startsIn * 1000);
        playing.push(this.play(rendered.buffer, live));
      }
      await Promise.all(playing);
    };

    let started = false;
    const kick = () => {
      wake?.();
      if (started) return;
      started = true;
      void run().finally(() => {
        release();
        settle();
        if (live() && !this.speaking) this.events.onIdle?.();
      });
    };

    return {
      push: (block) => {
        if (!block.trim() || closed || !live()) return;
        pending.push(block);
        kick();
      },
      end: () => {
        closed = true;
        if (!started) {
          release();
          settle();
          if (live() && !this.speaking) this.events.onIdle?.();
          return done;
        }
        wake?.();
        return done;
      },
      prepare: (text) => this.prepareText(text, controller.signal),
      identify: () => {},
      cancel: () => {
        if (!live()) return;
        controller.abort();
        this.stop();
        this.events.onIdle?.();
      },
      fail: (error) => {
        if (!live()) return;
        controller.abort();
        this.stop();
        this.events.onError?.(error);
        this.events.onIdle?.();
      },
    };
  }

  /** Speaks a line the call itself says (a question to answer, a step being taken). */
  async say(text: string): Promise<void> {
    const stream = this.begin();
    try {
      for (const block of await stream.prepare(text)) stream.push(block);
    } catch {
      stream.push(text);
    }
    await stream.end();
  }

  close(): void {
    this.stop();
    void this.context?.close().catch(() => {});
    this.context = null;
  }
}
