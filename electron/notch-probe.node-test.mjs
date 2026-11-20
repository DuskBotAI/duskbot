import assert from "node:assert/strict";
import test from "node:test";
import { measureNotches, parseNotches } from "./notch-probe.mjs";

test("reads each notched display's housing from AppKit's answer, by display id", () => {
  const answer = JSON.stringify([{ id: 1, left: 771.5, right: 956.5, top: 32 }, { id: 2, left: 0, right: 0, top: 0 }]);
  assert.deepEqual(parseNotches(answer), { 1: { width: 185, height: 32 } });
});

test("an answer it cannot read measures nothing", () => {
  for (const text of ["", "nope", "{}", "null", JSON.stringify([{ id: "1", left: 1, right: 2, top: 3 }, { id: 3, left: 0, right: 900, top: 32 }])]) {
    assert.deepEqual(parseNotches(text), {});
  }
});

test("never asks AppKit off macOS, and a failed ask measures nothing", async () => {
  let asked = 0;
  assert.deepEqual(await measureNotches({ platform: "win32", run: async () => { asked++; return "[]"; } }), {});
  assert.equal(asked, 0);
  assert.deepEqual(await measureNotches({ platform: "darwin", run: async () => { throw new Error("timed out"); } }), {});
  assert.deepEqual(await measureNotches({ platform: "darwin", run: async () => JSON.stringify([{ id: 7, left: 663.5, right: 848.5, top: 32 }]) }), { 7: { width: 185, height: 32 } });
});
