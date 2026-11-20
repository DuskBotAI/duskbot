import { describe, expect, it } from "vitest";
import { ChatRepeatGuard, STUB_MIN_CHARS } from "./chat-repeat-guard.ts";

const failed = { ok: false, text: "ENOENT" };

describe("ChatRepeatGuard", () => {
  it("refuses a call after three identical failures, then stops at the second refusal", () => {
    const guard = new ChatRepeatGuard();
    expect(guard.noteAfter("read", "{}", failed)).toBeUndefined();
    expect(guard.refuses("read", "{}")).toBeNull();
    expect(guard.noteAfter("read", "{}", failed)).toBeUndefined();
    expect(guard.noteAfter("read", "{}", failed)).toContain("will not run again");
    expect(guard.refuses("read", "{}")).toContain("was not run");
    expect(guard.stopped).toBeNull();
    expect(guard.refuses("read", "{}")).toContain("was not run");
    expect(guard.stopped).toContain("read");
  });

  it("treats other inputs and other failures as progress", () => {
    const guard = new ChatRepeatGuard();
    for (const text of ["a", "b", "c", "d"]) guard.noteAfter("read", "{}", { ok: false, text });
    expect(guard.refuses("read", "{}")).toBeNull();
    for (let i = 0; i < 3; i++) guard.noteAfter("read", '{"p":1}', failed);
    expect(guard.refuses("read", '{"p":2}')).toBeNull();
    expect(guard.refuses("read", '{"p":1}')).not.toBeNull();
  });

  it("starts the count over when the call works", () => {
    const guard = new ChatRepeatGuard();
    guard.noteAfter("read", "{}", failed);
    guard.noteAfter("read", "{}", failed);
    guard.noteAfter("read", "{}", { ok: true, text: "fine" });
    guard.noteAfter("read", "{}", failed);
    expect(guard.refuses("read", "{}")).toBeNull();
  });

  it("sees the same call in another key order", () => {
    const guard = new ChatRepeatGuard();
    for (let i = 0; i < 3; i++) guard.noteAfter("read", '{"a":1,"b":2}', failed);
    expect(guard.refuses("read", '{"b":2,"a":1}')).not.toBeNull();
  });

  it("notes a repeated answer at three and stops at ten, even taking turns with another call", () => {
    const guard = new ChatRepeatGuard();
    const same = { ok: true, text: "still running" };
    const notes: Array<string | undefined> = [];
    for (let i = 0; i < 9; i++) {
      notes.push(guard.noteAfter("status", "{}", same));
      guard.noteAfter("other", `{"i":${i}}`, { ok: true, text: String(i) });
    }
    expect(notes[1]).toBeUndefined();
    expect(notes[2]).toContain("3 times");
    expect(guard.stopped).toBeNull();
    guard.noteAfter("status", "{}", same);
    expect(guard.stopped).toContain("status");
  });

  it("never counts a screenshot as the same answer", () => {
    const guard = new ChatRepeatGuard();
    for (let i = 0; i < 20; i++) expect(guard.noteAfter("shot", "{}", { ok: true, text: "ok", images: [{}] })).toBeUndefined();
    expect(guard.stopped).toBeNull();
  });

  it("a changed answer starts over", () => {
    const guard = new ChatRepeatGuard();
    guard.noteAfter("status", "{}", { ok: true, text: "a" });
    guard.noteAfter("status", "{}", { ok: true, text: "a" });
    guard.noteAfter("status", "{}", { ok: true, text: "b" });
    expect(guard.noteAfter("status", "{}", { ok: true, text: "b" })).toBeUndefined();
  });

  it("says to change approach on the third identical call in a row", () => {
    const guard = new ChatRepeatGuard({ stops: false });
    const same = { ok: true, text: "3 results" };
    expect(guard.noteAfter("search", '{"q":"a"}', same)).toBeUndefined();
    expect(guard.noteAfter("search", '{"q":"a"}', same)).toBeUndefined();
    expect(guard.noteAfter("search", '{"q":"a"}', same)).toContain("third identical call to search in a row");
    expect(guard.noteAfter("search", '{"q":"a"}', same)).toContain("fourth");
  });

  it("notes an A/B cycle with the same results, and a cycle of up to four calls, once per two laps", () => {
    const guard = new ChatRepeatGuard({ stops: false });
    const run = (name: string) => guard.noteAfter(name, "{}", { ok: true, text: `${name} page` });
    expect([run("a"), run("b"), run("a")]).toEqual([undefined, undefined, undefined]);
    expect(run("b")).toContain("repeated the same 2 calls twice");
    expect(run("a")).toContain("same result 3 times");
    const cycle = new ChatRepeatGuard({ stops: false });
    const notes = ["a", "b", "c", "d", "a", "b", "c", "d"].map((name) => cycle.noteAfter(name, "{}", { ok: true, text: name }));
    expect(notes.slice(0, 7).every((note) => note === undefined)).toBe(true);
    expect(notes[7]).toContain("same 4 calls twice");
  });

  it("does not call a cycle progress made in between, or changed results", () => {
    const guard = new ChatRepeatGuard({ stops: false });
    let page = 0;
    const notes = ["a", "b", "a", "b"].map((name) => guard.noteAfter(name, "{}", { ok: true, text: name === "b" ? `page ${page++}` : "a" }));
    expect(notes.every((note) => note === undefined)).toBe(true);
  });

  it("without stops, never refuses a call or ends the turn", () => {
    const guard = new ChatRepeatGuard({ stops: false });
    for (let i = 0; i < 12; i++) {
      guard.noteAfter("read", "{}", failed);
      guard.noteAfter("status", "{}", { ok: true, text: "same" });
      expect(guard.refuses("read", "{}")).toBeNull();
    }
    expect(guard.stopped).toBeNull();
  });

  it("points a long answer repeated word for word at the first call that got it", () => {
    const guard = new ChatRepeatGuard({ stops: false });
    const long = { ok: true, text: "x".repeat(STUB_MIN_CHARS) };
    expect(guard.sameAnswerAs("read", '{"p":1}', long, "call-1")).toBeUndefined();
    expect(guard.sameAnswerAs("read", '{"p":1}', long, "call-2")).toBe("call-1");
    expect(guard.sameAnswerAs("read", '{"p":1}', long, "call-3")).toBe("call-1");
    expect(guard.sameAnswerAs("read", '{"p":2}', long, "call-4")).toBeUndefined();
    expect(guard.sameAnswerAs("read", '{"p":1}', { ok: true, text: "short" }, "call-5")).toBeUndefined();
    expect(guard.sameAnswerAs("read", '{"p":1}', { ...long, images: [{}] }, "call-6")).toBeUndefined();
    expect(guard.sameAnswerAs("read", '{"p":1}', { ...long, ok: false }, "call-7")).toBeUndefined();
  });
});
