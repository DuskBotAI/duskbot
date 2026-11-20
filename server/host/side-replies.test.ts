import { describe, expect, it, vi } from "vitest";

import type { RuntimeEvent, SteerOutcome } from "../contracts.ts";
import type { Checklist } from "../batch-checklist.ts";
import { toolStep } from "../step-summary.ts";
import { parseSideDecision, sideReplyPrompt } from "../side-reply-prompt.ts";
import { createSideReplies, recentLines, repliesWhileWorking, runningAsk, type SideRequest, type SideRow, type SideSendFacts, type SideWriter } from "./side-replies.ts";

const THREAD = "th1";
const TURN = "turn-1";
const BOT = "bot1";

function event(fields: Record<string, unknown>): RuntimeEvent {
  return { eventId: `e${Math.random()}`, provider: "claudeAgent", threadId: THREAD, turnId: TURN, createdAt: new Date().toISOString(), ...fields } as RuntimeEvent;
}
const toolStart = (title: string, input: unknown, id = title) =>
  event({ type: "item.started", itemType: "tool", itemId: id, title, input: JSON.stringify(input), step: toolStep({ title, input: JSON.stringify(input) }) });

const decision = (kind: string, reply: string) => JSON.stringify({ kind, reply });
const said = (text: string) => event({ type: "item.completed", itemType: "assistant_text", itemId: `t${Math.random()}`, text });

/** A fake engine turn: running until stopped or completed, taking steers only while `steers` is on. */
function setup(options: { reply?: string | (() => Promise<string>); steers?: boolean; steerOutcome?: SteerOutcome; writer?: boolean; checklist?: Checklist | null; timeoutMs?: number; pauses?: boolean; fresh?: boolean; now?: () => number } = {}) {
  const turn = { running: true, steered: [] as string[], queued: [] as string[], stopped: 0, redirected: [] as string[], paused: [] as string[] };
  const posts: string[] = [];
  const prompts: string[] = [];
  const fallbacks: string[] = [];
  const rows: SideRow[] = [
    { id: "m1", role: "user", kind: "text", text: "find me the three cheapest flights to Goa next week" },
    { id: "m2", role: "bot", kind: "text", text: "On it, comparing fares now." },
  ];
  const writer: SideWriter = vi.fn(async (prompt: string) => {
    prompts.push(prompt);
    const reply = options.reply ?? decision("answer", "Yes, I'm doing this myself. I'm comparing fares right now.");
    return typeof reply === "string" ? reply : reply();
  });
  const replies = createSideReplies<SideRequest>({
    writer: () => (options.writer === false ? null : writer),
    bot: () => ({ name: "Pepper", soul: "A travel helper." }),
    transcript: () => rows,
    checklist: () => options.checklist ?? null,
    busy: () => turn.running,
    canSteer: () => turn.running && options.steers !== false,
    steer: async (_request, prompt) => {
      const outcome = options.steerOutcome ?? "steered";
      if (outcome !== "refused") turn.steered.push(prompt);
      return outcome;
    },
    queueNext: (_request, prompt) => { turn.queued.push(prompt); },
    stop: async () => { turn.stopped++; turn.running = false; },
    redirect: async (_request, prompt) => { turn.redirected.push(prompt); turn.running = false; },
    post: (_threadId, text) => { posts.push(text); },
    fallback: async (request) => { fallbacks.push(request.text); },
    ...(options.pauses ? { pause: async (_request: SideRequest, prompt: string) => { turn.paused.push(prompt); turn.running = false; } } : {}),
    timeoutMs: options.timeoutMs,
    ...(options.now ? { now: options.now } : {}),
  });
  // a turn that has already said something, unless the test is about one that just started
  if (!options.fresh) {
    replies.onEvent(event({ type: "turn.started" }));
    replies.onEvent(said("On it, comparing fares now."));
  }
  let n = 0;
  const send = (text: string) => {
    const id = `p${++n}`;
    rows.push({ id, role: "user", kind: "text", text, steered: true });
    return replies.handle({ botId: BOT, threadId: THREAD, messageId: id, text, prompt: `Person: ${text}` });
  };
  return { replies, turn, posts, prompts, fallbacks, send, writer, rows };
}

