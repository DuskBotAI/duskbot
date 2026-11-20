import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { announcesStep, asksToCarryOn, continueNote, createFinishGuard, finishReason, MAX_CONTINUES, MAX_PLAN_CONTINUES, planSteps, type FinishReason } from "./finish-guard.ts";

type Body = RuntimeEvent extends infer E ? E extends RuntimeEvent ? Omit<E, "eventId" | "provider" | "threadId" | "createdAt"> : never : never;
const PLAN = JSON.stringify({ todos: [{ content: "Read", status: "completed" }, { content: "Draft", status: "in_progress" }, { content: "Send", status: "pending" }] });

function harness(held = false) {
  const carried: Array<{ botId: string; threadId: string; note: string }> = [];
  const lines: FinishReason[] = [];
  let isHeld = held;
  const guard = createFinishGuard({
    botOf: (threadId) => (threadId.startsWith("room") ? null : "bot-1"),
    held: () => isHeld,
    carryOn: async (botId, threadId, note) => { carried.push({ botId, threadId, note }); },
    line: (_threadId, reason) => lines.push(reason),
    later: (run) => run(),
  });
  const send = (body: Body, threadId = "t1") => guard.onEvent({ eventId: "e", provider: "fake", threadId, createdAt: "", ...body } as RuntimeEvent);
  const turn = (text: string, opts: { plan?: string; tools?: number; tool?: string; ok?: boolean; threadId?: string; after?: string } = {}) => {
    send({ type: "turn.started" }, opts.threadId);
    if (opts.plan) send({ type: "item.started", itemType: "tool", title: "TodoWrite", input: opts.plan }, opts.threadId);
    for (let i = 0; i < (opts.tools ?? 0); i += 1) send({ type: "item.started", itemType: "tool", title: opts.tool ?? "Read" }, opts.threadId);
    send({ type: "item.completed", itemType: "assistant_text", text }, opts.threadId);
    if (opts.after) send({ type: "item.started", itemType: "tool", title: opts.after }, opts.threadId);
    send({ type: "turn.completed", ok: opts.ok ?? true }, opts.threadId);
  };
  return { carried, lines, turn, hold: (on: boolean) => { isHeld = on; } };
}

