import { MicError, micFailureReason } from "../voice-input/mic-capture";

export const CAPTURE_RATE = 16_000;
export const FRAME_SAMPLES = 512;
export const FRAME_MS = (FRAME_SAMPLES / CAPTURE_RATE) * 1000;

export interface CallMic {
  setMuted(muted: boolean): void;
  close(): void;
}

/** Chromium's echo canceller hears everything the app plays (Chrome-wide echo cancellation, on by default on macOS,
 * Windows and Linux), so the bot's voice is taken out of the microphone and the person can talk over it. Plain `true`:
 * `echoCancellation: "all"` delivered only silence in headless Chromium 151. */
const CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
};

export async function openCallMic(onFrame: (frame: Float32Array) => void): Promise<CallMic> {
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
    const context = new AudioContext({ sampleRate: CAPTURE_RATE });
    const source = context.createMediaStreamSource(stream);
    // ScriptProcessor rather than an AudioWorklet: no extra module to load, and 32 ms frames are plenty for turn-taking.
    const processor = context.createScriptProcessor(FRAME_SAMPLES, 1, 1);
    let open = true;
    let muted = false;
    processor.onaudioprocess = (event) => {
      if (!open) return;
      const frame = new Float32Array(event.inputBuffer.getChannelData(0));
      onFrame(muted ? frame.fill(0) : frame);
    };
    source.connect(processor);
    processor.connect(context.destination);
    void context.resume().catch(() => {});
    const tracks = stream.getTracks();
    return {
      setMuted(next) {
        muted = next;
        for (const track of tracks) track.enabled = !next;
      },
      close() {
        if (!open) return;
        open = false;
        processor.onaudioprocess = null;
        source.disconnect();
        processor.disconnect();
        for (const track of tracks) track.stop();
        void context.close().catch(() => {});
      },
    };
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    throw error instanceof MicError ? error : new MicError(micFailureReason(error));
  }
}

/** Frames kept from before the voice was recognized, so a turn never loses its first syllable. */
export class FrameRing {
  private readonly frames: Float32Array[] = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(frame: Float32Array): void {
    this.frames.push(frame);
    if (this.frames.length > this.limit) this.frames.shift();
  }

  take(): Float32Array[] {
    return this.frames.splice(0, this.frames.length);
  }
}

export function joinFrames(frames: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let at = 0;
  for (const frame of frames) {
    out.set(frame, at);
    at += frame.length;
  }
  return out;
}

export function wavBytes(samples: Float32Array, rate = CAPTURE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}
