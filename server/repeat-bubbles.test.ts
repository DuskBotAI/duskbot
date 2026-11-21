import { describe, expect, it } from "vitest";

import { repeatedBubble } from "./repeat-bubbles.ts";

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const bot = (text: string, at: number) => ({ role: "bot" as const, kind: "text" as const, text, at });
const person = (text: string, at: number) => ({ role: "user" as const, kind: "text" as const, text, at });

describe("repeatedBubble", () => {
  it("drops the same words the bot said moments ago when nobody wrote since", () => {
    expect(repeatedBubble([person("book it", T0), bot("On it, booking now.", T0 + MIN)], "On it — booking now", T0 + 2 * MIN)).toBe(true);
    expect(repeatedBubble([person("hi", T0), bot("Done: the table is booked for 8pm.", T0), { role: "bot", kind: "activity", text: "", at: T0 + MIN }], "Done: the table is booked for 8pm.", T0 + 3 * MIN)).toBe(true);
  });

  it("keeps it when the person wrote after it, when it is older than ten minutes, or when it differs", () => {
    expect(repeatedBubble([bot("The total is 42.", T0), person("what was the total again?", T0 + MIN)], "The total is 42.", T0 + 2 * MIN)).toBe(false);
    expect(repeatedBubble([bot("On it.", T0)], "On it.", T0 + 11 * MIN)).toBe(false);
    expect(repeatedBubble([bot("On it.", T0)], "Done.", T0 + MIN)).toBe(false);
    expect(repeatedBubble([], "On it.", T0)).toBe(false);
  });
});
