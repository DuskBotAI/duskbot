import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { nativeRequire } from "../data/engine.ts";
import { normalizeLoudness, normalizePeak } from "./wav.ts";
import { createG2p, type LexiconTable } from "./g2p.ts";
import type { ModelStore } from "./models.ts";

type Ort = typeof import("onnxruntime-node");
type Session = import("onnxruntime-node").InferenceSession;

export const KOKORO_RATE = 24_000;
export const MOONSHINE_RATE = 16_000;
/** Kokoro's style table has 510 rows: one per possible phoneme count. */
const MAX_PHONEMES = 509;
const THREADS = 4;

export const BUILT_IN_VOICES = [
  { id: "af_heart", label: "Heart", accent: "us" },
  { id: "af_bella", label: "Bella", accent: "us" },
  { id: "af_sarah", label: "Sarah", accent: "us" },
  { id: "am_michael", label: "Michael", accent: "us" },
  { id: "am_fenrir", label: "Fenrir", accent: "us" },
  { id: "am_puck", label: "Puck", accent: "us" },
  { id: "bf_emma", label: "Emma", accent: "gb" },
  { id: "bm_george", label: "George", accent: "gb" },
] as const;
export type BuiltInVoice = (typeof BUILT_IN_VOICES)[number]["id"];
export const DEFAULT_VOICE: BuiltInVoice = "af_heart";

export function isBuiltInVoice(value: unknown): value is BuiltInVoice {
  return BUILT_IN_VOICES.some((voice) => voice.id === value);
}

/** Whether this platform's ONNX Runtime binding is installed, without loading it. */
export function ortInstalled(): boolean {
  try {
    const root = path.dirname(nativeRequire().resolve("onnxruntime-node/package.json"));
    return existsSync(path.join(root, "bin", "napi-v6", process.platform, process.arch, "onnxruntime_binding.node"));
  } catch {
    return false;
  }
}

let ortLoad: Promise<Ort | null> | null = null;
/** Null where no native build exists for this platform. Loaded from the packaged app's staged native modules, like
 * DuckDB, since a native addon cannot be bundled. */
export function loadOrt(): Promise<Ort | null> {
  ortLoad ??= Promise.resolve().then(() => nativeRequire()("onnxruntime-node") as Ort).catch(() => null);
  return ortLoad;
}

/** Inference runs one job at a time: two models at once would fight for the same cores. */
class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

interface Tokenizer {
  idToToken: string[];
}

function moonshineTokenizer(json: { model: { vocab: Record<string, number> }; added_tokens?: { id: number; content: string }[] }): Tokenizer {
  const idToToken: string[] = [];
  for (const [token, id] of Object.entries(json.model.vocab)) idToToken[id] = token;
  for (const added of json.added_tokens ?? []) idToToken[added.id] = added.content;
  return { idToToken };
}

export function decodeTokens(tokenizer: Tokenizer, ids: readonly number[]): string {
  const bytes: number[] = [];
  let text = "";
  const flush = () => {
    if (bytes.length) text += Buffer.from(bytes).toString("utf8");
    bytes.length = 0;
  };
  for (const id of ids) {
    const token = tokenizer.idToToken[id];
    if (!token || /^<.*>$/.test(token) && !/^<0x[0-9A-F]{2}>$/.test(token)) continue;
    const byte = /^<0x([0-9A-F]{2})>$/.exec(token);
    if (byte) {
      bytes.push(parseInt(byte[1]!, 16));
      continue;
    }
    flush();
    text += token.replaceAll("▁", " ");
  }
  flush();
  return text.trim();
}

/** Leading and trailing near-silence trimmed to a short pad, so a reply starts on its first sound. */
export function trimSilence(samples: Float32Array, rate: number, padMs = 40, threshold = 0.01): Float32Array {
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start]!) < threshold) start += 1;
  while (end > start && Math.abs(samples[end - 1]!) < threshold) end -= 1;
  const pad = Math.round((rate * padMs) / 1000);
  return samples.subarray(Math.max(0, start - pad), Math.min(samples.length, end + pad));
}

export class LocalVoiceEngine {
  private readonly serial = new Serial();
  private kokoro: Promise<{ session: Session; vocab: Record<string, number>; g2p: (text: string) => string }> | null = null;
  private moonshine: Promise<{ encoder: Session; decoder: Session; tokenizer: Tokenizer }> | null = null;
  private readonly styles = new Map<string, Float32Array>();

  private readonly models: ModelStore;

  constructor(models: ModelStore) {
    this.models = models;
  }

  private async ort(): Promise<Ort> {
    const ort = await loadOrt();
    if (!ort) throw new Error("the built-in voice cannot run on this computer");
    return ort;
  }

  private async loadKokoro() {
    const ort = await this.ort();
    const json = async (file: string) => JSON.parse(await readFile(this.models.file(file), "utf8"));
    const [session, tokenizer, gold, silver, extra] = await Promise.all([
      ort.InferenceSession.create(this.models.file("kokoro/model_q8f16.onnx"), { intraOpNumThreads: THREADS }),
      json("kokoro/tokenizer.json"),
      json("lexicon/us_gold.json") as Promise<LexiconTable>,
      json("lexicon/us_silver.json") as Promise<LexiconTable>,
      json("lexicon/cmu_misaki_us.json") as Promise<LexiconTable>,
    ]);
    return { session, vocab: tokenizer.model.vocab as Record<string, number>, g2p: createG2p({ gold, silver, extra }) };
  }

