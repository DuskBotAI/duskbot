import { describe, expect, it } from "vitest";
import { composerPlaceholder } from "./composer-simple";

const base = { locked: false, approval: false, attaching: false, listening: false, replying: false, busy: false, members: [], goal: false, botName: "Pip", setupHint: null, question: true };

describe("the composer's hint while a question waits", () => {
  it("says it answers the question or talks past it where there is room", () => {
    expect(composerPlaceholder(base)).toBe("Type your answer, or talk about something else");
  });

  it("keeps to a hint that fits a phone's field", () => {
    expect(composerPlaceholder({ ...base, narrow: true })).toBe("Type your answer");
  });
});

describe("the composer's hint while an approval waits", () => {
  const approval = { ...base, question: false, approval: true };
  it("points at the approval in full where there is room, and in two words on a phone", () => {
    expect(composerPlaceholder(approval)).toBe("Answer the approval above");
    expect(composerPlaceholder({ ...approval, narrow: true })).toBe("Answer above");
  });
});

describe("the composer's hint with a file attached", () => {
  const attached = { ...base, question: false, attached: true };
  it("asks for a message or a send where there is room", () => {
    expect(composerPlaceholder(attached)).toBe("Add a message, or hit send");
  });

  it("keeps to the bot's name on a phone, where the longer hint is cut off", () => {
    expect(composerPlaceholder({ ...attached, narrow: true })).toBe("Message Pip");
  });
});
