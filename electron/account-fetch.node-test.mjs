import assert from "node:assert/strict";
import test from "node:test";
import { chromiumFirstFetch } from "./account-fetch.mjs";

test("uses the browser stack when it connects", async () => {
  const calls = [];
  const fetcher = chromiumFirstFetch(async url => { calls.push("chromium"); return { ok: true, url }; }, async () => { calls.push("node"); return { ok: true }; });
  assert.equal((await fetcher("https://dusk.bot/x", {})).url, "https://dusk.bot/x");
  assert.deepEqual(calls, ["chromium"]);
});

test("falls back to node's stack when the browser stack cannot connect", async () => {
  const fetcher = chromiumFirstFetch(async () => { throw new TypeError("net::ERR_PROXY_CONNECTION_FAILED"); }, async () => ({ ok: true, via: "node" }));
  assert.equal((await fetcher("https://dusk.bot/x")).via, "node");
});

test("a timeout or cancel is final, not retried", async () => {
  let nodeCalls = 0;
  const node = async () => { nodeCalls++; return {}; };
  await assert.rejects(chromiumFirstFetch(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }, node)("u", {}));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(chromiumFirstFetch(async () => { throw new TypeError("x"); }, node)("u", { signal: controller.signal }));
  assert.equal(nodeCalls, 0);
});

test("both stacks failing surfaces the error", async () => {
  const fetcher = chromiumFirstFetch(async () => { throw new TypeError("a"); }, async () => { throw new TypeError("b"); });
  await assert.rejects(fetcher("u"), /b/);
});
