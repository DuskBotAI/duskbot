import { describe, expect, it } from "vitest";

import type { Message } from "../store.ts";
import { ASK_FRESH_MS, createOpenAsks } from "./open-asks.ts";

function chat() {
  const rows: Message[] = [];
  let clock = 1_000_000;
  const store = {
    activePath: () => rows,
    patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => {
      const row = rows.find((one) => one.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
  };
  const say = (role: "user" | "bot", text: string) => { const row = { id: `m${rows.length + 1}`, role, kind: "text", text, at: clock } as Message; rows.push(row); return row.id; };
  return { rows, store, say, now: () => clock, tick: (ms: number) => { clock += ms; } };
}

describe("open asks", () => {
  it("closes the asks of a turn that failed, so no later turn is told to do them again", () => {
    const c = chat();
    const asks = createOpenAsks({ store: c.store, now: c.now });
    const send = c.say("user", "email the invoice to Priya");
    asks.opened("t1", send);
    asks.failed("t1");
    expect(c.rows.find((row) => row.id === send)?.ask).toEqual({ state: "blocked" });
    expect(asks.open("t1")).toEqual([]);
    expect(asks.note("t1")).toBe("");
  });

  it("opens each ask once, settles it with what the turn did, and keeps its state on the message row across a restart", () => {
    const c = chat();
    const asks = createOpenAsks({ store: c.store, now: c.now });
    const list = c.say("user", "write a packing list for mumbai");
    const weather = c.say("user", "also what's the weather there in july?");
    asks.opened("t1", list);
    asks.opened("t1", list);
    asks.opened("t1", weather);
    expect(asks.open("t1").map((ask) => ask.id)).toEqual([list, weather]);

    expect(asks.settle("t1", { said: ["Packing list for Mumbai: shirts, umbrella, charger."], scheduled: false, handedOff: false })).toEqual(["also what's the weather there in july?"]);
    expect(c.rows.find((row) => row.id === list)?.ask).toEqual({ state: "delivered" });

    asks.nudged("t1");
    const restarted = createOpenAsks({ store: c.store, now: c.now });
    expect(restarted.open("t1")).toEqual([{ id: weather, text: "also what's the weather there in july?", state: "open" }]);
    expect(restarted.note("t1")).toBe('Open items: "also what\'s the weather there in july?"\n\n');
    expect(restarted.note("t1", weather)).toBe("");
    // sent back for once already: never again
    expect(restarted.settle("t1", { said: ["On it."], scheduled: false, handedOff: false })).toEqual([]);
    expect(restarted.settle("t1", { said: ["Which part of Mumbai?"], scheduled: false, handedOff: false })).toEqual([]);
    expect(c.rows.find((row) => row.id === weather)?.ask).toEqual({ state: "blocked", nudged: true });
  });

  it("the person's stop drops what is open, and old asks are neither counted nor shown", () => {
    const c = chat();
    const asks = createOpenAsks({ store: c.store, now: c.now });
    const first = c.say("user", "a 2000 word history of the printing press");
    asks.opened("t1", first);
    asks.dropped("t1");
    expect(c.rows[0]!.ask).toEqual({ state: "dropped" });
    expect(asks.open("t1")).toEqual([]);

    const later = c.say("user", "find me a plumber");
    asks.opened("t1", later);
    c.tick(ASK_FRESH_MS + 1);
    expect(asks.open("t1")).toEqual([]);
    expect(asks.note("t1")).toBe("");
  });

  it("leaves bot rows and wordless rows alone", () => {
    const c = chat();
    const asks = createOpenAsks({ store: c.store, now: c.now });
    asks.opened("t1", c.say("bot", "hello"));
    asks.opened("t1", c.say("user", "   "));
    expect(c.rows.every((row) => row.ask === undefined)).toBe(true);
  });
});

describe("open asks and work handed on", () => {
  it("an ask whose chat still has teammates working for it is waiting, even when the engine never reported the call", () => {
    const rows: Message[] = [{ id: "m1", role: "user", kind: "text", text: "fetch my mail settings", at: 1 } as Message];
    const store = { activePath: () => rows, patchMessage: (_t: string, id: string, patch: Partial<Message>) => Object.assign(rows.find((one) => one.id === id)!, patch) };
    const asks = createOpenAsks({ store, handedOff: () => true, now: () => 2 });
    asks.opened("t1", "m1");
    expect(asks.settle("t1", { said: ["Asked two teammates."], scheduled: false, handedOff: false })).toEqual([]);
    expect(rows[0]!.ask).toEqual({ state: "waiting" });
  });
});
