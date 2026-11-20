import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav, normalizeLoudness, normalizePeak, speechLevelDb } from "./wav.ts";

const RATE = 24_000;
const tone = (amplitude: number, seconds = 1) => Float32Array.from({ length: RATE * seconds }, (_, i) => amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE));

describe("normalizeLoudness", () => {
  it("brings quiet speech up to about -16 dB, and never past -1.5 dBFS", () => {
    const quiet = tone(0.08);
    const out = normalizeLoudness(quiet, RATE);
    expect(speechLevelDb(out, RATE)).toBeGreaterThan(-17.5);
    expect(speechLevelDb(out, RATE)).toBeLessThan(-14.5);
    expect(Math.max(...out.map(Math.abs))).toBeLessThanOrEqual(10 ** (-1.5 / 20) + 1e-6);
  });

  it("bends a loud peak under the ceiling instead of clipping it", () => {
    const loud = tone(1.4);
    const out = normalizeLoudness(loud, RATE, -6);
    expect(Math.max(...out.map(Math.abs))).toBeLessThan(0.85);
  });

  it("leaves silence as it is and caps the boost at +12 dB", () => {
    expect(normalizeLoudness(new Float32Array(100), RATE)).toHaveLength(100);
    const whisper = tone(0.01);
    expect(Math.max(...normalizeLoudness(whisper, RATE).map(Math.abs))).toBeCloseTo(0.04, 3);
  });
});

describe("normalizePeak and WAV round trips", () => {
  it("raises a quiet microphone turn to near -1 dBFS, at most +20 dB", () => {
    expect(Math.max(...normalizePeak(tone(0.2)).map(Math.abs))).toBeCloseTo(0.89, 2);
    expect(Math.max(...normalizePeak(tone(0.01)).map(Math.abs))).toBeCloseTo(0.1, 2);
  });

  it("decodes what it encodes, resampled to the rate asked for", () => {
    const back = decodeWav(encodeWav(tone(0.5), RATE), 16_000);
    expect(back.length).toBe(16_000);
    expect(Math.max(...back.map(Math.abs))).toBeCloseTo(0.5, 1);
  });
});