describe("finish guard", () => {
  it("reads open steps, with their words, from a plan tool's input", () => {
    expect(planSteps("TodoWrite", PLAN)).toEqual({ open: 2, total: 3, steps: ["Draft", "Send"] });
    expect(planSteps("update_plan", '{"plan":[{"step":"a","status":"completed"}]}')).toEqual({ open: 0, total: 1 });
    expect(planSteps("update_plan", '{"plan":[{"step":"Check  fares","status":"pending"}]}')).toEqual({ open: 1, total: 1, steps: ["Check fares"] });
    // a clipped input still counts its steps
    expect(planSteps("TodoWrite", PLAN.slice(0, -3))).toEqual({ open: 2, total: 3 });
    expect(planSteps("Bash", PLAN)).toBeNull();
  });

  it("names the open steps in the carry-on note and keeps the approval rule", () => {
    const note = continueNote({ kind: "plan", open: 2, total: 3, steps: ["Draft", "Send"] });
    expect(note).toContain("Still open: 1. Draft; 2. Send.");
    expect(note).toContain("still needs their yes");
  });

  it("carries an open plan on while each carry-on closes a step, and stops when one makes no progress", () => {
    const h = harness();
    h.turn("Drafted the reply.", { plan: PLAN });
    expect(h.carried).toHaveLength(1);
    expect(h.carried[0]!.note).toBe(continueNote({ kind: "plan", open: 2, total: 3, steps: ["Draft", "Send"] }));
    expect(h.lines).toEqual([{ kind: "plan", open: 2, total: 3, steps: ["Draft", "Send"] }]);
    // the same open steps again: no progress, so it stops
    h.turn("Still going.", { plan: PLAN });
    expect(h.carried).toHaveLength(1);

    h.turn("New ask from the person, half done.", { plan: PLAN });
    expect(h.carried).toHaveLength(2);
  });

  it("caps carry-ons that only announced a step lower than an open plan's", () => {
    const h = harness();
    for (let i = 0; i < MAX_CONTINUES + 1; i += 1) h.turn("Found three. Let me check their prices.", { tools: 1 });
    expect(h.carried).toHaveLength(MAX_CONTINUES);
  });

  it("follows a long plan through many steps, up to its own cap", () => {
    const h = harness();
    const steps = Array.from({ length: 10 }, (_, i) => `Step ${i + 1}`);
    const plan = (done: number) => JSON.stringify({ todos: steps.map((content, i) => ({ content, status: i < done ? "completed" : "pending" })) });
    // each turn below is a carry-on of the one before, until the guard stops carrying on
    for (let done = 1; done <= MAX_PLAN_CONTINUES + 1; done += 1) h.turn(`Did step ${done}.`, { plan: plan(done) });
    expect(h.carried).toHaveLength(MAX_PLAN_CONTINUES);
    expect(h.carried.at(-1)!.note).toContain("Still open: 1. Step 7;");
  });

  it("carries on after agreeing to a correction with no tool call, and not once it acted", () => {
    const h = harness();
    h.turn("You're right, I stopped early.");
    expect(h.carried.map((one) => one.note)).toEqual([continueNote({ kind: "ack" })]);
    const other = harness();
    other.turn("You're right. I fixed the date in the file.", { tools: 1 });
    expect(other.carried).toEqual([]);
  });

  it("leaves alone a question, a failed turn, a room, and a thread held for the person", () => {
    expect(finishReason({ text: "You're right. Want me to redo it?", tools: 0, plan: null })).toBeNull();
    const h = harness();
    h.turn("Drafted it.", { plan: PLAN, ok: false });
    h.turn("Drafted it.", { plan: PLAN, threadId: "room-1" });
    expect(h.carried).toEqual([]);
    const held = harness(true);
    held.turn("Drafted it.", { plan: PLAN });
    expect(held.carried).toEqual([]);
  });

  it("never carries on a routine's run, though the run is settled by the time its turn completes", () => {
    let routineRunning = true;
    const carried: string[] = [];
    const guard = createFinishGuard({
      botOf: () => (routineRunning ? null : "bot-1"), held: () => false,
      carryOn: async (_botId, _threadId, note) => { carried.push(note); }, line: () => {}, later: (run) => run(),
    });
    const send = (body: Body) => guard.onEvent({ eventId: "e", provider: "fake", threadId: "routine-thread", createdAt: "", ...body } as RuntimeEvent);
    send({ type: "turn.started" });
    send({ type: "item.completed", itemType: "assistant_text", text: "You're right, the report is fine." });
    routineRunning = false;
    send({ type: "turn.completed", ok: true });
    expect(carried).toEqual([]);
  });

  it("reads a step announced but not taken, and leaves waits, results and other questions alone", () => {
    for (const text of ["Let me check Amazon India's bestseller list for current prices.", "Found the three desks.\n\nNow I'll compare their warranties.", "Found three listings. Let me check their current prices.", "Okay, let me pull the review counts.", "Here are the prices:"]) expect(announcesStep(text), text).toBe(true);
    for (const text of ["I'll check again once the deploy finishes.", "Let me know if you want the long version.", "The Redragon K552 is the best pick at ₹2,289.", "Let me check: want the wired one or the wireless one?", "I'll send the link at 9.", "Let me check the prices. Done: the cheapest is 1,599.", "Sources:"]) expect(announcesStep(text), text).toBe(false);
  });

  it("reads a last line that only asks whether to carry on, but never one about sending, buying or deleting", () => {
    for (const text of ["Slides 1 to 3 are done.\n\nShall I continue with the rest?", "Want me to keep going?", "Continue?"]) expect(asksToCarryOn(text), text).toBe(true);
    for (const text of ["Want me to continue and send it to the team?", "Should I proceed with booking the 08:10 train?", "Which subject line should go out?", "Shall I continue? Here is more text after."]) expect(asksToCarryOn(text), text).toBe(false);
  });

  it("carries on a turn that announced a step or asked to go on mid-work, with a note that grants nothing", () => {
    const h = harness();
    h.turn("Let me check Amazon India's bestseller list.", { tools: 2 });
    expect(h.lines).toEqual([{ kind: "next" }]);
    expect(h.carried[0]!.note).toBe(continueNote({ kind: "next" }));
    expect(continueNote({ kind: "next" })).toContain("still needs their yes");
    const asked = harness();
    asked.turn("Three of five suppliers checked. Shall I continue?", { tools: 4 });
    expect(asked.lines).toEqual([{ kind: "next" }]);
  });

  it("does not carry on a question asked before any work, the soul's own ask-first, or words a tool already answered", () => {
    expect(finishReason({ text: "Want me to continue?", tools: 0, plan: null })).toBeNull();
    const h = harness();
    h.turn("Pick one:", { tools: 1, after: "show_widget" });
    h.turn("Let me pull the prices.", { tools: 1, after: "WebSearch" });
    expect(h.carried).toEqual([]);
  });

  it("stops carrying on when a carry-on only announces again without running a tool", () => {
    const h = harness();
    h.turn("Let me check the prices.");
    expect(h.carried).toHaveLength(1);
    h.turn("Let me check the prices.");
    expect(h.carried).toHaveLength(1);
  });

  it("carries on a promise of later work that nothing set up, and an open checklist after work ran", () => {
    const h = harness();
    h.turn("The fare is $420. I'll let you know when it drops.");
    expect(h.carried).toHaveLength(1);
    expect(h.carried[0]!.note).toContain("promises to do something later");
    expect(h.lines.at(-1)).toEqual({ kind: "promise" });

    const c = harness();
    c.turn("- [x] Saved the receipt\n- [ ] Save the invoice", { tools: 1 });
    expect(c.carried).toHaveLength(0);
    c.turn("- [x] Saved the receipt\n- [ ] Save the invoice", { tools: 1, tool: "Write" });
    expect(c.carried).toHaveLength(1);
    expect(c.carried[0]!.note).toContain("Save the invoice");
    const w = harness();
    w.turn("I'll let you know when it drops.", { tools: 1, tool: "mcp__agents__wait_until" });
    expect(w.carried).toHaveLength(0);
    expect(finishReason({ text: "- [x] Saved the receipt\n- [ ] Save the invoice", tools: 1, plan: null, effectful: 1 })).toEqual({ kind: "checklist", items: ["Save the invoice"] });
  });

  it("leaves a promise alone once a wait or trigger was set up, or when the engine's loop already sent it back", () => {
    expect(finishReason({ text: "I'll let you know when it drops.", tools: 1, plan: null, scheduled: true })).toBeNull();
    expect(finishReason({ text: "I'll let you know when it drops. All set.", tools: 0, plan: null, gated: ["follow_up"] })).toBeNull();
    expect(finishReason({ text: "- [x] a\n- [ ] b", tools: 1, plan: null, effectful: 1, gated: ["checklist"] })).toBeNull();
  });
});

