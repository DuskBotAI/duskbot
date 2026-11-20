import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../../../shared/runtime-events";
import { forgetCommandTails, noteCommandTail } from "@/state/command-tails";
import type { Message } from "@/state/store";
import { CommandCard } from "./CommandCard";
import type { CommandStep } from "./command-step";

const bot = { id: "b1", name: "Nova", color: "green" as const };
let seq = 0;
const step = (detail: string, tool: Partial<NonNullable<Message["tool"]>> = {}): CommandStep =>
  ({ id: `m${++seq}`, role: "bot", kind: "activity", at: Date.now() - 3_000, tool: { name: "Bash", itemId: `i${seq}`, step: { activity: "command", target: detail, detail }, ...tool } }) as CommandStep;
const card = (message: CommandStep, live = false) => renderToStaticMarkup(createElement(CommandCard, { message, bot, threadId: "t1", live }));

afterEach(() => forgetCommandTails());

describe("CommandCard", () => {
  it("is an open window with the mascot up and the live output while the command runs", () => {
    const message = step("pnpm test");
    noteCommandTail({ type: "turn.progress", activity: "command", threadId: "t1", itemId: message.tool.itemId, tail: ["RUN v3", "<b>✓ a.test.ts</b>"] } as unknown as RuntimeEvent);
    const html = card(message, true);
    expect(html).toContain('data-live-card-state="running"');
    expect(html).toContain('data-live-card-open=""');
    expect(html).toContain('data-peeking=""');
    expect(html).not.toContain('data-ducked');
    expect(html).toContain("data-working-mascot");
    expect(html).toContain("pnpm test");
    expect(html).toContain("RUN v3\n&lt;b&gt;✓ a.test.ts&lt;/b&gt;");
    expect(html).toContain("Command pnpm test · Running · show output");
    expect(html).toContain('aria-disabled="true"');
  });

  it("spells out a command too long for its title line, and a short one only once", () => {
    const long = "pnpm exec vitest run src/components/live-cards --reporter dot";
    const html = card(step(long), true);
    expect(html).toContain("data-live-card-command");
    expect(html.split(long)).toHaveLength(4);
    expect(card(step("pnpm test"), true)).not.toContain("data-live-card-command");
    expect(card(step("echo a\necho b"), true)).toContain("data-live-card-command");
  });

  it("says it is running when the engine reports output only at the end", () => {
    const html = card(step("sleep 30"), true);
    expect(html).toContain("Output shows here when the command prints some.");
  });

  it("folds to one line with a tick and how long it took", () => {
    const html = card(step("pnpm build", { ok: true, ms: 83_000, output: "built in 80s" }));
    expect(html).toContain('data-live-card-state="done"');
    expect(html).not.toContain("data-live-card-open");
    expect(html).not.toContain("data-peeking");
    expect(html).not.toContain("data-working-mascot");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("1m 23s");
    expect(html).toContain("Command pnpm build · Finished · show output");
    expect(html).toMatch(/data-folded=""[^>]*inert/);
    expect(html).not.toContain("built in 80s");
  });

  it("marks a failed command and one whose result never came", () => {
    const failed = card(step("false", { ok: false, output: "exit 1" }));
    expect(failed).toContain('data-live-card-state="failed"');
    expect(failed).toContain("text-danger");
    const ended = card(step("ls"));
    expect(ended).toContain('data-live-card-state="ended"');
    expect(ended).toContain("Command ls · No result · show output");
  });
});
