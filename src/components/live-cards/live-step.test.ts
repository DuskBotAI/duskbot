import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { groupLiveCardRuns, isLiveCardStep, liveSegments } from "./live-step";

const AT = Date.UTC(2026, 0, 5, 12);
let seq = 0;
const row = (tool: NonNullable<Message["tool"]>, extra: Partial<Message> = {}): Message =>
  ({ id: `m${++seq}`, role: "bot", kind: "activity", at: AT, tool, ...extra });
const browse = (action: string, ok?: boolean, extra: Partial<Message> = {}) => row({ name: `mcp__browser__agent_browser_${action}`, ...(ok === undefined ? {} : { ok }) }, extra);
const command = (detail: string, ok?: boolean) => row({ name: "Bash", step: { activity: "command", target: detail }, ...(ok === undefined ? {} : { ok }) });
const read = (ok?: boolean) => row({ name: "Read", step: { activity: "read", target: "notes.md" }, ...(ok === undefined ? {} : { ok }) });
const text = (words: string): Message => ({ id: `m${++seq}`, role: "bot", kind: "text", at: AT, text: words });
const shape = (messages: Message[]) => groupLiveCardRuns(messages).map((item) => (item.kind === "run" ? item.messages.map((message) => message.id) : item.message.id));

describe("isLiveCardStep", () => {
  it("is a command or a call on the built-in browser, and no other tool step", () => {
    expect(isLiveCardStep(command("ls"))).toBe(true);
    expect(isLiveCardStep(browse("open"))).toBe(true);
    expect(isLiveCardStep(read(true))).toBe(false);
    expect(isLiveCardStep(row({ name: "WebSearch", step: { activity: "web", target: "cats" } }))).toBe(false);
    expect(isLiveCardStep(text("hello"))).toBe(false);
  });
});

describe("groupLiveCardRuns", () => {
  it("keeps one stretch of browser calls together: finished, failed and still running", () => {
    const steps = [browse("open", true), browse("click", false), browse("fill", true), browse("snapshot")];
    expect(shape(steps)).toEqual([steps.map((step) => step.id)]);
  });

  it("makes even one browser call a run, so its card keeps its place when the next call joins", () => {
    const first = browse("open");
    const [alone] = groupLiveCardRuns([first]);
    expect(alone).toMatchObject({ kind: "run", id: `run:${first.id}`, messages: [first] });
    const [joined] = groupLiveCardRuns([{ ...first, tool: { ...first.tool!, ok: true } }, browse("click")]);
    expect(joined).toMatchObject({ kind: "run", id: `run:${first.id}` });
  });

  it("does not end a stretch at a tool step the chat does not draw", () => {
    const steps = [browse("open", true), read(), browse("click", true), read(true), browse("snapshot")];
    expect(shape(steps)).toEqual([steps.map((step) => step.id)]);
  });

  it("ends a stretch at the bot's words, at a command still running, and at another speaker", () => {
    const a = browse("open", true), said = text("Found the page."), b = browse("click", true);
    expect(shape([a, said, b])).toEqual([[a.id], said.id, [b.id]]);
    const c = browse("open", true), running = command("pnpm test"), d = browse("click");
    expect(shape([c, running, d])).toEqual([[c.id], running.id, [d.id]]);
    const e = browse("open", false, { from: { botId: "one", name: "One", color: "blue" } }), f = browse("open", undefined, { from: { botId: "two", name: "Two", color: "red" } });
    expect(shape([e, f])).toEqual([[e.id], [f.id]]);
  });

  it("leaves commands grouped as they were", () => {
    const a = command("pnpm lint", true), b = command("pnpm test", true), c = command("pnpm build");
    expect(shape([a, b, c])).toEqual([[a.id, b.id], c.id]);
  });
});

describe("liveSegments", () => {
  it("splits a run into its commands and its browser stretches, in order", () => {
    const a = command("ls", true), b = browse("open", true), hidden = read(true), c = browse("click", true), d = command("pwd", true), tail = read(true);
    const segments = liveSegments([a, b, hidden, c, d, tail]);
    expect(segments.map((segment) => [segment.kind, segment.steps.map((step) => step.id)])).toEqual([
      ["command", [a.id]], ["browser", [b.id, c.id]], ["command", [d.id]],
    ]);
    expect(segments[1]!.through).toEqual([b.id, hidden.id, c.id]);
    expect(segments[2]!.through).toEqual([d.id, tail.id]);
  });

  it("is empty for steps the chat does not draw", () => {
    expect(liveSegments([read(true), text("hi")])).toEqual([]);
  });
});
