import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createCloudAccountClient } from "./cloud-account.mjs";

const accessToken = `omc_${"T".repeat(43)}`;

async function fixture(t) {
  const f = { setup: undefined, now: Date.now(), delay: null };
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drained */ }
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/cloud/desktop/session") return send(200, { cloudContractVersion: 1, expiresAt: Date.now() + 86_400_000, device: { id: "device" }, account: { id: "account", email: "person@example.test" },
      entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 }, ...(f.setup === undefined ? {} : { websiteSetup: f.setup }) });
    send(404, { error: "not_found" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let saved = { origin, token: accessToken, expiresAt: Date.now() + 86_400_000, device: { id: "device" }, account: { id: "account", email: "person@example.test" } };
  f.client = createCloudAccountClient({ origin, fixture: true, platform: "darwin", deviceName: "Fixture Mac", appVersion: "1.0.0",
    store: { async read() { return saved; }, async write(value) { saved = value; } }, async openBrowser() {}, now: () => f.now,
    setTimer: (_callback, delay) => { f.delay = delay; return 1; }, clearTimer: () => { f.delay = null; } });
  t.after(() => f.client.close?.());
  return f;
}

test("the website's first steps show on the account while open, then as where they put the bots", async t => {
  const f = await fixture(t);
  f.setup = "open";
  assert.equal((await f.client.start()).websiteSetup, "open");
  f.setup = "free";
  assert.equal((await f.client.refresh()).websiteSetup, "free");
  f.setup = "cloud";
  assert.equal((await f.client.refresh()).websiteSetup, "cloud");
});

test("an older Admin, or an account set up before, says nothing, and anything unknown is dropped", async t => {
  const f = await fixture(t);
  assert.equal("websiteSetup" in (await f.client.start()), false);
  f.setup = "somewhere";
  assert.equal("websiteSetup" in (await f.client.refresh()), false);
});

test("open first steps are followed every 3 s for half an hour, then every minute until the person opens them again", async t => {
  const f = await fixture(t);
  f.setup = "open";
  await f.client.start();
  assert.equal(f.delay, 3_000);
  f.now += 29 * 60_000; await f.client.refresh();
  assert.equal(f.delay, 3_000);
  f.now += 2 * 60_000; await f.client.refresh();
  assert.equal(f.delay, 60_000, "a person who never finishes them is not asked for every 3 s");
  f.setup = "free"; await f.client.refresh();
  f.setup = "open"; await f.client.refresh();
  assert.equal(f.delay, 3_000, "open again: followed closely again");
});
