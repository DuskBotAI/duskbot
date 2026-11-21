import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { phoneSpeech, type SpeechPermissions, type SpeechPlugin } from "../../apps/mobile/src/native-platform";

type Listener = (event: Record<string, unknown>) => void;

function fakePlugin(options: { check?: SpeechPermissions; request?: SpeechPermissions; startError?: { code?: string } } = {}) {
  const listeners = new Map<string, Listener>();
  const plugin = {
    checkPermissions: vi.fn(async () => options.check ?? { microphone: "granted", speech: "granted" }),
    requestPermissions: vi.fn(async () => options.request ?? { microphone: "granted", speech: "granted" }),
    openSettings: vi.fn(async () => {}),
    start: vi.fn(async (_options: { locale?: string; session: number }) => {
      if (options.startError) throw Object.assign(new Error("failed"), options.startError);
    }),
    finish: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    addListener: vi.fn(async (event: string, listener: Listener) => {
      listeners.set(event, listener);
      return { remove: async () => { listeners.delete(event); } };
    }),
  };
  const emit = (event: string, data: Record<string, unknown>) => listeners.get(event)?.(data);
  const session = () => plugin.start.mock.calls.at(-1)?.[0].session;
  return { plugin, emit, session, typed: plugin as unknown as SpeechPlugin };
}

function watch(bridge: ReturnType<typeof phoneSpeech>) {
  const lines = vi.fn();
  const ends = vi.fn();
  const levels = vi.fn();
  bridge.onSpeechTranscript(lines);
  bridge.onSpeechEnd(ends);
  bridge.onSpeechLevel?.(levels);
  return { lines, ends, levels };
}

