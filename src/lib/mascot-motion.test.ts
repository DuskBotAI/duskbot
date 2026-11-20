import { describe, expect, it, vi } from "vitest";
import { DELIGHT_GAP_MS, MASCOT_MOTION, MascotDirector, type MascotMotion } from "./mascot-motion";
import { createTicker } from "./mascot-ticker";
import { WORKING_MOODS, type WorkingMood } from "./working-mood";

function play(director: MascotDirector, script: Array<[WorkingMood, number]>, step = 1000 / 60): MascotMotion[] {
  const frames: MascotMotion[] = [];
  let at = 0;
  for (const [mood, ms] of script) {
    director.setMood(mood, at);
    for (const end = at + ms; at < end; at += step) frames.push(director.motion(at));
  }
  return frames;
}

const LONG_TURN: Array<[WorkingMood, number]> = [["thinking", 14_000], ["searching", 9_000], ["browsing", 12_000], ["writing", 30_000], ["thinking", 3_000], ["running", 20_000], ["replying", 15_000], ["done", 4_000]];
const turnDiff = (a: number, b: number) => Math.abs(((((b - a + 180) % 360) + 360) % 360) - 180);
const SEEDS = ["nova", "quill", "rivet", "x", ""];

describe("the working mascot's gentle flat motion", () => {
  it("ships the gentle flat mascot", () => {
    expect(MASCOT_MOTION).toBe("flat-gentle");
  });

  it("plays a delight only every 18 to 25 s, two or three in a minute-long turn, never the same one twice running", () => {
    for (const seed of SEEDS) {
      const director = new MascotDirector({ seed });
      play(director, [["thinking", 15_000], ["searching", 10_000], ["browsing", 15_000], ["writing", 20_000]]);
      const played = director.played;
      expect(played.length, seed).toBeGreaterThanOrEqual(2);
      expect(played.length, seed).toBeLessThanOrEqual(3);
      expect(played[0]!.at).toBeGreaterThanOrEqual(DELIGHT_GAP_MS);
      for (let i = 1; i < played.length; i++) {
        expect(played[i]!.at - played[i - 1]!.at).toBeGreaterThanOrEqual(DELIGHT_GAP_MS);
        expect(played[i]!.kind).not.toBe(played[i - 1]!.kind);
      }
    }
  });

  it("plays no delight while it fails, waits or is done", () => {
    const director = new MascotDirector({ seed: "s" });
    play(director, [["error", 60_000], ["waiting", 60_000], ["done", 60_000]]);
    expect(director.played).toEqual([]);
  });

  it("holds its motion through a step shorter than 3 s, but answers a reply or a failure at once", () => {
    const director = new MascotDirector({ seed: "s" });
    director.motion(0);
    director.setMood("searching", 1000);
    director.motion(3500);
    expect(director.shownMood, "a short step").toBe("thinking");
    director.setMood("writing", 3900);
    director.motion(6000);
    expect(director.shownMood).toBe("thinking");
    director.motion(6900);
    expect(director.shownMood, "after 3 s of writing").toBe("writing");
    director.setMood("searching", 7000);
    director.setMood("writing", 8000);
    director.motion(11_000);
    expect(director.shownMood, "a step that came back changes nothing").toBe("writing");
    director.setMood("replying", 11_100);
    expect(director.shownMood).toBe("replying");
    director.setMood("error", 11_200);
    expect(director.shownMood).toBe("error");
  });

  it("moves without a jump at 120 fps, even when the step changes mid-spin", () => {
    for (const seed of SEEDS) {
      const director = new MascotDirector({ seed });
      const flicker = Array.from({ length: 90 }, (_, i): [WorkingMood, number] => [(["writing", "searching", "error", "thinking", "replying", "browsing"] as const)[i % 6], 300 + (i % 7) * 900]);
      const frames = play(director, [["thinking", 20_000], ...flicker, ...LONG_TURN], 1000 / 120);
      for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1]!, b = frames[i]!;
        expect(Math.abs(b.y - a.y), `y at ${i}`).toBeLessThan(0.03);
        expect(Math.abs(b.x - a.x), `x at ${i}`).toBeLessThan(0.03);
        expect(Math.abs(b.sy - a.sy), `sy at ${i}`).toBeLessThan(0.05);
        expect(turnDiff(a.rot, b.rot), `rot at ${i}`).toBeLessThan(10);
      }
    }
  });

  it("stays flat and small: it never moves the words or leaves its row", () => {
    const frames = play(new MascotDirector({ seed: "s" }), LONG_TURN);
    expect(Math.max(...frames.map((m) => Math.abs(m.x)))).toBeLessThan(0.1);
    expect(Math.min(...frames.map((m) => m.y))).toBeGreaterThan(-0.2);
    expect(Math.max(...frames.map((m) => m.y))).toBeLessThanOrEqual(0.001);
  });

  it("holds one still pose per mood under reduced motion", () => {
    const director = new MascotDirector({ seed: "s", reduced: true });
    for (const mood of WORKING_MOODS) {
      const keys = new Set(play(director, [[mood, 20_000]], 50).map((m) => JSON.stringify(m)));
      expect(keys.size, mood).toBe(1);
    }
    expect(director.played).toEqual([]);
  });

  it("hops happily as the reply lands, and droops on a failure", () => {
    const director = new MascotDirector({ seed: "s" });
    director.setMood("replying", 0);
    const hop = Array.from({ length: 70 }, (_, i) => director.motion(200 + i * 20));
    expect(hop.every((m) => m.face === "happy")).toBe(true);
    expect(Math.min(...hop.map((m) => m.y))).toBeLessThan(-0.08);
    director.setMood("error", 2000);
    const droop = director.motion(5000);
    expect([droop.face, droop.sy < 0.97, droop.rot < 0]).toEqual(["sad", true, true]);
  });
});

describe("the mascots' shared frame loop", () => {
  const fakeClock = () => {
    let next = 1;
    const queued = new Map<number, (now: number) => void>();
    const listeners = new Set<() => void>();
    const doc = {
      hidden: false,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
    const clock = { raf: vi.fn((fn: (now: number) => void) => { queued.set(next, fn); return next++; }), caf: vi.fn((id: number) => void queued.delete(id)), doc: doc as unknown as Document };
    const flush = (now: number) => { const fns = [...queued.values()]; queued.clear(); fns.forEach((fn) => fn(now)); };
    const setHidden = (hidden: boolean) => { doc.hidden = hidden; listeners.forEach((fn) => fn()); };
    return { clock, flush, setHidden, queued };
  };

  it("runs one loop for every mascot and stops while the page is hidden", () => {
    const { clock, flush, setHidden, queued } = fakeClock();
    const ticker = createTicker(clock);
    const a = vi.fn(), b = vi.fn();
    const offA = ticker.subscribe(a);
    ticker.subscribe(b);
    expect(queued.size).toBe(1);
    flush(16);
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
    setHidden(true);
    expect([ticker.running, queued.size]).toEqual([false, 0]);
    flush(32);
    expect(a).toHaveBeenCalledTimes(1);
    setHidden(false);
    flush(48);
    expect(a).toHaveBeenCalledTimes(2);
    offA();
    flush(64);
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([2, 3]);
  });

  it("stops when the last mascot leaves", () => {
    const { clock, queued } = fakeClock();
    const ticker = createTicker(clock);
    const off = ticker.subscribe(() => {});
    off();
    expect([ticker.running, queued.size]).toEqual([false, 0]);
  });
});
