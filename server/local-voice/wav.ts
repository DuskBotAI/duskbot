export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    out.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), 44 + i * 2);
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

const CEILING = 10 ** (-1.5 / 20);
const KNEE = 0.7;

/** Soft limiting above KNEE: peaks bend smoothly towards -1.5 dBFS, under -1 dBTP once played, and never clip. */
function limit(x: number): number {
  const magnitude = Math.abs(x);
  if (magnitude <= KNEE) return x;
  const room = CEILING - KNEE;
  return Math.sign(x) * (KNEE + room * Math.tanh((magnitude - KNEE) / room));
}

/** The loudness of speech, in dBFS: the RMS of 20 ms windows that hold a voice, silence and breaths left out (close to
 * LUFS for speech, which K-weighting barely moves). */
export function speechLevelDb(samples: Float32Array, rate: number): number {
  const window = Math.max(1, Math.round(rate * 0.02));
  let sum = 0;
  let count = 0;
  for (let start = 0; start + window <= samples.length; start += window) {
    let energy = 0;
    for (let i = start; i < start + window; i += 1) energy += samples[i]! * samples[i]!;
    const mean = energy / window;
    if (mean > 1e-5) {
      sum += mean;
      count += 1;
    }
  }
  return count ? 10 * Math.log10(sum / count) : -100;
}

/** Brings speech to `targetDb` (about -16 LUFS), at most +12 dB, with a gentle limiter so nothing clips. */
export function normalizeLoudness(samples: Float32Array, rate: number, targetDb = -16): Float32Array {
  const level = speechLevelDb(samples, rate);
  if (level <= -90) return samples;
  const gain = Math.min(4, 10 ** ((targetDb - level) / 20));
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = limit(samples[i]! * gain);
  return out;
}

/** A quiet microphone's turn raised so its loudest moment sits near -1 dBFS, at most +20 dB. */
export function normalizePeak(samples: Float32Array, ceiling = 0.89, maxGain = 10): Float32Array {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  if (peak < 1e-4) return samples;
  const gain = Math.min(maxGain, ceiling / peak);
  if (Math.abs(gain - 1) < 0.05) return samples;
  return samples.map((s) => s * gain);
}

export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const at = i * ratio;
    const left = Math.floor(at);
    const right = Math.min(left + 1, samples.length - 1);
    out[i] = samples[left]! + (samples[right]! - samples[left]!) * (at - left);
  }
  return out;
}

/** PCM16 or float32 WAV, any rate and channel count, as mono samples at `rate`. */
export function decodeWav(bytes: Uint8Array, rate: number): Float32Array {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("audio must be a WAV file");
  }
  let format = 0;
  let channels = 1;
  let sourceRate = rate;
  let bits = 16;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sourceRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      const end = Math.min(buf.length, body + size);
      const width = bits / 8;
      const frames = Math.floor((end - body) / (width * channels));
      const mono = new Float32Array(frames);
      for (let f = 0; f < frames; f += 1) {
        let sum = 0;
        for (let c = 0; c < channels; c += 1) {
          const at = body + (f * channels + c) * width;
          sum += format === 3 && bits === 32 ? buf.readFloatLE(at) : bits === 16 ? buf.readInt16LE(at) / 32768 : 0;
        }
        mono[f] = sum / channels;
      }
      return resample(mono, sourceRate, rate);
    }
    offset = body + size + (size % 2);
  }
  throw new Error("the WAV file has no audio data");
}
