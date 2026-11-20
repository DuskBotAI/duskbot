import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import type { BrowserStep } from "./browser-step";
import { browsingNow, latestTurn, stepUnits } from "./live-step";

const AT = Date.UTC(2026, 0, 5, 12);
let seq = 0;
const row = (tool: NonNullable<Message["tool"]>, extra: Partial<Message> = {}): Message =>
  ({ id: `m${++seq}`, role: "bot", kind: "activity", at: AT, tool, ...extra });
const browse = (action: string, ok?: boolean, extra: Partial<Message> = {}) => row({ name: `mcp__browser__agent_browser_${action}`, ...(ok === undefined ? {} : { ok }) }, extra);
const command = (detail: string, ok?: boolean) => row({ name: "Bash", step: { activity: "command", target: detail }, ...(ok === undefined ? {} : { ok }) });
const read = (ok?: boolean) => row({ name: "Read", step: { activity: "read", target: "notes.md" }, ...(ok === undefined ? {} : { ok }) });
const text = (words: string): Message => ({ id: `m${++seq}`, role: "bot", kind: "text", at: AT, text: words });
const user = (words: string): Message => ({ id: `m${++seq}`, role: "user", kind: "text", at: AT, text: words });
const shape = (messages: Message[]) => stepUnits(messages).map((unit) => (unit.kind === "command" ? unit.step.id : unit.steps.map((step) => step.id)));

describe("stepUnits", () => {
  it("is each command by itself and each stretch of browser calls as one, in order", () => {
    const a = command("ls", true), b = browse("open", true), hidden = read(true), c = browse("click", true), d = command("pwd", true), tail = read(true);
    const units = stepUnits([a, b, hidden, c, d, tail]);
    expect(units.map((unit) => unit.kind)).toEqual(["command", "browser", "command"]);
    expect(shape([a, b, hidden, c, d, tail])).toEqual([a.id, [b.id, c.id], d.id]);
    expect(units[1]).toMatchObject({ id: b.id, through: [b.id, hidden.id, c.id] });
  });

  it("keeps a stretch together across finished, failed and running calls and the tool steps between them", () => {
    const steps = [browse("open", true), read(), browse("click", false), read(true), browse("snapshot")];
    expect(shape(steps)).toEqual([[steps[0]!.id, steps[2]!.id, steps[4]!.id]]);
  });

  it("ends a stretch at the bot's words, at the person's next message and at a command", () => {
    const a = browse("open", true), said = text("Found the page."), b = browse("click", true), asked = user("and the price?"), c = browse("open", true), ran = command("pnpm test"), d = browse("click");
    expect(shape([a, said, b, asked, c, ran, d])).toEqual([[a.id], [b.id], [c.id], ran.id, [d.id]]);
  });

  it("is empty for a conversation with no command and no browsing", () => {
    expect(stepUnits([read(true), text("hi"), row({ name: "WebSearch", step: { activity: "web", target: "cats" } })])).toEqual([]);
  });
});

describe("latestTurn", () => {
  it("is the rows of the newest turn, whatever sits between them", () => {
    const old = command("ls", true), reply = text("done"), next = command("pwd", true), end = text("there");
    Object.assign(old, { turnId: "one" }); Object.assign(reply, { turnId: "one" }); Object.assign(next, { turnId: "two" }); Object.assign(end, { turnId: "two" });
    expect(latestTurn([user("list"), old, reply, user("where"), next, end]).map((message) => message.id)).toEqual([next.id, end.id]);
  });

  it("is what follows the person's last message where rows carry no turn", () => {
    const old = command("ls", true), next = command("pwd", true);
    expect(latestTurn([user("list"), old, user("where"), next]).map((message) => message.id)).toEqual([next.id]);
  });

  it("follows one member's own turns in a group", () => {
    const mine = browse("open", true, { turnId: "mine", from: { botId: "b1", name: "One", color: "blue" } });
    const theirs = command("ls", true);
    Object.assign(theirs, { turnId: "theirs", from: { botId: "b2", name: "Two", color: "red" } });
    expect(latestTurn([user("go"), mine, theirs], (message) => message.from?.botId === "b1").map((message) => message.id)).toEqual([mine.id]);
  });
});

describe("browsingNow", () => {
  const step = (id: string, ok?: boolean): BrowserStep =>
    ({ id, role: "bot", kind: "activity", at: 1, tool: { name: "mcp__browser__agent_browser_click", ...(ok === undefined ? {} : { ok }) } }) as BrowserStep;
  const now = (over: Partial<Parameters<typeof browsingNow>[0]> = {}) => browsingNow({
    steps: [step("a", true), step("b", true)], through: ["a", "b"], live: new Set(["a", "b"]), room: false, turnEnded: false, replying: false, ...over,
  });

  it("is true between two browser calls of a running turn, so the card stays open", () => {
    expect(now()).toBe(true);
  });

  it("is false once the turn is over, its answer is being written, or its steps are from an earlier turn", () => {
    expect(now({ turnEnded: true })).toBe(false);
    expect(now({ replying: true })).toBe(false);
    expect(now({ live: new Set() })).toBe(false);
    expect(now({ live: new Set(["z"]) })).toBe(false);
  });

  it("is false once the turn's newest step is past the stretch, and true while it is a tool step between browser calls", () => {
    expect(now({ live: new Set(["a", "b", "command"]) })).toBe(false);
    expect(now({ through: ["a", "b", "hidden"], live: new Set(["a", "b", "hidden"]) })).toBe(true);
  });

  it("in a room follows only the member's own running call when a teammate's step is newer", () => {
    const live = new Set(["a", "b", "teammate"]);
    expect(now({ room: true, live })).toBe(false);
    expect(now({ room: true, live, steps: [step("a", true), step("b")] })).toBe(true);
  });
});