describe("phone speech bridge", () => {
  it("starts with the locale and turns native events into bridge callbacks", async () => {
    const fake = fakePlugin();
    const bridge = phoneSpeech(fake.typed);
    const seen = watch(bridge);
    await bridge.speechStart({ locale: "de-DE" });
    expect(fake.plugin.requestPermissions).not.toHaveBeenCalled();
    expect(fake.plugin.start).toHaveBeenCalledWith({ locale: "de-DE", session: fake.session() });
    const session = fake.session();

    fake.emit("transcript", { text: "hallo", partial: true, session });
    fake.emit("level", { level: 1.4, session });
    fake.emit("level", { level: 0.3, session });
    fake.emit("transcript", { text: "hallo welt", partial: false, session });
    fake.emit("end", { code: 0, reason: "completed", session });

    expect(seen.lines.mock.calls).toEqual([[{ partial: true, text: "hallo" }], [{ partial: false, text: "hallo welt" }]]);
    expect(seen.levels.mock.calls).toEqual([[1], [0.3]]);
    expect(seen.ends.mock.calls).toEqual([[{ code: 0, reason: "completed" }]]);
  });

  it("finishes through the plugin and ignores events from an earlier session", async () => {
    const fake = fakePlugin();
    const bridge = phoneSpeech(fake.typed);
    const seen = watch(bridge);
    await bridge.speechStart();
    const first = fake.session();
    await bridge.speechStart();
    const second = fake.session();
    expect(second).not.toBe(first);

    fake.emit("transcript", { text: "old", partial: true, session: first });
    fake.emit("end", { code: 0, session: first });
    await bridge.speechFinish?.();
    expect(fake.plugin.finish).toHaveBeenCalledTimes(1);
    fake.emit("transcript", { text: "new", partial: false, session: second });
    fake.emit("end", { code: 0, reason: "completed", session: second });

    expect(seen.lines.mock.calls).toEqual([[{ partial: false, text: "new" }]]);
    expect(seen.ends.mock.calls).toEqual([[{ code: 0, reason: "completed" }]]);
    // listeners are added once, not per session
    expect(fake.plugin.addListener).toHaveBeenCalledTimes(3);
  });

  it("stop cancels quietly and drops whatever arrives after", async () => {
    const fake = fakePlugin();
    const bridge = phoneSpeech(fake.typed);
    const seen = watch(bridge);
    await bridge.speechStart();
    const session = fake.session();
    await bridge.speechStop();
    expect(fake.plugin.stop).toHaveBeenCalledTimes(1);
    fake.emit("transcript", { text: "late", session });
    fake.emit("end", { code: 0, session });
    await bridge.speechFinish?.();
    expect(fake.plugin.finish).not.toHaveBeenCalled();
    expect(seen.lines).not.toHaveBeenCalled();
    expect(seen.ends).not.toHaveBeenCalled();
  });

  it("asks for permission on first start and ends blocked when refused", async () => {
    const fake = fakePlugin({ check: { microphone: "prompt", speech: "prompt" }, request: { microphone: "granted", speech: "denied" } });
    const bridge = phoneSpeech(fake.typed);
    const seen = watch(bridge);
    await bridge.speechStart();
    expect(fake.plugin.requestPermissions).toHaveBeenCalledTimes(1);
    expect(fake.plugin.start).not.toHaveBeenCalled();
    expect(seen.ends.mock.calls).toEqual([[{ code: 1, reason: "microphone-blocked" }]]);
  });

  it("accepts android's microphone-only permission", async () => {
    const fake = fakePlugin({ check: { microphone: "prompt-with-rationale" }, request: { microphone: "granted" } });
    const bridge = phoneSpeech(fake.typed);
    const seen = watch(bridge);
    await bridge.speechStart();
    expect(fake.plugin.start).toHaveBeenCalledTimes(1);
    expect(seen.ends).not.toHaveBeenCalled();
  });

  it.each([
    ["recognizer-unavailable", { code: 2, reason: "recognizer-unavailable" }],
    ["unsupported-locale", { code: 2, reason: "unsupported-locale" }],
    ["microphone-blocked", { code: 1, reason: "microphone-blocked" }],
    [undefined, { code: 1, reason: "recognition-error" }],
  ] as const)("ends a start that fails with %s", async (code, expected) => {
    const fake = fakePlugin({ startError: { code } });
    const bridge = phoneSpeech(fake.typed);
    const seen = watch(bridge);
    await bridge.speechStart();
    expect(seen.ends.mock.calls).toEqual([[expected]]);
  });

  describe("in a call", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("finishes the turn once the words stop for the call's endpoint, and not while they keep coming", async () => {
      const fake = fakePlugin();
      const bridge = phoneSpeech(fake.typed);
      watch(bridge);
      await bridge.speechStart({ endpointMs: 850 });
      const session = fake.session();
      vi.advanceTimersByTime(5_000);
      expect(fake.plugin.finish).not.toHaveBeenCalled();
      fake.emit("transcript", { text: "what is", partial: true, session });
      vi.advanceTimersByTime(800);
      fake.emit("transcript", { text: "what is on today", partial: true, session });
      vi.advanceTimersByTime(800);
      expect(fake.plugin.finish).not.toHaveBeenCalled();
      vi.advanceTimersByTime(50);
      expect(fake.plugin.finish).toHaveBeenCalledTimes(1);
    });

    it("leaves dictation without an endpoint to the person, and a stopped call never finishes later", async () => {
      const fake = fakePlugin();
      const bridge = phoneSpeech(fake.typed);
      watch(bridge);
      await bridge.speechStart();
      fake.emit("transcript", { text: "a long note", partial: true, session: fake.session() });
      vi.advanceTimersByTime(10_000);
      expect(fake.plugin.finish).not.toHaveBeenCalled();
      await bridge.speechStart({ endpointMs: 850 });
      fake.emit("transcript", { text: "hello", partial: true, session: fake.session() });
      await bridge.speechStop();
      vi.advanceTimersByTime(2_000);
      expect(fake.plugin.finish).not.toHaveBeenCalled();
    });
  });
});
