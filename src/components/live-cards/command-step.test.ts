import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { commandState, commandText, isCommandStep } from "./command-step";

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
});
