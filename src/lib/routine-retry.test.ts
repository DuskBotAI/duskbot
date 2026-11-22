import { describe, expect, it } from "vitest";
import { routineRetryFor } from "./routine-retry";

const routines = [{ id: "r1", name: "Inbox check", enabled: true }, { id: "r2", name: "Provider failure example", enabled: false }];

describe("routineRetryFor", () => {
  it("runs a marked routine line's routine again", () => {
    expect(routineRetryFor({ role: "user", text: "anything", routineStart: { name: "Inbox check", routineId: "r1" } }, routines))
      .toEqual({ state: "ready", routineId: "r1", name: "Inbox check" });
  });

  it("knows an older line's routine from its prompt's header, and offers no retry while it is paused", () => {
    const text = '[Routine "Provider failure example", do this now:]\nTrigger id: r2\nCheck the provider.';
    expect(routineRetryFor({ role: "user", text }, routines)).toEqual({ state: "paused", routineId: "r2", name: "Provider failure example" });
  });

  it("says a removed routine is gone, and leaves a webhook run's line without a routine to run", () => {
    expect(routineRetryFor({ role: "user", text: "x", routineStart: { name: "Old", routineId: "gone" } }, routines)).toEqual({ state: "gone", name: "Old" });
    expect(routineRetryFor({ role: "user", text: "payload", routineStart: { name: "Orders hook" } }, routines)).toEqual({ state: "event", name: "Orders hook" });
  });

  it("leaves a person's own line to the ordinary retry", () => {
    expect(routineRetryFor({ role: "user", text: "check the inbox" }, routines)).toBeNull();
    expect(routineRetryFor(undefined, routines)).toBeNull();
  });
});
