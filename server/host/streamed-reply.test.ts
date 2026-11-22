import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../contracts.ts";
import type { Message } from "../store.ts";
import { createStreamedReply } from "./streamed-reply.ts";

const THREAD = "thread";

function fixture({ room = false, passAllowed = true, messages = [] as Partial<Message>[] } = {}) {
  const rows = messages as Message[];
  const patched: Array<{ id: string; patch: Partial<Message> }> = [];
  const replies = createStreamedReply({
    store: {
      activePath: () => rows,
      messagesFor: () => rows,
      botByThread: () => (room ? undefined : { id: "bot" }) as never,
      groupByThread: () => (room ? { id: "room" } : undefined) as never,
      patchMessage: (_threadId, id, patch) => { patched.push({ id, patch }); return null; },
    },
    directPassAllowed: () => passAllowed,
  });
  return { replies, patched };
}

const delta = (text: string, turnId = "turn") =>
  ({ type: "content.delta", streamKind: "assistant_text", delta: text, threadId: THREAD, turnId }) as RuntimeEvent;
const item = (text: string, turnId = "turn") =>
  ({ type: "item.completed", itemType: "assistant_text", text, threadId: THREAD, turnId }) as RuntimeEvent;
const shownDelta = (event: RuntimeEvent | null) => (event?.type === "content.delta" ? event.delta : event);

describe("what of a streaming reply reaches the chat", () => {
  it("passes other events and ordinary reply text through untouched", () => {
    const { replies } = fixture();
    const tool = { type: "item.completed", itemType: "tool", ok: true, threadId: THREAD } as RuntimeEvent;
    expect(replies.shown(tool, false)).toBe(tool);
    const words = delta("On it");
    expect(replies.shown(words, false)).toBe(words);
    const done = item("On it, checking.");
    expect(replies.shown(done, false)).toBe(done);
  });

  it("holds words that could still spell (pass), then shows them whole once they cannot", () => {
    const { replies } = fixture();
    expect(replies.shown(delta("("), false)).toBeNull();
    expect(shownDelta(replies.shown(delta("fyi"), false))).toBe("(fyi");
    expect(shownDelta(replies.shown(delta(") done"), false))).toBe(") done");
  });

  it("shows nothing of a one-on-one reply that is only (pass), and counts the turn as quiet", () => {
    const { replies } = fixture();
    replies.turnStarted(THREAD);
    for (const chunk of ["(", "pa", "ss)"]) expect(replies.shown(delta(chunk), false)).toBeNull();
    expect(replies.shown(item("(pass)"), false)).toBeNull();
    expect(replies.passes(THREAD, "(pass)")).toBe(true);
    expect(replies.passedQuietly(THREAD, { turnId: "turn", startedAt: 0, reply: "" })).toBe(true);
    expect(replies.passedQuietly(THREAD, { turnId: "turn", startedAt: 0, reply: "" })).toBe(false);

    expect(replies.shown(item("(pass)\n\n(pass)"), false)).toBeNull();
    expect(replies.passes(THREAD, "(pass)\n\n(pass)")).toBe(true);
    expect(replies.shown(item("Done.\n\n(pass)"), false)).toEqual(item("Done."));
  });

  it("shows (pass) where a quiet reply is not allowed, and never counts a turn that also spoke", () => {
    const refused = fixture({ passAllowed: false });
    const done = item("(pass)");
    expect(refused.replies.shown(done, false)).toBe(done);
    expect(refused.replies.passes(THREAD, "(pass)")).toBe(false);

    const spoke = fixture({ messages: [{ id: "m1", role: "bot", kind: "text", turnId: "turn", at: 5, text: "One more thing." }] });
    expect(spoke.replies.passes(THREAD, "(pass)")).toBe(true);
    expect(spoke.replies.passedQuietly(THREAD, { turnId: "turn", startedAt: 0, reply: "" })).toBe(false);

    const replied = fixture();
    expect(replied.replies.passes(THREAD, "(pass)")).toBe(true);
    replied.replies.spoke(THREAD);
    expect(replied.replies.passedQuietly(THREAD, { turnId: "turn", startedAt: 0, reply: "" })).toBe(false);
  });

  it("hides a room member's pass, bare or in parentheses", () => {
    const { replies } = fixture({ room: true });
    expect(replies.shown(item("pass"), false)).toBeNull();
    expect(replies.shown(item("(pass)"), false)).toBeNull();
    const line = item("I pass the file along.");
    expect(replies.shown(line, false)).toBe(line);
  });

  it("keeps what streamed before the person's Stop, hands it over once, and shows nothing after", () => {
    const { replies } = fixture();
    replies.turnStarted(THREAD);
    replies.shown(delta("Half an "), false);
    replies.shown(delta("answer"), false);
    expect(replies.shown(delta(" that never lands"), true)).toBeNull();
    expect(replies.shown(item("Half an answer that never lands"), true)).toBeNull();
    expect(replies.takeKept(THREAD)).toBe("Half an answer");
    expect(replies.takeKept(THREAD)).toBe("");
    expect(replies.keptAtTurnEnd(THREAD, "turn")).toBe("");
    replies.replyEnded(THREAD);
    expect(replies.keptAtTurnEnd(THREAD, "turn")).toBe("");
  });

  it("ends the kept words where the person's app had shown them", () => {
    const streaming = fixture();
    streaming.replies.shown(delta("One two three"), false);
    streaming.replies.saidAtStop(THREAD, "One two");
    expect(streaming.replies.keptAtTurnEnd(THREAD, "turn")).toBe("One two");

    const landed = fixture({ messages: [{ id: "bubble", role: "bot", kind: "text", turnId: "turn", text: "One two three" }] });
    landed.replies.saidAtStop(THREAD, "One two");
    expect(landed.replies.keptAtTurnEnd(THREAD, "turn")).toBe("");
    expect(landed.patched).toEqual([{ id: "bubble", patch: { text: "One two" } }]);
  });
});
