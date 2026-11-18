import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerFrame } from "../../shared/wire";

const frames = vi.hoisted(() => ({ listeners: [] as Array<{ screens?: boolean; onFrame: (frame: unknown) => void }>, stopped: 0 }));
vi.mock("@/lib/live-events", () => ({
  listenLiveFrames: (listener: { screens?: boolean; onFrame: (frame: unknown) => void }) => {
    frames.listeners.push(listener);
    return () => { frames.stopped += 1; frames.listeners.splice(frames.listeners.indexOf(listener), 1); };
  },
}));

const { browserSnapshot, forgetBrowserSnapshots, noteBrowserFrame, watchBrowserSnapshots } = await import("./browser-snapshots");

const screen = (png: string, extra: Partial<Extract<ServerFrame, { kind: "screen" }>> = {}): ServerFrame =>
  ({ kind: "screen", botId: "b1", threadId: "t1", png, surface: "browser", ...extra });

afterEach(() => { forgetBrowserSnapshots(); frames.listeners.length = 0; frames.stopped = 0; });

describe("browser snapshots", () => {
  it("asks for screen frames only while a card watches, and keeps the newest page for that stretch", () => {
    expect(frames.listeners).toHaveLength(0);
    const stop = watchBrowserSnapshots("b1", "t1", "s1");
    expect(frames.listeners).toHaveLength(1);
    expect(frames.listeners[0]!.screens).toBe(true);
    frames.listeners[0]!.onFrame(screen("AAAA"));
    frames.listeners[0]!.onFrame(screen("BBBB", { mime: "image/jpeg" }));
    expect(browserSnapshot("s1")?.src).toBe("data:image/jpeg;base64,BBBB");
    stop();
    stop();
    expect(frames.stopped).toBe(1);
    expect(browserSnapshot("s1")?.src).toBe("data:image/jpeg;base64,BBBB");
  });

  it("takes only the built-in browser's frames of the watched conversation", () => {
    const stop = watchBrowserSnapshots("b1", "t1", "s1");
    noteBrowserFrame(screen("COMPUTER", { surface: "computer" }));
    noteBrowserFrame(screen("NOSURFACE", { surface: undefined }));
    noteBrowserFrame(screen("OTHERBOT", { botId: "b2" }));
    noteBrowserFrame(screen("OTHERTHREAD", { threadId: "t2" }));
    noteBrowserFrame(screen(""));
    expect(browserSnapshot("s1")).toBeNull();
    noteBrowserFrame(screen("PAGE"), 42);
    expect(browserSnapshot("s1")).toEqual({ src: "data:image/png;base64,PAGE", at: 42 });
    stop();
  });

  it("gives a frame to the newest stretch of a conversation and leaves the earlier one its last page", () => {
    const first = watchBrowserSnapshots("b1", "t1", "s1");
    noteBrowserFrame(screen("ONE"));
    const second = watchBrowserSnapshots("b1", "t1", "s2");
    noteBrowserFrame(screen("TWO"));
    expect(browserSnapshot("s1")?.src).toContain("ONE");
    expect(browserSnapshot("s2")?.src).toContain("TWO");
    first();
    second();
    noteBrowserFrame(screen("LATE"));
    expect(browserSnapshot("s2")?.src).toContain("TWO");
  });

  it("keeps a few pages in memory and drops the oldest", () => {
    const stops = Array.from({ length: 10 }, (_, index) => {
      const stop = watchBrowserSnapshots("b1", `t${index}`, `s${index}`);
      noteBrowserFrame(screen(`P${index}`, { threadId: `t${index}` }));
      return stop;
    });
    expect(browserSnapshot("s0")).toBeNull();
    expect(browserSnapshot("s1")).toBeNull();
    expect(browserSnapshot("s2")?.src).toContain("P2");
    expect(browserSnapshot("s9")?.src).toContain("P9");
    for (const stop of stops) stop();
    expect(frames.listeners).toHaveLength(0);
  });
});