describe("finish guard: open asks and done claims", () => {
  function withAsks(open: string[]) {
    const carried: string[] = [];
    const lines: FinishReason[] = [];
    let nudged = false;
    const settled: Array<{ said: readonly string[]; scheduled: boolean; handedOff: boolean }> = [];
    const guard = createFinishGuard({
      botOf: () => "bot-1", held: () => false, later: (run) => run(),
      carryOn: async (_botId, _threadId, note) => { carried.push(note); },
      line: (_threadId, reason) => lines.push(reason),
      asks: { settle: (_threadId, turn) => { settled.push(turn); return nudged ? [] : open; }, nudged: () => { nudged = true; } },
    });
    const send = (body: Body) => guard.onEvent({ eventId: "e", provider: "fake", threadId: "t1", createdAt: "", ...body } as RuntimeEvent);
    const turn = (text: string, tools: string[] = [], stopGates?: string[]) => {
      send({ type: "turn.started" });
      for (const title of tools) send({ type: "item.started", itemType: "tool", title });
      send({ type: "item.completed", itemType: "assistant_text", text });
      send({ type: "turn.completed", ok: true, ...(stopGates ? { stopGates } : {}) });
    };
    return { carried, lines, settled, turn, send };
  }

  it("sends a turn back once, with no line for the person, for an ask it left open", () => {
    const h = withAsks(["what's the weather in mumbai in july"]);
    h.turn("Here is your packing list: shirts, charger, umbrella.");
    expect(h.carried).toEqual([continueNote({ kind: "asks", items: ["what's the weather in mumbai in july"] })]);
    expect(h.lines).toEqual([]);
    h.turn("Still only the list.");
    expect(h.carried).toHaveLength(1);
  });

  it("hands the ledger what the turn said and set up, and leaves a question to the person alone", () => {
    const h = withAsks(["the caption"]);
    h.turn("Which tone do you want for the caption?", ["mcp__agents__wait_until", "mcp__agents__start_thread"]);
    expect(h.settled[0]).toEqual({ said: ["Which tone do you want for the caption?"], scheduled: true, handedOff: true });
    expect(h.carried).toEqual([]);
  });

  it("skips asks the chat loop already sent back for", () => {
    const h = withAsks(["the caption"]);
    h.turn("Here's the list.", [], ["open_items"]);
    expect(h.carried).toEqual([]);
  });

  it("sends back a done claim after an app change no lookup followed, not after a read-back or a file edit", () => {
    expect(finishReason({ text: "Done, the row is updated.", tools: 1, plan: null, unread: "mcp__sheets__update_row" })).toEqual({ kind: "unread", tool: "mcp__sheets__update_row" });
    expect(finishReason({ text: "Drafted it for you.", tools: 1, plan: null, unread: "mcp__sheets__update_row" })).toBeNull();
    const h = withAsks([]);
    h.turn("Done, the row is updated.", ["mcp__sheets__update_row"]);
    expect(h.carried).toHaveLength(1);
    expect(h.carried[0]).toContain("changed something");
    const read = withAsks([]);
    read.turn("Done, the row is updated.", ["mcp__sheets__update_row", "mcp__sheets__get_row"]);
    const file = withAsks([]);
    file.turn("Done, the config is updated.", ["Edit"]);
    expect([...read.carried, ...file.carried]).toEqual([]);
  });
});
