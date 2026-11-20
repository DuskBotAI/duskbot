import { describe, expect, it, vi } from "vitest";

import { createRoomEarlier, ROOM_EARLIER_BATCH, summaryChunks } from "./room-earlier.ts";
import type { EarlierLine } from "./room-transcript.ts";

const lines = (count: number): EarlierLine[] =>
  Array.from({ length: count }, (_, n) => ({ id: `m${n}`, text: `${n % 2 ? "Ben" : "Sam"}: line ${n}`, person: n % 2 === 0 }));
const input = (all: EarlierLine[]) => ({ ids: all.map((line) => line.id), lines: (from: number) => all.slice(from) });

describe("room summary of what fell out of the window", () => {
  it("is nothing while the whole room fits", async () => {
    const writer = vi.fn();
    const earlier = createRoomEarlier({ writer: () => writer });
    expect(await earlier.prompt("t", "b", input([]))).toBe("");
    expect(writer).not.toHaveBeenCalled();
  });

  it("waits for a room's first summary, then reuses it and lists only newer lines as excerpts", async () => {
    const prompts: string[] = [];
    const writer = vi.fn(async (prompt: string) => { prompts.push(prompt); return "Exact details: codename Bluebird."; });
    const earlier = createRoomEarlier({ writer: () => writer });
    const first = await earlier.prompt("t", "b", input(lines(40)));
    expect(first).toContain("codename Bluebird");
    expect(first).toContain("40 earlier messages");
    expect(first).not.toContain("Not in the summary yet");
    expect(prompts[0]).toContain("Sam: line 0");
    expect(prompts[0]).toContain("## Goal");
    expect(first).toContain(`## What people in the room said, word for word\n- "Sam: line 0"`);

    const second = await earlier.prompt("t", "b", input(lines(45)));
    expect(writer).toHaveBeenCalledTimes(1);
    expect(second).toContain("codename Bluebird");
    expect(second).toContain("Ben: line 41");
    expect(second.slice(second.indexOf("Not in the summary yet"))).not.toContain("Sam: line 38");
  });

  it("folds the old summary forward once enough new lines pile up, in the background", async () => {
    const writer = vi.fn(async (prompt: string) => prompt.includes("Earlier summary of this room") ? "second" : "first");
    const earlier = createRoomEarlier({ writer: () => writer });
    await earlier.prompt("t", "b", input(lines(10)));
    const stale = await earlier.prompt("t", "b", input(lines(10 + ROOM_EARLIER_BATCH)));
    expect(stale).toContain("first");
    await vi.waitFor(() => expect(writer).toHaveBeenCalledTimes(2));
    expect(String(writer.mock.calls[1]![0])).toContain("Earlier summary of this room:\\nCheckpoint written by a helper model (may be incomplete):\\nfirst");
    expect(String(writer.mock.calls[1]![0])).not.toContain("Sam: line 0\"");
    await vi.waitFor(async () => expect(await earlier.prompt("t", "b", input(lines(10 + ROOM_EARLIER_BATCH)))).toContain("second"));
  });

  it("folds a huge room in chunks, oldest first, carrying the summary from one to the next", async () => {
    const huge = Array.from({ length: 3_000 }, (_, n) => ({ id: `m${n}`, text: `Sam: ${n === 0 ? "codename Bluebird" : "status"} ${"x".repeat(60)}`, person: true }));
    const chunks = summaryChunks(huge.map((line) => ({ id: line.id, role: "user" as const, text: line.text })));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toHaveLength(3_000);
    const prompts: string[] = [];
    const writer = vi.fn(async (prompt: string) => { prompts.push(prompt); return prompts.length === 1 ? "Exact details: codename Bluebird." : `carried ${prompts.length}`; });
    const earlier = createRoomEarlier({ writer: () => writer });
    const block = await earlier.prompt("t", "b", input(huge));
    expect(writer).toHaveBeenCalledTimes(chunks.length);
    expect(prompts[0]).toContain("codename Bluebird");
    expect(prompts[1]).toContain("Earlier summary of this room:\\nCheckpoint written by a helper model (may be incomplete):\\nExact details: codename Bluebird.");
    expect(block).toContain("3000 earlier messages");
    expect(block).toContain(`carried ${chunks.length}`);
    // the opening line's words outlive every refold, whatever the helper kept
    expect(block).toContain(`- "Sam: codename Bluebird`);
  });

  it("goes on with excerpts when the room's engine has no quick model, or the summary fails", async () => {
    const none = createRoomEarlier({ writer: () => null });
    expect(await none.prompt("t", "b", input(lines(5)))).toContain("Sam: line 0");
    const log = vi.fn();
    const failing = createRoomEarlier({ writer: () => async () => { throw new Error("offline"); }, log });
    expect(await failing.prompt("t", "b", input(lines(5)))).toContain("Sam: line 4");
    expect(log).toHaveBeenCalledWith("room summary: offline");
  });
});