describe("side reply decisions", () => {
  it("reads one JSON decision, fenced or not, and nothing else", () => {
    expect(parseSideDecision('{"kind":"answer","reply":"Yes, myself."}')).toEqual({ kind: "answer", reply: "Yes, myself." });
    expect(parseSideDecision('```json\n{"kind":"steer","reply":"Got it, only direct flights."}\n```')).toEqual({ kind: "steer", reply: "Got it, only direct flights." });
    expect(parseSideDecision('Sure! {"kind":"stop","reply":"Stopping now."}')).toEqual({ kind: "stop", reply: "Stopping now." });
    expect(parseSideDecision('{"kind":"pause","reply":"ok"}')).toBeNull();
    expect(parseSideDecision('{"kind":"answer","reply":"  "}')).toBeNull();
    expect(parseSideDecision("Yes, I am doing it myself.")).toBeNull();
    expect(parseSideDecision(`{"kind":"answer","reply":"${"x".repeat(2_000)}"}`)).toBeNull();
  });

  it("gives the responder the task, its live progress, the conversation and the new message", async () => {
    const { replies, prompts, send } = setup({ checklist: { title: "Fares", verb: "check", items: [{ text: "IndiGo", state: "done" }, { text: "Air India", state: "open" }, { text: "Vistara", state: "open" }] } });
    replies.onEvent(event({ type: "turn.started" }));
    replies.onEvent(toolStart("WebSearch", { query: "Delhi to Goa flights next week" }));
    replies.onEvent(event({ type: "turn.progress", activity: "tool", tool: "set_status", label: "Comparing Goa fares" }));
    await send("are you doing this yourself?");
    const prompt = prompts[0]!;
    expect(prompt).toContain("find me the three cheapest flights to Goa next week");
    expect(prompt).toContain("Right now: Comparing Goa fares.");
    expect(prompt).toMatch(/Steps so far[^\n]*\n- [^\n]*Goa flights/);
    expect(prompt).toContain('Checklist "Fares": 1 of 3 done, next: Air India.');
    expect(prompt).toContain("Pepper: On it, comparing fares now.");
    expect(prompt).toContain("<<<\nare you doing this yourself?\n>>>");
    expect(prompt).toContain("It reaches the work right away.");
    expect(prompt).not.toContain("Person: are you doing this yourself?");
  });

  it("tells the responder a note waits for the current step when the engine cannot take one now", () => {
    const prompt = sideReplyPrompt({ name: "Pepper", task: { ask: "x", minutes: 2, steps: [], said: [] }, recent: [], message: "only direct flights", notesNow: false });
    expect(prompt).toContain("as soon as the current step finishes");
  });

  it("reads the running ask and the recent lines around the new message", () => {
    const rows: SideRow[] = [
      { id: "a", role: "user", kind: "text", text: "first ask" },
      { id: "b", role: "bot", kind: "activity" },
      { id: "c", role: "user", kind: "text", text: "earlier aside", steered: true },
      { id: "d", role: "user", kind: "text", text: "new", steered: true },
    ];
    expect(runningAsk(rows, "d")).toBe("first ask");
    expect(recentLines(rows, "d")).toEqual([{ who: "person", text: "first ask" }, { who: "person", text: "earlier aside" }]);
  });
});

