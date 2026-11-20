import { describe, expect, it } from "vitest";
import { crestOf, levelDb, soundsUnfinished, Vad } from "./vad";

const FRAME = 32;

function run(vad: Vad, levels: Array<[number, number]>, botSpeaking = false) {
  const events: Array<{ at: number; event: string }> = [];
  let now = 0;
  for (const [level, frames] of levels) {
    for (let i = 0; i < frames; i += 1) {
      now += FRAME;
      const event = vad.feed(level, FRAME, now, botSpeaking);
      if (event) events.push({ at: now, event });
    }
  }
  return events;
}

describe("Vad", () => {
  it("starts on a voice over the room's noise and ends after a pause", () => {
    const vad = new Vad();
    const events = run(vad, [[-62, 30], [-25, 20], [-62, 25]]);
    expect(events.map((e) => e.event)).toEqual(["start", "end"]);
    const [start, end] = events;
    expect(start!.at).toBe((30 + 3) * FRAME);
    expect(end!.at - (30 + 20) * FRAME).toBeGreaterThanOrEqual(560);
    expect(end!.at - (30 + 20) * FRAME).toBeLessThan(620);
  });

  it("ignores a click shorter than a syllable", () => {
    expect(run(new Vad(), [[-62, 30], [-20, 1], [-62, 30]])).toEqual([]);
  });

  it("learns a noisy room so its hum is not a voice", () => {
    const vad = new Vad();
    expect(run(vad, [[-42, 200]])).toEqual([]);
    expect(vad.floorDb).toBeGreaterThan(-44);
    expect(run(vad, [[-22, 10]]).map((e) => e.event)).toEqual(["start"]);
  });

  it("needs a louder, longer voice to cut in while the bot talks", () => {
    const quiet = new Vad();
    run(quiet, [[-62, 30]]);
    expect(run(quiet, [[-46, 12]], true)).toEqual([]);
    const firm = new Vad();
    run(firm, [[-62, 30]]);
    const events = run(firm, [[-30, 12]], true);
    expect(events.map((e) => e.event)).toEqual(["start"]);
    expect(events[0]!.at).toBeGreaterThanOrEqual(200);
  });

  it("measures a frame's loudness in dBFS", () => {
    expect(levelDb(new Float32Array(512).fill(1))).toBeCloseTo(0);
    expect(levelDb(new Float32Array(512).fill(0.1))).toBeCloseTo(-20);
    expect(levelDb(new Float32Array(512))).toBe(-100);
  });
});

describe("the noise gate", () => {
  const feedFrames = (vad: Vad, make: (i: number) => Float32Array, frames: number, botSpeaking = false) => {
    const events: string[] = [];
    let now = 0;
    for (let i = 0; i < frames; i += 1) {
      now += FRAME;
      const frame = make(i);
      const event = vad.feed(levelDb(frame), FRAME, now, botSpeaking, crestOf(frame));
      if (event) events.push(event);
    }
    return events;
  };
  const noise = (amplitude: number, seed = 1) => {
    let x = seed;
    return () => Float32Array.from({ length: 512 }, () => {
      x = (x * 16807) % 2147483647;
      return ((x / 2147483647) * 2 - 1) * amplitude;
    });
  };
  const voice = (amplitude: number) => () => Float32Array.from({ length: 512 }, (_, i) => amplitude * (Math.sin(i * 0.11) + 0.5 * Math.sin(i * 0.37)));
  const click = (amplitude: number) => () => {
    const frame = new Float32Array(512);
    frame[100] = amplitude;
    frame[101] = -amplitude * 0.8;
    return frame;
  };

  it("follows a fan that gets louder without taking it for a voice, and still hears the person over it", () => {
    const vad = new Vad();
    const fan = noise(0.002);
    expect(feedFrames(vad, fan, 40)).toEqual([]);
    const louder = noise(0.008, 7);
    expect(feedFrames(vad, (i) => louder().map((s) => s * Math.min(1, 0.3 + i / 300)), 300)).toEqual([]);
    expect(vad.floorDb).toBeGreaterThan(-50);
    expect(vad.gated(levelDb(louder()))).toBe(0);
    expect(feedFrames(vad, voice(0.12), 20)).toEqual(["start"]);
  });

  it("never starts a turn on keyboard clicks, however loud", () => {
    const vad = new Vad();
    feedFrames(vad, noise(0.001), 20);
    expect(feedFrames(vad, click(0.9), 60)).toEqual([]);
    expect(crestOf(click(0.9)())).toBeGreaterThan(9);
    expect(crestOf(voice(0.1)())).toBeLessThan(9);
  });

  it("lets neither a fan nor typing cut the bot off", () => {
    const vad = new Vad();
    feedFrames(vad, noise(0.003), 20);
    expect(feedFrames(vad, noise(0.006, 3), 60, true)).toEqual([]);
    expect(feedFrames(vad, click(0.9), 60, true)).toEqual([]);
    expect(feedFrames(vad, voice(0.2), 20, true)).toEqual(["start"]);
  });
});

describe("soundsUnfinished", () => {
  it("hears a trailing 'and' or 'um' as a pause for thought", () => {
    expect(soundsUnfinished("Book a table for two and")).toBe(true);
    expect(soundsUnfinished("so um")).toBe(true);
    expect(soundsUnfinished("Book a table for two.")).toBe(false);
    expect(soundsUnfinished("What's the weather")).toBe(false);
  });
});
