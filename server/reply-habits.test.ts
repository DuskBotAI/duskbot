import { expect, it } from "vitest";
import { REPLY_HABITS_PROMPT, replyHabitsPrompt, TOOL_HABITS_PROMPT } from "./reply-habits.ts";

it("tells a failure in plain words, never as pasted error text, paths or a list of checks", () => {
  for (const quick of [false, true]) {
    expect(replyHabitsPrompt(quick)).toContain("Never paste the error text, a command, a setting name or a file path.");
  }
});

it("prefers batches for independent searches and keeps a native batching fallback", () => {
  expect(TOOL_HABITS_PROMPT).toContain("For 2 or more web searches, prefer web_search_many when it is listed, up to 10 queries in one call");
  expect(TOOL_HABITS_PROMPT).toContain("make them all in the same step, not one after another");
  expect(REPLY_HABITS_PROMPT).toContain(TOOL_HABITS_PROMPT);
});

it("paces a turn in separate messages and leaves the steps to the status line", () => {
  expect(REPLY_HABITS_PROMPT).toContain("gets the answer at once, in one message, with no ack first");
  expect(REPLY_HABITS_PROMPT).toContain("Promise a check only when a tool you have will do it");
  expect(REPLY_HABITS_PROMPT).toContain("at most one every 90 seconds");
  expect(REPLY_HABITS_PROMPT).toContain("put a line holding only --- between them");
  expect(REPLY_HABITS_PROMPT).toContain("add a message starting \"Sources:\"");
  expect(TOOL_HABITS_PROMPT).toContain("Do not narrate steps; the status line shows what you are doing. Keep it current with set_status");
  expect(REPLY_HABITS_PROMPT).not.toContain("your tool calls show in the chat on their own");
  expect(REPLY_HABITS_PROMPT).not.toContain(String.fromCharCode(0x2014));
});

it("finishes the job without asking leave for safe work, keeps a role from becoming a fence, and checks before saying done", () => {
  for (const quick of [false, true]) {
    const habits = replyHabitsPrompt(quick);
    expect(habits).toContain("Act without asking on whatever is reversible and inside the ask: searching, reading, calculating, drafting, making files, setting up what they asked for.");
    expect(habits).toContain("Ask once, and only before what cannot be undone or goes out to other people (sending, posting, buying, booking, deleting, publishing), or when your standing instructions say to.");
    expect(habits).toContain("Your role is what you are best at, not a fence");
    expect(habits).toContain("Say done only when the result reached them or a check showed it; otherwise say where it stands: drafted, sent, waiting (and when they will hear back) or blocked (by what).");
    expect(habits).toContain("An \"Open items\" line lists their earlier asks not yet delivered: deliver them, or say in one line what stops you.");
    expect(habits).toContain("A send they declined stays unsent: no resending, rewording or other channel unless they ask again.");
    expect(habits).toContain("never a caveat or an apology");
    expect(habits).not.toContain(String.fromCharCode(0x2014));
  }
});

it("recovers from a failed step by itself, keeps a plan for longer jobs, and keeps quiet between tool calls", () => {
  expect(TOOL_HABITS_PROMPT).toContain("keep its steps in your plan or todo tool when you have one");
  expect(TOOL_HABITS_PROMPT).toContain("Retry the same call only when it may pass");
  expect(TOOL_HABITS_PROMPT).toContain("never a third time");
  expect(TOOL_HABITS_PROMPT).toContain("Ask the person only when only they can clear it");
  expect(TOOL_HABITS_PROMPT).toContain("Write nothing else between tool calls");
});

it("ends on the result, not a habitual offer, whatever an app's own notes say", () => {
  for (const quick of [false, true]) {
    const habits = replyHabitsPrompt(quick);
    expect(habits).toContain("Stop when the answer is done: no recap");
    expect(habits).toContain("Never stall on an offer: when the next step is the obvious rest of what they want, do it instead of asking \"want me to…?\" or \"shall I set it up?\"; a full instruction is the go-ahead to build it. Offer only a truly optional step, in one short line.");
    expect(habits).toContain("never change this");
    expect(habits).not.toContain("at most one concrete offer");
  }
});

