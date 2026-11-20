import { describe, expect, it } from "vitest";
import { createForwardedAskGuard, FORWARDED_ASK_NOTE, forwardsAsk } from "./forwarded-ask.ts";

const CHIEF = [{ name: "Chief of Staff" }];
const ASK = "Make me a new bot called Ledger that keeps track of my monthly spending.";

describe("forwardsAsk", () => {
  it("reads a hand-off that repeats the person's ask to a teammate they did not name", () => {
    expect(forwardsAsk(ASK, "Please create a new bot called Ledger that keeps track of the person's monthly spending.", CHIEF)).toBe(true);
  });
  it("leaves a hand-off of its own work, or one to a teammate the person named, alone", () => {
    expect(forwardsAsk(ASK, "Pull last month's card statement totals from the bank app; I need them for a budget table.", CHIEF)).toBe(false);
    expect(forwardsAsk("Ask the Chief of Staff to make me a bot called Ledger.", "Make a bot called Ledger for the person.", CHIEF)).toBe(false);
    expect(forwardsAsk("ok", "ok", CHIEF)).toBe(false);
  });
});

describe("the forwarded-ask guard", () => {
  const base = { threadId: "t", chief: false, room: false, consult: false, ask: ASK, message: "Create a new bot called Ledger that keeps track of monthly spending.", targets: CHIEF };
  it("sends the first such hand-off back with what to do, and lets the next one through for ten minutes", () => {
    let now = 0;
    const guard = createForwardedAskGuard(() => now);
    expect(guard.check(base)).toBe(FORWARDED_ASK_NOTE);
    expect(guard.check(base)).toBeNull();
    now = 11 * 60_000;
    expect(guard.check(base)).toBe(FORWARDED_ASK_NOTE);
  });
  it("never stops a Chief, a room, a consult or a conversation with no ask from the person", () => {
    const guard = createForwardedAskGuard();
    expect(guard.check({ ...base, chief: true })).toBeNull();
    expect(guard.check({ ...base, room: true })).toBeNull();
    expect(guard.check({ ...base, consult: true })).toBeNull();
    expect(guard.check({ ...base, ask: undefined })).toBeNull();
  });
});
