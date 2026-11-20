import { describe, expect, it } from "vitest";
import { REPEAT_HINT, withRepeatHint } from "./repeat-hint.ts";

const done = { text: "Created the schedule trigger." };
const once = { type: "once", at: "2026-11-20T09:45:00+05:30" };

describe("the repeat offer on a one-time reminder", () => {
  it("is asked for when the reminder is for something that comes back", () => {
    for (const name of ["Post standup notes", "Pay rent", "Weekly report", "Gym at 7", "Take vitamins"]) {
      expect(withRepeatHint(done, { name, instructions: "Remind the person.", schedule: once }).text, name).toContain(REPEAT_HINT);
    }
  });
  it("is not asked for a one-off, a repeating schedule or a failed create", () => {
    expect(withRepeatHint(done, { name: "Call the dentist", instructions: "Remind them to call.", schedule: once })).toEqual(done);
    expect(withRepeatHint(done, { name: "Post standup notes", instructions: "x", schedule: { type: "weekly" } })).toEqual(done);
    const failed = { text: "did not apply", isError: true };
    expect(withRepeatHint(failed, { name: "Pay rent", instructions: "x", schedule: once })).toBe(failed);
  });
});