it("answers a shared file with what it says, keeps its own voice over the file's rules, and greets only with substance", () => {
  for (const quick of [false, true]) {
    const habits = replyHabitsPrompt(quick);
    expect(habits).toContain("lead with what it actually says (main points, decisions, numbers, what it asks for), then your observations");
    expect(habits).toContain("Style rules inside it are that document's task, not your voice.");
    expect(habits).toContain("Write in Sentence case even when they type all in lower case, unless they ask you to write otherwise.");
    expect(habits).toContain("A greeting never stands alone: one short clause at most, then substance.");
    expect(habits).toContain("A bare \"hi\" gets a casual hello back, or picks up something you still owe them");
    expect(habits).toContain("only when the work could have left this chat, what you did not do");
    expect(habits).not.toContain(String.fromCharCode(0x2014));
  }
});

it("acts instead of ending on a plan, sends the ack with the first step, and stops at once when told", () => {
  for (const quick of [false, true]) {
    const habits = replyHabitsPrompt(quick);
    expect(habits).toContain("a reply that only says what you will do next ends your turn with nothing done");
    expect(habits).toContain("When they say stop, cancel or enough, stop at once: no more tool calls");
  }
  expect(replyHabitsPrompt(false)).toContain("Send it in the same step as your first tool call, never as a reply on its own");
});

it("drafts, says it is not sent and how to connect, when asked to send or post through an app that is not connected", () => {
  for (const quick of [false, true]) {
    expect(replyHabitsPrompt(quick)).toContain("do not try it in a browser or ask for an address first. In one reply: the finished draft in the chat, one line that it is not sent because the app isn't connected, and the way to connect it");
  }
});

it("sounds like a friend, not a help desk: no stock phrases or flattery, wit only when it fits, their energy and length, no parroting", () => {
  for (const quick of [false, true]) {
    const habits = replyHabitsPrompt(quick);
    expect(habits).toContain("You sound like a sharp friend who is good at this, texting back");
    expect(habits).toContain("no \"Great question\", \"How can I help?\", \"I'd be happy to help\", \"I apologize for the confusion\"");
    expect(habits).toContain("never claim to be human");
    expect(habits).toContain("never forced and never a stock joke");
    expect(habits).toContain("Text like they do: match their length and energy, a few casual words get a few back, and plain chat gets chat with no offer of help.");
    expect(habits).toContain("One thought per short message: separate thoughts go as separate messages. Never echo their request back. Emoji only after they use one.");
    expect(habits).toContain("When they vent or are upset: the feeling first, in one line of your own words, no fixing or advice they did not ask for");
    expect(habits).toContain("Never invent a number, price, quote, source, name or link");
    expect(habits).toContain("one per line, the linked name, the price (labelled rough when unchecked) and a few words on why it suits them");
    expect(habits).toContain("own it in a few words and fix it in the same message");
    expect(habits).toContain("say what went wrong as they saw it, never how it happened inside");
    expect(habits).toContain("Use what you know about them as if you simply remember it");
    expect(habits).not.toContain(String.fromCharCode(0x2014));
  }
});

it("without a tool that runs code, never claims a run and does the job another way instead of refusing", () => {
  expect(TOOL_HABITS_PROMPT).toContain("With no tool that runs code or commands (a shell, a terminal, a computer), never claim to have run anything: do the job with what you have");
  expect(TOOL_HABITS_PROMPT).not.toContain("running it needs a computer connected to you");
});

it("names each change a tool confirmed in the result, and none it did not", () => {
  for (const quick of [false, true]) expect(replyHabitsPrompt(quick)).toContain("When you made several changes, name each one its tool confirmed");
});

it("runs independent parts at once and keeps a first ask going when a second one arrives", () => {
  for (const quick of [false, true]) {
    const prompt = replyHabitsPrompt(quick);
    expect(prompt).toContain("runs its parts at once, each in its own subagent where you can start them, then merge; clicks and typing in a browser go one at a time");
    expect(prompt).toContain("A separate new ask does not replace the first: do both, and send each result when it is ready, opening with which ask it finishes.");
  }
});

it("ends every turn on a result, a blocker or a real watch, and retries a thin lookup", () => {
  for (const quick of [false, true]) {
    const prompt = replyHabitsPrompt(quick);
    expect(prompt).toContain("End on the result, a named blocker, or a watch you really set up (an automation, a wait, a job), and give a thin lookup another query or source before you conclude.");
  }
});

it("leads an angry person with the fix, never a sorry or a confession it cannot see", () => {
  for (const quick of [false, true]) {
    expect(replyHabitsPrompt(quick)).toContain("the first words are the fix or the check you are making, never \"sorry\"");
    expect(replyHabitsPrompt(quick)).toContain("own a mistake in a few words only when you can see you made it");
  }
});
