import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { toolStep } from "./step-summary.ts";
import {
  ACK_IDLE_MS, RETRY_BUSY_MS, beatPrompt, beatsNote, cleanBeat, createTurnBeats, looksLikeWork, MILESTONE_QUIET_MS, PLAN_MIN_MS, PLAN_WRITE_MS, type BeatKind,
} from "./turn-beats.ts";

const THREAD = "th1";
const TURN = "turn-1";

function event(fields: Record<string, unknown>): RuntimeEvent {
  return { eventId: `e${Math.random()}`, provider: "claudeAgent", threadId: THREAD, turnId: TURN, createdAt: new Date().toISOString(), ...fields } as RuntimeEvent;
}
const toolStart = (title: string, input: unknown, id = title) =>
  event({ type: "item.started", itemType: "tool", itemId: id, title, input: JSON.stringify(input), step: toolStep({ title, input: JSON.stringify(input) }) });
const toolDone = (id: string) => event({ type: "item.completed", itemType: "tool", itemId: id, ok: true });
const said = (text: string) => event({ type: "item.completed", itemType: "assistant_text", text });

function setup(options: { replies?: Partial<Record<BeatKind, string>>; enabled?: boolean; writerMs?: number; soul?: string; showsThinking?: boolean; fails?: string[] } = {}) {
  vi.useFakeTimers();
  const prompts: Array<{ kind: BeatKind; prompt: string }> = [];
  const posts: Array<{ kind: BeatKind; text: string; turnId: string }> = [];
  let live = true;
  const replies = { ack: "On it, comparing budget keyboards now.", plan: "You'll get a short list of three picks with prices. I'll check the prices are current before sending.", milestone: "Seven review sites read so far; now checking prices.", ...options.replies };
  const beats = createTurnBeats({
    enabled: () => options.enabled !== false,
    writer: () => (prompt) => {
      const kind: BeatKind = prompt.includes("Write the acknowledgement") ? "ack" : prompt.includes("Write the second message") ? "plan" : "milestone";
      prompts.push({ kind, prompt });
      const failure = options.fails?.shift();
      if (failure) return Promise.reject(new Error(failure));
      return new Promise((resolve) => setTimeout(() => resolve(replies[kind]), options.writerMs ?? 2_000));
    },
    bot: () => ({ name: "Nova", soul: options.soul ?? "You are Nova, a market researcher." }),
    ...(options.showsThinking === undefined ? {} : { showsThinking: () => options.showsThinking! }),
    live: (_threadId, turnId) => live && turnId === TURN,
    post: ({ kind, text, turnId }) => posts.push({ kind, text, turnId }),
  });
  const send = (e: RuntimeEvent) => beats.onEvent(e);
  return { beats, prompts, posts, send, stop: () => { live = false; } };
}