  private async loadMoonshine() {
    const ort = await this.ort();
    const [encoder, decoder, tokenizer] = await Promise.all([
      ort.InferenceSession.create(this.models.file("moonshine/encoder_model_quantized.onnx"), { intraOpNumThreads: THREADS }),
      ort.InferenceSession.create(this.models.file("moonshine/decoder_model_merged_quantized.onnx"), { intraOpNumThreads: THREADS }),
      readFile(this.models.file("moonshine/tokenizer.json"), "utf8").then((text) => moonshineTokenizer(JSON.parse(text))),
    ]);
    return { encoder, decoder, tokenizer };
  }

  private kokoroReady() {
    this.kokoro ??= this.loadKokoro().catch((error) => {
      this.kokoro = null;
      throw error;
    });
    return this.kokoro;
  }

  private moonshineReady() {
    this.moonshine ??= this.loadMoonshine().catch((error) => {
      this.moonshine = null;
      throw error;
    });
    return this.moonshine;
  }

  /** Loads both models so the first turn of a call does not pay for it. */
  async warm(halves: { hear: boolean; speak: boolean } = { hear: true, speak: true }): Promise<void> {
    await Promise.all([halves.speak ? this.kokoroReady() : null, halves.hear ? this.moonshineReady() : null]);
    if (halves.speak) await this.speak("Hi.", DEFAULT_VOICE, 1);
  }

  private async style(voice: BuiltInVoice): Promise<Float32Array> {
    let table = this.styles.get(voice);
    if (!table) {
      const bytes = await readFile(this.models.file(`kokoro/voices/${voice}.bin`));
      table = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice();
      this.styles.set(voice, table);
    }
    return table;
  }

  phonemes(text: string): Promise<string> {
    return this.kokoroReady().then(({ g2p }) => g2p(text));
  }

  /** Mono float samples at KOKORO_RATE. */
  async speak(text: string, voice: BuiltInVoice, speed: number): Promise<Float32Array> {
    const ort = await this.ort();
    const { session, vocab, g2p } = await this.kokoroReady();
    const table = await this.style(voice);
    const ids = [...g2p(text)].map((c) => vocab[c]).filter((id): id is number => id !== undefined).slice(0, MAX_PHONEMES);
    if (!ids.length) return new Float32Array(0);
    const style = table.slice(ids.length * 256, ids.length * 256 + 256);
    const input = [0, ...ids, 0];
    return this.serial.run(async () => {
      const out = await session.run({
        input_ids: new ort.Tensor("int64", BigInt64Array.from(input, BigInt), [1, input.length]),
        style: new ort.Tensor("float32", style, [1, 256]),
        speed: new ort.Tensor("float32", new Float32Array([speed]), [1]),
      });
      return normalizeLoudness(trimSilence(Object.values(out)[0]!.data as Float32Array, KOKORO_RATE), KOKORO_RATE);
    });
  }

  /** Mono float samples at MOONSHINE_RATE in, words out. */
  async transcribe(samples: Float32Array): Promise<string> {
    if (samples.length < MOONSHINE_RATE * 0.15) return "";
    const ort = await this.ort();
    const { encoder, decoder, tokenizer } = await this.moonshineReady();
    return this.serial.run(async () => {
      const encoded = await encoder.run({ input_values: new ort.Tensor("float32", normalizePeak(samples), [1, samples.length]) });
      const hidden = encoded.last_hidden_state!;
      const layers = decoder.inputNames.filter((name) => name.endsWith(".decoder.key")).length;
      const headDim = 52;
      const heads = 8;
      const empty = () => new ort.Tensor("float32", new Float32Array(0), [1, heads, 0, headDim]);
      const past: Record<string, import("onnxruntime-node").Tensor> = {};
      for (let layer = 0; layer < layers; layer += 1) {
        for (const kind of ["decoder", "encoder"]) {
          past[`past_key_values.${layer}.${kind}.key`] = empty();
          past[`past_key_values.${layer}.${kind}.value`] = empty();
        }
      }
      // About 6.5 tokens a second of speech is Moonshine's own generation limit.
      const maxTokens = Math.min(200, Math.ceil((samples.length / MOONSHINE_RATE) * 6.5) + 4);
      const tokens: number[] = [];
      let next = 1;
      for (let step = 0; step < maxTokens; step += 1) {
        const out = await decoder.run({
          input_ids: new ort.Tensor("int64", BigInt64Array.from([BigInt(next)]), [1, 1]),
          encoder_hidden_states: hidden,
          use_cache_branch: new ort.Tensor("bool", [step > 0], [1]),
          ...past,
        });
        const logits = out.logits!.data as Float32Array;
        let best = 0;
        for (let i = 1; i < logits.length; i += 1) if (logits[i]! > logits[best]!) best = i;
        if (best === 2) break;
        tokens.push(best);
        next = best;
        for (let layer = 0; layer < layers; layer += 1) {
          past[`past_key_values.${layer}.decoder.key`] = out[`present.${layer}.decoder.key`]!;
          past[`past_key_values.${layer}.decoder.value`] = out[`present.${layer}.decoder.value`]!;
          if (step === 0) {
            past[`past_key_values.${layer}.encoder.key`] = out[`present.${layer}.encoder.key`]!;
            past[`past_key_values.${layer}.encoder.value`] = out[`present.${layer}.encoder.value`]!;
          }
        }
      }
      return decodeTokens(tokenizer, tokens);
    });
  }
}
