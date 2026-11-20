import { describe, expect, it } from "vitest";

import { sanitizeInput } from "./routine-input.ts";
import type { RoutineInput } from "./routines.ts";

const status = (input: unknown) => {
  try {
    sanitizeInput(input as RoutineInput, Date.now());
    return "accepted";
  } catch (error) {
    return { status: (error as { status?: number }).status, message: (error as Error).message };
  }
};

describe("sanitizeInput", () => {
  it("answers a routine it can't keep with 400 and the reason, whatever the body", () => {
    expect(status(null)).toEqual({ status: 400, message: "Give the routine a name" });
    expect(status([])).toEqual({ status: 400, message: "Give the routine a name" });
    expect(status({ name: "Morning" })).toEqual({ status: 400, message: "Tell the bot what to do" });
    expect(status({ name: "Morning", prompt: "Check mail", botId: "b1", overlap: "both" })).toMatchObject({ status: 400 });
  });
});