describe("turn beats", () => {
  afterEach(() => vi.useRealTimers());

  it("acks real work as its first tool runs, then says what they'll get, and tells the engine afterwards", async () => {
    const { beats, prompts, posts, send } = setup();
    beats.start({ botId: "b", threadId: THREAD, text: "Research the best budget mechanical keyboards in India", attachments: 0, unattended: false });
    expect(prompts.map((p) => p.kind)).toEqual(["ack"]);
    expect(prompts[0]!.prompt).toContain("You are Nova");
    send(event({ type: "turn.started" }));
    await vi.advanceTimersByTimeAsync(1_000);
    send(toolStart("WebSearch", { query: "budget mechanical keyboards India" }, "s1"));
    await vi.advanceTimersByTimeAsync(900);
    expect(posts).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(posts).toEqual([{ kind: "ack", text: "On it, comparing budget keyboards now.", turnId: TURN }]);
    send(toolDone("s1"));
    send(toolStart("WebFetch", { url: "https://www.rtings.com/keyboard" }, "f1"));
    await vi.advanceTimersByTimeAsync(PLAN_WRITE_MS - 2_100);
    expect(prompts.map((p) => p.kind)).toEqual(["ack", "plan"]);
    expect(prompts[1]!.prompt).toContain("- Searching for budget mechanical keyboards");
    expect(prompts[1]!.prompt).toContain("- Reading rtings.com");
    expect(prompts[1]!.prompt).toContain("On it, comparing budget keyboards now.");
    await vi.advanceTimersByTimeAsync(PLAN_MIN_MS - PLAN_WRITE_MS + 300);
    expect(posts.map((p) => p.kind)).toEqual(["ack", "plan"]);
    send(said("My pick is the Keychron K2."));
    send(event({ type: "turn.completed", ok: true }));
    const note = beats.note(THREAD);
    expect(note).toContain("\"On it, comparing budget keyboards now.\"");
    expect(note).toContain("I'll check the prices are current");
    expect(beats.note(THREAD)).toBe("");
  });

  it("acks work at ACK_IDLE_MS on an engine that shows no thinking, and never sooner", async () => {
    const { beats, posts, send } = setup({ showsThinking: false });
    beats.start({ botId: "b", threadId: THREAD, text: "Write a launch plan for the spring candle line", attachments: 0, unattended: false });
    send(event({ type: "turn.started" }));
    await vi.advanceTimersByTimeAsync(ACK_IDLE_MS - 200);
    expect(posts).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    expect(posts.map((p) => p.kind)).toEqual(["ack"]);
  });

  it("asks the writer once more when the model is overloaded, but not after other failures", async () => {
    const busy = setup({ fails: ["upstream HTTP 503: auth_unavailable: no auth available (last upstream error: server_is_overloaded)"] });
    busy.beats.start({ botId: "b", threadId: THREAD, text: "Research the best budget mechanical keyboards in India", attachments: 0, unattended: false });
    busy.send(event({ type: "turn.started" }));
    busy.send(toolStart("WebSearch", { query: "keyboards" }, "s1"));
    await vi.advanceTimersByTimeAsync(RETRY_BUSY_MS + 2_100);
    expect(busy.prompts.map((p) => p.kind)).toEqual(["ack", "ack"]);
    expect(busy.posts.map((p) => p.kind)).toEqual(["ack"]);
    vi.useRealTimers();

    const broken = setup({ fails: ["upstream HTTP 400: bad request"] });
    broken.beats.start({ botId: "b", threadId: THREAD, text: "Research the best budget mechanical keyboards in India", attachments: 0, unattended: false });
    broken.send(event({ type: "turn.started" }));
    broken.send(toolStart("WebSearch", { query: "keyboards" }, "s1"));
    await vi.advanceTimersByTimeAsync(RETRY_BUSY_MS + 3_000);
    expect(broken.prompts.map((p) => p.kind)).toEqual(["ack"]);
    expect(broken.posts).toEqual([]);
  });

  it("asks the writer once more after a rate limit, and gives up after a second one", async () => {
    const limited = setup({ fails: ["429 Too Many Requests"] });
    limited.beats.start({ botId: "b", threadId: THREAD, text: "Research the best budget mechanical keyboards in India", attachments: 0, unattended: false });
    limited.send(event({ type: "turn.started" }));
    limited.send(toolStart("WebSearch", { query: "keyboards" }, "s1"));
    await vi.advanceTimersByTimeAsync(RETRY_BUSY_MS + 2_100);
    expect(limited.prompts.map((p) => p.kind)).toEqual(["ack", "ack"]);
    expect(limited.posts.map((p) => p.kind)).toEqual(["ack"]);
    vi.useRealTimers();

    const twice = setup({ fails: ["429 Too Many Requests", "rate limit reached"] });
    twice.beats.start({ botId: "b", threadId: THREAD, text: "Research the best budget mechanical keyboards in India", attachments: 0, unattended: false });
    twice.send(event({ type: "turn.started" }));
    twice.send(toolStart("WebSearch", { query: "keyboards" }, "s1"));
    await vi.advanceTimersByTimeAsync(RETRY_BUSY_MS + 3_000);
    expect(twice.prompts.map((p) => p.kind)).toEqual(["ack", "ack"]);
    expect(twice.posts).toEqual([]);
  });

  it("drops its ack when the engine speaks first", async () => {
    const { beats, posts, send } = setup();
    beats.start({ botId: "b", threadId: THREAD, text: "Research standing desks under 30k", attachments: 0, unattended: false });
    send(event({ type: "turn.started" }));
    send(event({ type: "content.delta", streamKind: "assistant_text", delta: "On it, " }));
    send(toolStart("WebSearch", { query: "standing desks" }, "s1"));
    await vi.advanceTimersByTimeAsync(ACK_IDLE_MS);
    expect(posts).toEqual([]);
  });

  it("waits for a quick question to show it is work, and says nothing when it is answered", async () => {
    const quiet = setup();
    quiet.beats.start({ botId: "b", threadId: THREAD, text: "what's 18% of 2450?", attachments: 0, unattended: false });
    quiet.send(event({ type: "turn.started" }));
    await vi.advanceTimersByTimeAsync(4_000);
    quiet.send(said("It's 441."));
    quiet.send(event({ type: "turn.completed", ok: true }));
    expect(quiet.prompts).toEqual([]);
    expect(quiet.posts).toEqual([]);
    vi.useRealTimers();

    const tool = setup();
    tool.beats.start({ botId: "b", threadId: THREAD, text: "weather in Pune today?", attachments: 0, unattended: false });
    tool.send(event({ type: "turn.started" }));
    expect(tool.prompts).toEqual([]);
    tool.send(toolStart("WebSearch", { query: "weather Pune" }, "s1"));
    expect(tool.prompts.map((p) => p.kind)).toEqual(["ack"]);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(tool.posts.map((p) => p.kind)).toEqual(["ack"]);
  });

  it("waits for the engine before acking work that has run no tool yet, and acks only once it is thinking", async () => {
    const { beats, posts, send } = setup();
    beats.start({ botId: "b", threadId: THREAD, text: "Write a launch plan for the spring candle line", attachments: 0, unattended: false });
    send(event({ type: "turn.started" }));
    send(event({ type: "content.delta", streamKind: "reasoning_text", delta: "Planning the sections." }));
    await vi.advanceTimersByTimeAsync(ACK_IDLE_MS - 500);
    expect(posts).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);
    expect(posts.map((p) => p.kind)).toEqual(["ack"]);
  });

  it("asks for a missing detail instead of claiming a search that never runs, and drops the question once a tool runs", async () => {
    const ask = "ASK: Which area or landmark are you near?";
    const asking = setup({ replies: { ack: ask } });
    asking.beats.start({ botId: "b", threadId: THREAD, text: "find the closest pharmacy open right now", attachments: 0, unattended: false });
    expect(asking.prompts[0]!.prompt).toContain("never say the work is underway: reply ASK:");
    asking.send(event({ type: "turn.started" }));
    asking.send(event({ type: "content.delta", streamKind: "reasoning_text", delta: "No location given." }));
    await vi.advanceTimersByTimeAsync(ACK_IDLE_MS + 100);
    expect(asking.posts).toEqual([{ kind: "ack", text: "Which area or landmark are you near?", turnId: TURN }]);
    vi.useRealTimers();

    const working = setup({ replies: { ack: ask } });
    working.beats.start({ botId: "b", threadId: THREAD, text: "find the closest pharmacy open right now", attachments: 0, unattended: false });
    working.send(event({ type: "turn.started" }));
    working.send(toolStart("WebSearch", { query: "pharmacy open now near Indiranagar" }, "s1"));
    await vi.advanceTimersByTimeAsync(ACK_IDLE_MS * 2);
    expect(working.posts).toEqual([]);
  });

  it("never asks back on a go-ahead, whose earlier chat the writer cannot see", async () => {
    const { beats, posts, send, prompts } = setup({ replies: { ack: "ASK: What would you like me to set up?" } });
    beats.start({ botId: "b", threadId: THREAD, text: "go ahead and set it up", attachments: 0, unattended: false });
    expect(prompts[0]!.prompt).toContain("a go-ahead or a pointer back");
    send(event({ type: "turn.started" }));
    send(event({ type: "content.delta", streamKind: "reasoning_text", delta: "Setting it up." }));
    await vi.advanceTimersByTimeAsync(ACK_IDLE_MS * 2);
    expect(posts).toEqual([]);
  });

  it("never acks a silent turn that runs no tool, so no ack is left with nothing after it", async () => {
    const { beats, posts, send } = setup();
    beats.start({ botId: "b", threadId: THREAD, text: "Write three posts for X announcing dark mode", attachments: 0, unattended: false });
    send(event({ type: "turn.started" }));
    await vi.advanceTimersByTimeAsync(ACK_IDLE_MS * 3);
    expect(posts).toEqual([]);
  });

  it("holds the ack for a bot set up to ask before it uses tools until a tool runs", async () => {
    const { beats, posts, send } = setup({ soul: "You are Echo. If asked to fetch real data, say what you would do and ask before using any tool." });
    beats.start({ botId: "b", threadId: THREAD, text: "Research candle shops' refund policies", attachments: 0, unattended: false });
    send(event({ type: "turn.started" }));
    await vi.advanceTimersByTimeAsync(ACK_IDLE_MS * 2);
    expect(posts).toEqual([]);
    send(toolStart("WebSearch", { query: "candle refunds" }, "s1"));
    await vi.advanceTimersByTimeAsync(300);
    expect(posts.map((p) => p.kind)).toEqual(["ack"]);
  });

  it("never runs for unattended turns, when switched off, or for a turn that is no longer live", async () => {
    const off = setup({ enabled: false });
    off.beats.start({ botId: "b", threadId: THREAD, text: "Research keyboards", attachments: 0, unattended: false });
    expect(off.prompts).toEqual([]);
    vi.useRealTimers();
    const routine = setup();
    routine.beats.start({ botId: "b", threadId: THREAD, text: "Research keyboards", attachments: 0, unattended: true });
    expect(routine.prompts).toEqual([]);
    vi.useRealTimers();
    const gone = setup();
    gone.beats.start({ botId: "b", threadId: THREAD, text: "Research keyboards", attachments: 0, unattended: false });
    gone.send(event({ type: "turn.started" }));
    gone.send(toolStart("WebSearch", { query: "k" }, "s1"));
    gone.stop();
    await vi.advanceTimersByTimeAsync(PLAN_MIN_MS);
    expect(gone.posts).toEqual([]);
  });

  it("sends the second message after the engine's own ack or note, with what was said, but not after three messages", async () => {
    const own = setup();
    own.beats.start({ botId: "b", threadId: THREAD, text: "Research keyboard prices in India", attachments: 0, unattended: false });
    own.send(event({ type: "turn.started" }));
    own.send(said("On it, checking keyboard prices."));
    own.send(toolStart("WebSearch", { query: "keyboard prices" }, "s1"));
    await vi.advanceTimersByTimeAsync(2_000);
    own.send(said("Amazon blocked the page, so I'm trying Flipkart."));
    await vi.advanceTimersByTimeAsync(PLAN_MIN_MS);
    expect(own.posts.map((p) => p.kind)).toEqual(["plan"]);
    expect(own.prompts.at(-1)!.prompt).toContain("- Amazon blocked the page, so I'm trying Flipkart.");
    vi.useRealTimers();

    const chatty = setup();
    chatty.beats.start({ botId: "b", threadId: THREAD, text: "Research keyboard prices in India", attachments: 0, unattended: false });
    chatty.send(event({ type: "turn.started" }));
    chatty.send(toolStart("WebSearch", { query: "keyboard prices" }, "s1"));
    await vi.advanceTimersByTimeAsync(2_500);
    chatty.send(said("Amazon blocked the page."));
    chatty.send(said("Trying Flipkart instead."));
    await vi.advanceTimersByTimeAsync(PLAN_MIN_MS);
    expect(chatty.posts.map((p) => p.kind)).toEqual(["ack"]);
  });

  it("writes the second message again when the engine says something while it waits, and holds it while the engine writes", async () => {
    const { beats, prompts, posts, send } = setup();
    beats.start({ botId: "b", threadId: THREAD, text: "Research keyboard prices in India", attachments: 0, unattended: false });
    send(event({ type: "turn.started" }));
    send(toolStart("WebSearch", { query: "keyboard prices" }, "s1"));
    await vi.advanceTimersByTimeAsync(PLAN_WRITE_MS + 2_500);
    expect(prompts.map((p) => p.kind)).toEqual(["ack", "plan"]);
    send(event({ type: "content.delta", streamKind: "assistant_text", delta: "Amazon blocked" }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(posts.map((p) => p.kind)).toEqual(["ack"]);
    send(said("Amazon blocked the page, so I'm trying Flipkart."));
    send(toolStart("WebFetch", { url: "https://www.flipkart.com/x" }, "f1"));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(prompts.map((p) => p.kind)).toEqual(["ack", "plan", "plan"]);
    expect(prompts.at(-1)!.prompt).toContain("Amazon blocked the page");
    expect(posts.map((p) => p.kind)).toEqual(["ack", "plan"]);
  });

  it("drops the second message once the engine is writing its result", async () => {
    const { beats, posts, send } = setup();
    beats.start({ botId: "b", threadId: THREAD, text: "Compare Notion and Coda for a team of five", attachments: 0, unattended: false });
    send(event({ type: "turn.started" }));
    send(toolStart("WebSearch", { query: "notion pricing" }, "s1"));
    await vi.advanceTimersByTimeAsync(2_500);
    send(toolDone("s1"));
    await vi.advanceTimersByTimeAsync(PLAN_WRITE_MS);
    send(event({ type: "content.delta", streamKind: "assistant_text", delta: "I'd go with Notion." }));
    await vi.advanceTimersByTimeAsync(PLAN_MIN_MS);
    expect(posts.map((p) => p.kind)).toEqual(["ack"]);
  });

  it("sends a milestone after a long quiet stretch of work, and does not retry a declined one at once", async () => {
    const { beats, prompts, posts, send } = setup({ replies: { milestone: "SKIP" }, writerMs: 100 });
    beats.start({ botId: "b", threadId: THREAD, text: "Build a 6-slide deck on the Bangalore pet market", attachments: 0, unattended: false });
    send(event({ type: "turn.started" }));
    send(toolStart("WebSearch", { query: "pet market" }, "s1"));
    await vi.advanceTimersByTimeAsync(PLAN_MIN_MS + 1_000);
    expect(posts.map((p) => p.kind)).toEqual(["ack", "plan"]);
    send(toolStart("Write", { file_path: "/w/slide1.md" }, "w1"));
    send(toolStart("Write", { file_path: "/w/slide2.md" }, "w2"));
    await vi.advanceTimersByTimeAsync(MILESTONE_QUIET_MS);
    expect(prompts.filter((p) => p.kind === "milestone")).toHaveLength(1);
    expect(prompts.at(-1)!.prompt).toContain("- Writing slide2.md");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(prompts.filter((p) => p.kind === "milestone")).toHaveLength(1);
    expect(posts.map((p) => p.kind)).toEqual(["ack", "plan"]);
  });
});

describe("beat text", () => {
  it("keeps one short plain line and refuses the rest", () => {
    expect(cleanBeat("ack", "\"On it, checking the fares now!\"")).toBe("On it, checking the fares now.");
    expect(cleanBeat("ack", "Message: Got it, pulling the reviews.")).toBe("Got it, pulling the reviews.");
    expect(cleanBeat("ack", "SKIP")).toBeNull();
    expect(cleanBeat("ack", "Want me to check prices too?")).toBeNull();
    expect(cleanBeat("ack", "ASK: Which area are you near?")).toBe("Which area are you near?");
    expect(cleanBeat("ack", "ASK: Looking for the closest pharmacy now.")).toBeNull();
    expect(cleanBeat("plan", "ASK: Which format do you want?")).toBeNull();
    expect(cleanBeat("ack", "word ".repeat(40))).toBeNull();
    expect(cleanBeat("plan", "one\ntwo\nthree")).toBeNull();
    expect(cleanBeat("plan", "I'll give you a brief confirmation, leaving the other details unchanged. Before sending, I'll check that both corrections match your message.")).toBeNull();
    expect(cleanBeat("plan", "You'll get a short table of the three plans with prices, and I'll check each price is current.")).not.toBeNull();
    expect(cleanBeat("ack", "On it, testing sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 now")).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("tells apart work from a quick question", () => {
    expect(looksLikeWork("Research the best budget keyboards", 0)).toBe(true);
    expect(looksLikeWork("what's 18% of 2450?", 0)).toBe(false);
    expect(looksLikeWork("hi", 1)).toBe(true);
    for (const setupAsk of ["remind me at 7 to call grandma", "tell me when the price of the Sony headphones drops below 20000",
      "every monday 9am give me a summary of open brand deals", "make it 9:30 instead, and skip fridays", "wait, it's in Rust not Go", "cancel my daily standup reminder"]) {
      expect(looksLikeWork(setupAsk, 0)).toBe(true);
    }
    for (const makeAsk of ["make me a thumbnail image for a video called 'I lived on ₹100 a day'", "make me a chart of revenue by product I can put in a deck",
      "audit my automations: any duplicates or ones I don't need?", "todos os dias às 8h manda-me as 3 tarefas mais importantes do dia",
      "recuérdame mañana a las 9 llamar al banco", "avisa-me quando o preço baixar"]) {
      expect(looksLikeWork(makeAsk, 0)).toBe(true);
    }
    for (const quick of ["what's the capital of Australia?", "thanks!", "how many days are in a leap year?", "what makes a good logo?",
      "qual é a capital da Austrália?", "make sense?"]) expect(looksLikeWork(quick, 0)).toBe(false);
  });

  it("is nothing for the engine when nothing was sent", () => {
    expect(beatsNote([])).toBe("");
  });
});

describe("what a beat may promise", () => {
  const input = { name: "Forge", ask: "make a node cli todo app with tests, run them", steps: ["Writing index.js"], said: ["On it, writing the todo app."] };
  it("never asks the writer for a check before sending, and forbids promising one the steps do not show", () => {
    const plan = beatPrompt("plan", input);
    expect(plan).not.toContain("the one check that will happen before sending");
    expect(plan).toContain("Never promise a check, a test, a price lookup or anything else that is not already among the steps");
  });
  it("knows the connected apps and never claims access to an app, chat or item it cannot see", () => {
    for (const kind of ["ack", "plan", "milestone"] as const) {
      const prompt = beatPrompt(kind, { ...input, ask: "watch our telegram group and tell me when a deal moves", apps: ["gmail"] });
      expect(prompt).toContain("Connected apps Forge can use: gmail.");
      expect(prompt).toContain("Never claim to be reading, watching, cancelling or changing something in an app, account, chat, device or existing item");
    }
    expect(beatPrompt("ack", input)).toContain("Connected apps Forge can use: none.");
  });
  it("never apologises in a beat, and names the fix instead", () => {
    for (const kind of ["ack", "plan", "milestone"] as const) {
      expect(beatPrompt(kind, input)).toContain("no apology: when they are upset, name the fix being made");
      expect(beatPrompt(kind, input)).toContain("Never say what can't be done or that a step failed: that is Forge's own reply to make.");
    }
  });
  it("acks every work ask, a correction and a watch setup included", () => {
    const ack = beatPrompt("ack", input);
    expect(ack).toContain("Reply exactly SKIP only if the message is a greeting, thanks or small talk");
    expect(ack).toContain("a correction or a change (\"wait, it's in Rust\") gets one naming the change");
    expect(ack).not.toContain("outside what");
    expect(ack).not.toMatch(/name the goal instead[^.]*or reply SKIP/);
  });
  it("keeps product names as the person wrote them in the ack", () => {
    expect(beatPrompt("ack", input)).toContain("Write names and products exactly as the person did");
  });
});

