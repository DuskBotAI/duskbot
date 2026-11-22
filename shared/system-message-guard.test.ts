import { describe, expect, it } from "vitest";
import {
  botTextForDisplay,
  createSystemHarnessStreamFilter,
  isPureLeakedBotText,
  isPureLeakedSystemHarnessMessage,
  stripLeakedSystemHarnessMessages,
} from "./system-message-guard.ts";

describe("system-message-guard", () => {
  it("leaves ordinary conversational text alone", () => {
    const text = "Hello! Here is the summary of your task.";
    expect(stripLeakedSystemHarnessMessages(text)).toBe(text);
    expect(isPureLeakedSystemHarnessMessage(text)).toBe(false);
  });

  it("handles null and undefined safely", () => {
    expect(stripLeakedSystemHarnessMessages(null)).toBe("");
    expect(stripLeakedSystemHarnessMessages(undefined)).toBe("");
    expect(isPureLeakedSystemHarnessMessage(null)).toBe(false);
    expect(isPureLeakedSystemHarnessMessage(undefined)).toBe(false);
  });

  it("strips raw leaked background task notifications", () => {
    const leaked = `The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE> [Message] timestamp=2026-10-10T18:01:21Z
sender=a3cf0f98-46dc-449c-9867-68dfa3d6d3db/task-1457
priority=MESSAGE_PRIORITY_HIGH content=Task id "a3cf0f98-46dc-449c-9867-68dfa3d6d3db/task-1457" finished with result:

The command exited with code 0. Stdout:

Stderr:

Log:
file:///Users/jsmhh/.duskbot/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32/antigravity-acp/brain/a3cf0f98-46dc-449c-9867-68dfa3d6d3db/.system_generated/tasks/task-1457.log </SYSTEM_MESSAGE>`;

    expect(stripLeakedSystemHarnessMessages(leaked)).toBe("");
    expect(isPureLeakedSystemHarnessMessage(leaked)).toBe(true);
  });

  it("preserves genuine assistant text while stripping leaked system block", () => {
    const mixed = `I've started building the feature for you.

The following is a <SYSTEM_MESSAGE> not actually sent by the user.
<SYSTEM_MESSAGE> Task id 123 finished with exit code 0 </SYSTEM_MESSAGE>

Everything compiled successfully and all tests pass!`;

    const cleaned = stripLeakedSystemHarnessMessages(mixed);
    expect(cleaned).toContain("I've started building the feature for you.");
    expect(cleaned).toContain("Everything compiled successfully and all tests pass!");
    expect(cleaned).not.toContain("<SYSTEM_MESSAGE>");
    expect(cleaned).not.toContain("Task id 123");
    expect(isPureLeakedSystemHarnessMessage(mixed)).toBe(false);
  });

  it("strips unclosed system tags during streaming / truncation", () => {
    const unclosed = `The following is a <SYSTEM_MESSAGE> not actually sent by the user.
<SYSTEM_MESSAGE> [Message] timestamp=2026-10-10T18:00:00Z task still in progress`;

    expect(stripLeakedSystemHarnessMessages(unclosed)).toBe("");
    expect(isPureLeakedSystemHarnessMessage(unclosed)).toBe(true);
  });

  it("strips an earlier-turn recap the bot copied into its reply, keeping the reply", () => {
    const recap = "[What Dusky did in an earlier turn: · tools: agents_coordinate_bots ×1 (from tool previews) · reply: I've sent Luna to check [the docs] first.]";
    expect(botTextForDisplay(`${recap}\nLuna found the prompt loop.`)).toBe("Luna found the prompt loop.");
    expect(botTextForDisplay(`Done. ${recap}`)).toBe("Done.");
    expect(botTextForDisplay(`${recap} And now the answer.`)).toBe("And now the answer.");
    expect(botTextForDisplay("[What Dusky did in an earlier turn: · reply: cut off")).toBe("");
    expect(isPureLeakedBotText(recap)).toBe(true);
    expect(isPureLeakedBotText(`${recap} And now the answer.`)).toBe(false);
    expect(isPureLeakedBotText("<SYSTEM_MESSAGE>x</SYSTEM_MESSAGE>")).toBe(true);
    const asked = "[What we did] and what you did in an earlier turn: both fine.";
    expect(botTextForDisplay(asked)).toBe(asked);
    expect(stripLeakedSystemHarnessMessages(recap)).toBe(recap);
  });

  it("recognizes Notice: and standalone preambles as pure leaked harness messages without leaving orphaned prefixes", () => {
    const noticeOnly = "Notice: This is a <SYSTEM_NOTIFICATION> background task finished.\n";
    expect(stripLeakedSystemHarnessMessages(noticeOnly)).toBe("");
    expect(isPureLeakedSystemHarnessMessage(noticeOnly)).toBe(true);

    const followingOnly = "The following is a <SYSTEM_MESSAGE> not actually sent by the user.";
    expect(stripLeakedSystemHarnessMessages(followingOnly)).toBe("");
    expect(isPureLeakedSystemHarnessMessage(followingOnly)).toBe(true);
  });

  it("filters streamed chunks for Notice preambles, case variants, mid-reply leaks, and split tags", () => {
    const filter = createSystemHarnessStreamFilter();
    const feed = (chunks: string[]) => chunks.map((chunk) => filter.push(chunk)).join("");

    // Split opening tag + lowercase variant + mid-reply leak must never flash in deltas.
    const streamed = feed([
      "Hello! ",
      "<",
      "sys",
      "tem_message>internal task done</system_message>",
      "All set.",
    ]);
    expect(streamed).toBe("Hello! All set.");

    filter.reset();
    const withNotice = feed([
      "Done.\n",
      "Notice: This is a ",
      "<SYSTEM_NOTIFICATION> internal\n",
      "<SYSTEM_NOTIFICATION>payload</SYSTEM_NOTIFICATION>\n",
      "Next step.",
    ]);
    expect(withNotice).toBe("Done.\n\nNext step.");

    // Ordinary prose starting like a preamble or containing `<` releases without dropping chars.
    filter.reset();
    const normal = feed(["The following is a ", "summary: a ", "<", " b and <div>ok</div>."]);
    expect(normal).toBe("The following is a summary: a < b and <div>ok</div>.");

    // Mid-line preamble stripped retroactively rebases so trailing text is not sliced away.
    filter.reset();
    const retroactive = feed([
      "Hi. ",
      "Notice: This is a ",
      "<SYSTEM_NOTIFICATION> hidden\n<SYSTEM_NOTIFICATION>body</SYSTEM_NOTIFICATION>",
      "After.",
    ]);
    expect(retroactive).toBe("Hi. Notice: This is a After.");
  });
});
