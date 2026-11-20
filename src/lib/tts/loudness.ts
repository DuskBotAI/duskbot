// Voices arrive at very different loudness (ElevenLabs, Fish, OpenAI, the built-in one): every spoken clip goes
// through one gentle chain so a quiet voice is heard and a loud one never clips.

let shared: { context: AudioContext; input: AudioNode } | null = null;

/** A soft compressor, about +6 dB of make-up and a limiter at -1 dBFS, ending at `destination`. */
export function loudnessChain(context: BaseAudioContext, destination: AudioNode): AudioNode {
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -26;
  compressor.knee.value = 12;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.25;
  const makeup = context.createGain();
  makeup.gain.value = 2;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -1.5;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.08;
  compressor.connect(makeup);
  makeup.connect(limiter);
  limiter.connect(destination);
  return compressor;
}

/** Plays an <audio> element through the chain. Where the page has no Web Audio it plays as it is. */
export function playLouder(audio: HTMLAudioElement): void {
  try {
    if (typeof globalThis.AudioContext !== "function") return;
    if (!shared) {
      const context = new AudioContext();
      shared = { context, input: loudnessChain(context, context.destination) };
    }
    void shared.context.resume().catch(() => {});
    shared.context.createMediaElementSource(audio).connect(shared.input);
  } catch {
  }
}
