// The call's two sounds, made here: a light rising pair of notes when it connects and a gentle falling pair when it
// ends. Soft sines with a quiet octave below, about 360 ms, well under the bot's voice. They play where the app's
// sounds are on (Settings > Notifications).
import { notificationSoundsEnabled } from "../notification-preferences";

export type ChimeKind = "start" | "end";

const NOTES: Record<ChimeKind, readonly [number, number]> = {
  start: [783.99, 1046.5],
  end: [1046.5, 698.46],
};
const NOTE_S = 0.2;
const SECOND_AT_S = 0.11;
/** Peak of each note: about -20 LUFS for the pair, a step under the voice's -16. */
const PEAK = 0.13;

let context: AudioContext | null = null;

function note(ctx: AudioContext, frequency: number, at: number, peak: number): void {
  for (const [ratio, share] of [[1, 1], [0.5, 0.25]] as const) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = frequency * ratio;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak * share, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0008, at + NOTE_S);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + NOTE_S + 0.02);
  }
}

/** Plays the chime and resolves when it has finished; resolves at once where sounds are off or there is no audio. */
export function playChime(kind: ChimeKind, { force = false }: { force?: boolean } = {}): Promise<void> {
  if ((!force && !notificationSoundsEnabled()) || typeof globalThis.AudioContext !== "function") return Promise.resolve();
  try {
    context ??= new AudioContext();
    const ctx = context;
    void ctx.resume().catch(() => {});
    const at = ctx.currentTime + 0.02;
    const peak = kind === "end" ? PEAK * 0.85 : PEAK;
    note(ctx, NOTES[kind][0], at, peak);
    note(ctx, NOTES[kind][1], at + SECOND_AT_S, peak);
    return new Promise((resolve) => setTimeout(resolve, (0.02 + SECOND_AT_S + NOTE_S) * 1000 + 20));
  } catch {
    return Promise.resolve();
  }
}

export const CHIME_MS = Math.round((0.02 + SECOND_AT_S + NOTE_S) * 1000 + 20);
