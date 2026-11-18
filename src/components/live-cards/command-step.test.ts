import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { quietRow, simpleRowLayout } from "../chat-bubble";
import { groupActivityRuns, groupTranscript } from "@/lib/activity-runs";
import { roomActivityVisible } from "@/lib/room-activity";
import { commandState, commandSteps, commandText, isCommandStep } from "./command-step";

let seq = 0;
const row = (fields: Partial<Message>): Message => ({ id: `m${++seq}`, role: "bot", kind: "activity", at: 1_000 + seq, ...fields }) as Message;
const command = (detail: string, fields: Partial<NonNullable<Message["tool"]>> = {}) =>
  row({ tool: { name: "Bash", ok: true, step: { activity: "command", target: detail.split(" ")[0]!, detail }, ...fields } });
const read = () => row({ tool: { name: "Read", ok: true, step: { activity: "read", target: "notes.md" } } });

describe("command steps", () => {
  it("are tool rows whose step is a command, whatever the engine called the tool", () => {
    expect(isCommandStep(command("pnpm test"))).toBe(true);
    expect(isCommandStep(command("Get-ChildItem", { name: "PowerShell" }))).toBe(true);
    expect(isCommandStep(command("ls", { name: "mcp__device__mac_exec" }))).toBe(true);
    expect(isCommandStep(read())).toBe(false);
    expect(isCommandStep(row({ tool: { name: "Bash", ok: true } }))).toBe(false);
    expect(isCommandStep(row({ kind: "text", text: "hello" }))).toBe(false);
    expect(isCommandStep(row({ tool: { name: "notice: waiting", step: { activity: "command", target: "x" } } }))).toBe(false);
  });

  it("show the whole command when the step has one, else its target", () => {
    expect(commandText({ activity: "command", target: "scrape.py", detail: "python3 scrape.py --pages 40" })).toBe("python3 scrape.py --pages 40");
    expect(commandText({ activity: "command", target: "pnpm test" })).toBe("pnpm test");
  });

  it("run only while the turn does", () => {
    expect(commandState({}, true)).toBe("running");
    expect(commandState({}, false)).toBe("ended");
    expect(commandState({ ok: true }, true)).toBe("done");
    expect(commandState({ ok: false }, false)).toBe("failed");
  });

  it("picks the commands out of a run of steps", () => {
    const steps = [command("ls"), read(), command("pwd")];
    expect(commandSteps(steps).map((step) => step.id)).toEqual([steps[0]!.id, steps[2]!.id]);
  });
});

describe("rows with live cards on", () => {
  it("draw a command step and keep every other tool step quiet", () => {
    expect(quietRow(command("ls"), false)).toBe(true);
    expect(quietRow(command("ls"), false, true)).toBe(false);
    expect(quietRow(read(), false, true)).toBe(true);
    expect(roomActivityVisible(command("ls"), false)).toBe(false);
    expect(roomActivityVisible(command("ls"), false, true)).toBe(true);
    expect(roomActivityVisible(read(), false, true)).toBe(false);
  });

  it("break a bot's bubbles around a card and tuck the card under them", () => {
    const text = (fields: Partial<Message> = {}) => row({ kind: "text", text: "hi", ...fields });
    const messages = [row({ role: "user", kind: "text", text: "go" }), text({ turnId: "t" }), command("ls", {}), text({ turnId: "t" })];
    messages[2]!.turnId = "t";
    const items = groupTranscript(messages);
    const off = simpleRowLayout(items, { botId: "b", showToolCalls: false, unreadIds: null });
    expect(off.joins[1]!.below).toBe(true);
    const on = simpleRowLayout(items, { botId: "b", showToolCalls: false, unreadIds: null, liveCards: true });
    expect(on.joins[1]!.below).toBe(false);
    expect(on.joins[3]!.above).toBe(false);
    expect(on.tucks[2]).toBe(true);
  });

  it("keep a settled turn's commands where they ran", () => {
    const messages = [
      row({ role: "user", kind: "text", text: "go" }),
      { ...command("ls"), turnId: "t" }, { ...read(), turnId: "t" },
      row({ kind: "text", text: "next", turnId: "t" }),
      { ...command("pwd"), turnId: "t" },
      row({ kind: "text", text: "done", turnId: "t", turnTerminal: true }),
    ];
    const items = groupActivityRuns(messages);
    expect(items.map((item) => item.kind)).toEqual(["message", "run", "message", "message", "message"]);
    const layout = simpleRowLayout(items, { botId: "b", showToolCalls: false, unreadIds: null, liveCards: true });
    expect(layout.tucks.slice(1)).toEqual([false, true, true, true]);
    expect(layout.joins[2]).toEqual({ above: false, below: false });
  });
});