describe("side reply routing", () => {
  it("answers a question and leaves the running turn untouched", async () => {
    const { turn, posts, send, fallbacks } = setup();
    expect(await send("are you doing this yourself?")).toBe("answered");
    expect(posts).toEqual(["Yes, I'm doing this myself. I'm comparing fares right now."]);
    expect(turn).toMatchObject({ running: true, steered: [], queued: [], stopped: 0, redirected: [] });
    expect(fallbacks).toEqual([]);
  });

  it("acknowledges a steer and passes it into the running turn without restarting it", async () => {
    const { turn, posts, send } = setup({ reply: decision("steer", "Got it, I'll stick to direct flights.") });
    expect(await send("only direct flights please")).toBe("steered");
    expect(turn.running).toBe(true);
    expect(turn.stopped).toBe(0);
    expect(turn.steered).toHaveLength(1);
    expect(turn.steered[0]).toContain("Person: only direct flights please");
    expect(turn.steered[0]).toContain("do not reply to it on its own");
    expect(turn.queued).toEqual([]);
    expect(posts).toEqual(["Got it, I'll stick to direct flights."]);
  });

  it("queues a steer first for the continuation when the engine cannot take it mid-turn", async () => {
    const { turn, posts, send } = setup({ steers: false, reply: decision("steer", "Noted, I'll use that once this step is done.") });
    expect(await send("only direct flights please")).toBe("queued");
    expect(turn.running).toBe(true);
    expect(turn.steered).toEqual([]);
    expect(turn.queued).toHaveLength(1);
    expect(turn.queued[0]).toContain("Person: only direct flights please");
    expect(turn.queued[0]).toContain("Take it into the task you were working on");
    expect(posts).toEqual(["Noted, I'll use that once this step is done."]);
  });

  it("queues a steer the ending turn refused", async () => {
    const { turn, send } = setup({ steerOutcome: "refused", reply: decision("steer", "Got it.") });
    expect(await send("only direct flights")).toBe("queued");
    expect(turn.queued).toHaveLength(1);
  });

  it("queues a steer for the next turn when the turn ended before the reply came", async () => {
    let finish!: (value: string) => void;
    const { turn, send } = setup({ reply: () => new Promise((resolve) => { finish = resolve; }) });
    const pending = send("only direct flights");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    turn.running = false;
    finish(decision("steer", "Got it."));
    expect(await pending).toBe("queued");
    expect(turn.steered).toEqual([]);
    expect(turn.queued).toHaveLength(1);
  });

  it("stops the task through the person's own stop", async () => {
    const { turn, posts, send } = setup({ reply: decision("stop", "Okay, I've stopped.") });
    expect(await send("actually forget it, don't bother")).toBe("stopped");
    expect(turn.stopped).toBe(1);
    expect(turn.running).toBe(false);
    expect(posts).toEqual(["Okay, I've stopped."]);
  });

  it("does not stop a turn that already ended", async () => {
    const { turn, send } = setup({ reply: decision("stop", "Okay.") });
    turn.running = false;
    expect(await send("never mind")).toBe("stopped");
    expect(turn.stopped).toBe(0);
  });

  it("takes a separate new ask on beside the running task, which keeps going", async () => {
    const { turn, posts, send } = setup({ reply: decision("task", "Sure, I'll find a hotel in Panjim too while the flights search runs.") });
    expect(await send("also find me a hotel in Panjim for those dates")).toBe("added");
    expect(turn).toMatchObject({ running: true, stopped: 0, redirected: [], queued: [] });
    expect(turn.steered).toHaveLength(1);
    expect(turn.steered[0]).toContain("Person: also find me a hotel in Panjim for those dates");
    expect(turn.steered[0]).toContain("separate new task");
    expect(turn.steered[0]).toContain("which ask it finishes");
    expect(posts).toEqual(["Sure, I'll find a hotel in Panjim too while the flights search runs."]);
  });

  it("queues a separate ask first for the next turn when the engine cannot take it now, saying it starts after", async () => {
    const { turn, send, prompts } = setup({ steers: false, reply: decision("task", "Sure, I'll make the deck as soon as the flights are done.") });
    expect(await send("and make me a 3 slide deck about our pet food brand")).toBe("added-next");
    expect(turn.steered).toEqual([]);
    expect(turn.queued).toHaveLength(1);
    expect(turn.queued[0]).toContain("separate task");
    expect(turn.running).toBe(true);
    expect(prompts[0]).toContain("It starts as soon as the task in progress is done");
  });

  it("tells the next responder which separate asks the task has taken on, so a third ask or a question sees both", async () => {
    let calls = 0;
    const { replies, send, prompts, turn } = setup({ reply: async () => (++calls === 1 ? decision("task", "Sure, hotels too.") : decision("answer", "Both are still running.")) });
    replies.onEvent(event({ type: "turn.started" }));
    replies.onEvent(said("On it."));
    expect(await send("also find me a hotel in Panjim")).toBe("added");
    expect(await send("how is it going?")).toBe("answered");
    expect(prompts[1]).toContain("Also asked during this task, being done alongside it:\n- also find me a hotel in Panjim");
    expect(prompts[0]).not.toContain("Also asked during this task");
    expect(prompts[0]).toContain("You do it alongside the task in progress");
    expect(turn.running).toBe(true);
  });

  it("never lets a new request read as a question, nor as a redirect unless the task is dropped", () => {
    const prompt = sideReplyPrompt({ name: "Pepper", task: { ask: "x", minutes: 2, steps: [], said: [] }, recent: [], message: "what's the weather in Goa?", notesNow: true });
    expect(prompt).toContain("Never pick answer for a request to find, make, check or do something, or for a question about something outside this task that needs looking up");
    expect(prompt).toContain("A new request that does not drop the task is task, not redirect.");
    expect(parseSideDecision('{"kind":"task","reply":"Sure, on it alongside."}')).toEqual({ kind: "task", reply: "Sure, on it alongside." });
  });

  it("pauses a turn whose engine cannot take input mid-turn so a correction reaches the work now, not after the task", async () => {
    const { turn, posts, send, prompts } = setup({ steers: false, pauses: true, reply: decision("steer", "Got it, direct flights only.") });
    expect(await send("only direct flights please")).toBe("paused");
    expect(turn.paused).toHaveLength(1);
    expect(turn.paused[0]).toContain("Person: only direct flights please");
    expect(turn.paused[0]).toContain("carry on with what is left of it");
    expect(turn.queued).toEqual([]);
    expect(posts).toEqual(["Got it, direct flights only."]);
    expect(prompts[0]).toContain("It reaches the work right away.");
  });

  it("pauses such a turn for a separate ask too, so both are worked on now", async () => {
    const { turn, send, prompts } = setup({ steers: false, pauses: true, reply: decision("task", "Sure, hotels too, alongside the flights.") });
    expect(await send("also find me a hotel in Panjim")).toBe("paused");
    expect(turn.paused[0]).toContain("separate task");
    expect(prompts[0]).toContain("You do it alongside the task in progress");
  });

  it("folds a burst into the turn it just started: no quick reply and no responder call, one answer for both", async () => {
    const { turn, posts, send, writer } = setup({ fresh: true });
    expect(await send("find me cheap flights to Goa")).toBe("folded");
    expect(writer).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
    expect(turn.steered).toHaveLength(1);
    expect(turn.steered[0]).toContain("Person: find me cheap flights to Goa");
    expect(turn.steered[0]).toContain("right after their message before it, \"find me the three cheapest flights to Goa next week\"");
    expect(turn.steered[0]).toContain("answer them together, once");
  });

  it("folds a burst on an engine that cannot steer by pausing the silent turn and running both together", async () => {
    const { turn, posts, send } = setup({ fresh: true, steers: false, pauses: true });
    expect(await send("find me cheap flights to Goa")).toBe("folded");
    expect(posts).toEqual([]);
    expect(turn.paused).toHaveLength(1);
    expect(turn.paused[0]).toContain("answer them together, once");
  });

  it("does not fold into a turn that has worked a while, even a silent one", async () => {
    let at = 1_000_000;
    const { replies, send, writer } = setup({ fresh: true, now: () => at });
    replies.onEvent(event({ type: "turn.started" }));
    at += 31_000;
    expect(await send("are you doing this yourself?")).toBe("answered");
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("does not fold into a turn that has started a step", async () => {
    const { replies, send } = setup({ fresh: true });
    replies.onEvent(event({ type: "turn.started" }));
    replies.onEvent(toolStart("WebSearch", { query: "Goa flights" }));
    expect(await send("are you doing this yourself?")).toBe("answered");
  });

  it("redirects: queues the new ask first and stops the running turn", async () => {
    const { turn, posts, send } = setup({ reply: decision("redirect", "Sure, switching to trains instead.") });
    expect(await send("drop the flights, look at trains instead")).toBe("redirected");
    expect(turn.redirected).toHaveLength(1);
    expect(turn.redirected[0]).toContain("Person: drop the flights, look at trains instead");
    expect(turn.redirected[0]).toContain("so that task was stopped");
    expect(posts).toEqual(["Sure, switching to trains instead."]);
  });

  it("takes the old path when the responder fails, times out or answers nonsense", async () => {
    const failing = setup({ reply: () => Promise.reject(new Error("boom")) });
    expect(await failing.send("hi?")).toBe("fallback");
    expect(failing.fallbacks).toEqual(["hi?"]);
    expect(failing.posts).toEqual([]);

    const slow = setup({ reply: () => new Promise(() => {}), timeoutMs: 20 });
    expect(await slow.send("hi?")).toBe("fallback");
    expect(slow.posts).toEqual([]);

    const nonsense = setup({ reply: "Sure thing" });
    expect(await nonsense.send("hi?")).toBe("fallback");
    expect(nonsense.turn).toMatchObject({ running: true, steered: [], queued: [], stopped: 0 });
  });

  it("takes the old path when nobody can write a quick reply", async () => {
    const { replies, send, fallbacks, writer } = setup({ writer: false });
    expect(replies.available(BOT, THREAD)).toBe(false);
    expect(await send("hi?")).toBe("fallback");
    expect(fallbacks).toEqual(["hi?"]);
    expect(writer).not.toHaveBeenCalled();
  });

  it("handles a thread's messages in the order they came", async () => {
    const order: string[] = [];
    let first = true;
    const { send, posts } = setup({
      reply: async () => {
        if (first) { first = false; await new Promise((resolve) => setTimeout(resolve, 30)); order.push("q"); return decision("answer", "Still on it."); }
        order.push("stop");
        return decision("stop", "Stopped.");
      },
    });
    await Promise.all([send("how is it going?"), send("ok stop")]);
    expect(order).toEqual(["q", "stop"]);
    expect(posts).toEqual(["Still on it.", "Stopped."]);
  });

  it("writes one reply per message, and nothing more when the main turn finishes", async () => {
    const { replies, posts, send, turn } = setup();
    replies.onEvent(event({ type: "turn.started" }));
    replies.onEvent(said("On it."));
    await send("are you doing this yourself?");
    replies.onEvent(event({ type: "item.completed", itemType: "assistant_text", text: "Here are the three cheapest flights." }));
    replies.onEvent(event({ type: "turn.completed", ok: true }));
    turn.running = false;
    await Promise.resolve();
    expect(posts).toHaveLength(1);
    expect(turn.steered).toEqual([]);
    expect(turn.queued).toEqual([]);
  });
});

describe("who gets a quick reply", () => {
  const facts: SideSendFacts = { personsOwn: true, spoken: false, images: false, room: false, oneOnOne: true, waitingOnPerson: false, quickUpdates: true, writer: true };

  it("the person's own typed message in their one-to-one chat", () => {
    expect(repliesWhileWorking(facts)).toBe(true);
    expect(repliesWhileWorking({ ...facts, followUp: "steer" })).toBe(true);
  });

  it("never in a room: room messages keep queueing for the room's next turn", () => {
    expect(repliesWhileWorking({ ...facts, room: true })).toBe(false);
    expect(repliesWhileWorking({ ...facts, room: true, oneOnOne: false })).toBe(false);
  });

  it("never for apps, teammates, calls, images, chosen waits, open questions, quick updates off or no writer", () => {
    expect(repliesWhileWorking({ ...facts, personsOwn: false })).toBe(false);
    expect(repliesWhileWorking({ ...facts, spoken: true })).toBe(false);
    expect(repliesWhileWorking({ ...facts, images: true })).toBe(false);
    expect(repliesWhileWorking({ ...facts, followUp: "queue" })).toBe(false);
    expect(repliesWhileWorking({ ...facts, followUp: "restart" })).toBe(false);
    expect(repliesWhileWorking({ ...facts, oneOnOne: false })).toBe(false);
    expect(repliesWhileWorking({ ...facts, waitingOnPerson: true })).toBe(false);
    expect(repliesWhileWorking({ ...facts, quickUpdates: false })).toBe(false);
    expect(repliesWhileWorking({ ...facts, writer: false })).toBe(false);
  });
});
