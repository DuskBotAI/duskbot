// What a call uses until the built-in voice's models are on this computer: the computer's own voice and recognizer.
// Neither goes through the page's echo canceller, so while they are in use the call takes turns.
import { speechBridge } from "../speech";

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined" ? window.speechSynthesis : null;
}

/** The most natural English voice installed: a Premium or Enhanced macOS voice when there is one. */
export function bestSystemVoice(voices: readonly SpeechSynthesisVoice[], language = globalThis.navigator?.language ?? "en-US"): SpeechSynthesisVoice | null {
  const base = language.split("-")[0]!.toLowerCase();
  const matching = voices.filter((voice) => voice.lang.toLowerCase().startsWith(base));
  const pool = matching.length ? matching : voices.filter((voice) => voice.lang.toLowerCase().startsWith("en"));
  const score = (voice: SpeechSynthesisVoice) =>
    (/premium/i.test(voice.name) ? 40 : 0) + (/enhanced/i.test(voice.name) ? 30 : 0) + (/siri/i.test(voice.name) ? 20 : 0)
    + (voice.lang === language ? 5 : 0) + (voice.localService ? 2 : 0) + (voice.default ? 1 : 0);
  return [...pool].sort((a, b) => score(b) - score(a))[0] ?? null;
}

export function systemVoiceAvailable(): boolean {
  return synth() !== null && typeof window.SpeechSynthesisUtterance !== "undefined";
}

/** Says one sentence with the computer's voice; resolves when it is done or stopped. */
export function systemSpeak(text: string, { speed, signal, onStart, language }: { speed: number; signal: AbortSignal; onStart?: () => void; language?: string }): Promise<void> {
  const speech = synth();
  if (!speech || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const utterance = new window.SpeechSynthesisUtterance(text);
    const voice = bestSystemVoice(speech.getVoices(), language);
    if (voice) utterance.voice = voice;
    utterance.rate = speed;
    const done = () => {
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const stop = () => {
      speech.cancel();
      done();
    };
    utterance.onstart = () => onStart?.();
    utterance.onend = done;
    utterance.onerror = done;
    signal.addEventListener("abort", stop, { once: true });
    speech.speak(utterance);
  });
}

/** Whether this computer has a recognizer of its own the call can lean on. */
export function systemListenerAvailable(): boolean {
  return typeof speechBridge()?.speechStart === "function";
}

/** The computer's recognizer, one turn at a time: it ends a turn after its own pause and hands over the words. */
export class SystemListener {
  private running = false;
  /** The recognizer could not run: the call waits for the built-in one. */
  failed = false;
  private offs: Array<() => void> = [];
  private readonly onSaid: (text: string) => void;
  private readonly language: string | undefined;

  constructor(onSaid: (text: string) => void, language?: string) {
    this.onSaid = onSaid;
    this.language = language;
  }

  get active(): boolean {
    return this.running;
  }

  start(): void {
    const bridge = speechBridge();
    if (this.running || this.failed || !bridge?.speechStart) return;
    this.running = true;
    this.offs = [
      bridge.onSpeechTranscript((line) => {
        if (!this.running || line.error || typeof line.text !== "string" || line.partial !== false) return;
        const said = line.text.trim();
        if (said) this.onSaid(said);
      }),
      bridge.onSpeechEnd(({ code }) => {
        if (!this.running) return;
        this.running = false;
        this.release();
        // A turn ended cleanly: listen for the next one. A failure (no permission, no recognizer) stays stopped.
        if (!code) this.start();
        else this.failed = true;
      }),
    ];
    void bridge.speechStart({ endpointMs: 700, ...(this.language ? { locale: this.language } : {}) }).catch(() => {
      this.running = false;
      this.failed = true;
      this.release();
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.release();
    void speechBridge()?.speechStop();
  }

  private release(): void {
    for (const off of this.offs.splice(0)) off();
  }
}
