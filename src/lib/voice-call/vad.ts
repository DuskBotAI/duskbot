export interface VadTuning {
  /** dB over the room's noise floor that counts as a voice. */
  marginDb: number;
  /** Stricter while the bot talks, so what is left of its echo never cuts it off. */
  bargeMarginDb: number;
  /** Voice must last this long to start a turn. */
  startMs: number;
  bargeStartMs: number;
  /** Quiet this long ends the turn. */
  endMs: number;
  /** Below this a sound is never a voice, however quiet the room. */
  minLevelDb: number;
  /** The first moments only learn the room. */
  calibrateMs: number;
  /** A frame whose peak stands this far over its average is a click or a tap, not a voice. */
  maxCrest: number;
  /** What the waveform and the caption leave out: anything within this of the room's floor. */
  gateDb: number;
}

export const DEFAULT_TUNING: VadTuning = {
  marginDb: 11,
  bargeMarginDb: 17,
  startMs: 90,
  bargeStartMs: 200,
  endMs: 560,
  minLevelDb: -52,
  calibrateMs: 400,
  maxCrest: 9,
  gateDb: 7,
};

/** The room's floor follows this low share of the quiet frames heard over the last few seconds. */
const FLOOR_PERCENTILE = 0.2;
const FLOOR_FRAMES = 96;

export type VadEvent = "start" | "end" | null;

export function levelDb(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i]! * frame[i]!;
  const rms = Math.sqrt(sum / Math.max(1, frame.length));
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

/** Peak over RMS: about 1.4 for a steady tone, 3 to 6 for a voice, far higher for a click. */
export function crestOf(frame: Float32Array): number {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const s = frame[i]!;
    sum += s * s;
    if (Math.abs(s) > peak) peak = Math.abs(s);
  }
  const rms = Math.sqrt(sum / Math.max(1, frame.length));
  return rms > 0 ? peak / rms : 0;
}

export class Vad {
  floorDb = -60;
  speaking = false;
  private voicedMs = 0;
  private quietMs = 0;
  /** When the last voiced frame ended, in the caller's clock. */
  lastVoiceAt = 0;
  private readonly tuning: VadTuning;
  private heardMs = 0;
  private readonly quiet = new Float32Array(FLOOR_FRAMES);
  private quietCount = 0;
  private quietAt = 0;

  constructor(tuning: Partial<VadTuning> = {}) {
    this.tuning = { ...DEFAULT_TUNING, ...tuning };
  }

  get endMs(): number {
    return this.tuning.endMs;
  }

  reset(): void {
    this.speaking = false;
    this.voicedMs = 0;
    this.quietMs = 0;
  }

  /** 0 to 1: how far a sound stands over the room, nothing for the room itself. */
  gated(level: number): number {
    return Math.max(0, Math.min(1, (level - this.floorDb - this.tuning.gateDb) / 30));
  }

  private learn(level: number): void {
    this.quiet[this.quietAt] = level;
    this.quietAt = (this.quietAt + 1) % FLOOR_FRAMES;
    this.quietCount = Math.min(FLOOR_FRAMES, this.quietCount + 1);
    if (this.quietCount < 8 || this.quietAt % 8 !== 0) return;
    const sorted = Array.from(this.quiet.subarray(0, this.quietCount)).sort((a, b) => a - b);
    const target = sorted[Math.floor((sorted.length - 1) * FLOOR_PERCENTILE)]!;
    this.floorDb = Math.min(-30, Math.max(-80, this.floorDb + (target - this.floorDb) * 0.35));
  }

  feed(level: number, frameMs: number, now: number, botSpeaking = false, crest = 0): VadEvent {
    if (this.heardMs < this.tuning.calibrateMs) {
      const weight = frameMs / (this.heardMs + frameMs);
      this.floorDb = this.heardMs === 0 ? Math.max(-80, Math.min(-30, level)) : Math.max(-80, Math.min(-30, this.floorDb + (level - this.floorDb) * weight));
      this.heardMs += frameMs;
      this.learn(level);
      return null;
    }
    const margin = botSpeaking ? this.tuning.bargeMarginDb : this.tuning.marginDb;
    const loud = level >= Math.max(this.floorDb + margin, this.tuning.minLevelDb);
    const voiced = loud && crest <= this.tuning.maxCrest;
    if (!loud && !this.speaking) {
      if (level < this.floorDb) this.floorDb = Math.max(-80, this.floorDb + (level - this.floorDb) * 0.25);
      this.learn(level);
    }
    if (voiced) {
      this.voicedMs += frameMs;
      this.quietMs = 0;
      this.lastVoiceAt = now;
      const needed = botSpeaking ? this.tuning.bargeStartMs : this.tuning.startMs;
      if (!this.speaking && this.voicedMs >= needed) {
        this.speaking = true;
        return "start";
      }
      return null;
    }
    this.quietMs += frameMs;
    if (!this.speaking) {
      this.voicedMs = Math.max(0, this.voicedMs - frameMs * 2);
      return null;
    }
    if (this.quietMs >= this.tuning.endMs) {
      this.speaking = false;
      this.voicedMs = 0;
      return "end";
    }
    return null;
  }
}

const TRAILING = /\b(?:and|but|so|or|because|um+|uh+|like|the|a|an|to|with|of|for|if|then|which|that)[,.…]?$/i;

/** A turn that stops on one of these words is usually a pause for thought, not the end. */
export function soundsUnfinished(text: string): boolean {
  return TRAILING.test(text.trim());
}
