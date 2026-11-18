import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createLinkService } from "../apps/link-service/src/app.mjs";
import { createPhoneRelay, phoneRelayStore } from "./phone-relay.mjs";
import { createTunnelProxy, sealKeyOf, sha256hex, x25519Pair } from "./vps-link-protocol.mjs";

const linkRoot = fileURLToPath(new URL("../apps/link-service/", import.meta.url));
const OWNER = "owner-token-for-tests";
const ACCT = "0123456789abcdef0123456789abcdef";

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error("did not reach the expected state");
    await delay(20);
  }
}
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

function grantSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x;
  return {
    keys: [{ kid: "test", x }],
    grant() {
      const iat = Date.now();
      const payload = Buffer.from(JSON.stringify({ v: 1, aud: "link", acct: ACCT, iat, exp: iat + 5 * 60_000 })).toString("base64url");
      const signature = sign(null, Buffer.from(`l1.test.${payload}`), privateKey).toString("base64url");
      return `l1.test.${payload}.${signature}`;
    },
  };
}

function memoryStore() {
  let value = null;
  return { read: async () => (value ? structuredClone(value) : null), write: async (next) => { value = structuredClone(next); }, peek: () => value };
}

/** a link service, a stand-in harness that answers the sync only for the owner token, and the pieces to drive them */
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "dusk-phone-relay-"));
  const signer = grantSigner();
  const service = createLinkService({ base: "http://link.test", dataDir: join(dir, "data"), scriptPath: join(linkRoot, "install.sh"), agentPath: join(linkRoot, "agent.mjs"), trustProxy: false, grantKeys: signer.keys });
  const relayServer = createServer((req, res) => void service.handler(req, res));
  const base = `http://127.0.0.1:${await listen(relayServer)}`;
  const harness = { channels: [], rev: 1, syncs: [], seen: [], waiters: new Set() };
  const harnessServer = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const path = req.url.split("?", 1)[0];
      if (path === "/api/mobile/relay/sync") {
        if (req.headers["x-dusk-desktop-owner"] !== OWNER) return json(res, 403, { error: "only the link agent on this server" });
        const input = JSON.parse(Buffer.concat(chunks).toString());
        harness.syncs.push(input);
        if (harness.rev > input.applied || !input.wait) return json(res, 200, { rev: harness.rev, channels: harness.channels });
        const reply = () => { clearTimeout(timer); harness.waiters.delete(reply); if (!res.destroyed) json(res, 200, { rev: harness.rev, channels: harness.channels }); };
        const timer = setTimeout(reply, 200);
        harness.waiters.add(reply);
        return;
      }
      harness.seen.push({ method: req.method, path, headers: req.headers });
      json(res, 200, { ok: true, path });
    });
  });
  const harnessPort = await listen(harnessServer);
  const proxies = [];
  let relay = null;
  t.after(async () => {
    relay?.stop();
    await relay?.settled();
    await Promise.all(proxies.map((proxy) => proxy.close()));
    service.close();
    for (const server of [relayServer, harnessServer]) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    base, service, harness, signer, dir,
    change(channels) { harness.channels = channels; harness.rev += 1; for (const reply of Array.from(harness.waiters)) reply(); },
    relay(overrides = {}) {
      relay = createPhoneRelay({
        base, wanted: () => true, signedIn: () => true, linkGrant: async () => signer.grant(), label: () => "test mac",
        store: memoryStore(), loadHub: () => import("../apps/link-service/agent.mjs"),
        port: () => harnessPort, ownerToken: () => OWNER, checkMs: 50, retryMs: [50], ...overrides,
      });
      return relay;
    },
    async phone(channel, key, token) {
      const proxy = createTunnelProxy({ base, id: channel, route: `${base}/v1/channels/${channel}`, key: key.toString("base64url"), token, replyTimeoutMs: 5000 });
      proxies.push(proxy);
      const origin = new URL(await proxy.start());
      return (path, init = {}) => fetch(`${origin.origin}${path}`, { ...init, signal: AbortSignal.timeout(8000) });
    },
  };
}

test("a signed-in computer makes its own tunnel and serves a paired phone end to end, as a remote client", async (t) => {
  const f = await fixture(t);
  const store = memoryStore();
  const relay = f.relay({ store });
  relay.start();
  await until(() => f.harness.syncs.length > 0);
  const { pub, tunnel } = f.harness.syncs[0];
  assert.match(tunnel, /^[a-z2-7]{10}$/);
  assert.equal(f.service.store.tunnels.get(tunnel)?.acct !== undefined, true, "the tunnel belongs to the account that granted it");
  assert.equal(store.peek().tunnel.id, tunnel);
  assert.equal(store.peek().keys.pub, pub);

  const phone = x25519Pair(), token = randomBytes(32).toString("base64url"), channel = "phoneaaaaa";
  f.change([{ id: channel, kind: "device", pub: phone.pub, verifier: sha256hex(token) }]);
  assert.equal((await relay.ready(5000)).status, "ready");
  await until(() => f.service.store.channels.has(channel));

  const get = await f.phone(channel, sealKeyOf(phone.priv, phone.pub, pub, channel), token);
  const answer = await get("/api/auth/session", { headers: { authorization: "Bearer dusk_sess_phone", "x-dusk-desktop-owner": OWNER, cookie: "a=b" } });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { ok: true, path: "/api/auth/session" });
  const seen = f.harness.seen.at(-1);
  assert.equal(seen.headers.authorization, "Bearer dusk_sess_phone");
  assert.equal(seen.headers["x-dusk-desktop-owner"], undefined, "a phone can never carry the owner token");
  assert.equal(seen.headers.cookie, undefined);
  assert.match(seen.headers["x-forwarded-for"], /^198\.51\.100\./, "every phone request reaches the harness as remote");

  f.service.store.flush();
  const saved = readFileSync(join(f.dir, "data", "state.json"), "utf8");
  for (const secret of [token, store.peek().tunnel.token, store.peek().keys.priv]) assert.equal(saved.includes(secret), false, "the link service keeps no token or key");
});

test("a frame from anyone without the phone's key never reaches the harness", async (t) => {
  const f = await fixture(t);
  const relay = f.relay();
  relay.start();
  await until(() => f.harness.syncs.length > 0);
  const phone = x25519Pair(), token = randomBytes(32).toString("base64url"), channel = "phoneaaaab";
  f.change([{ id: channel, kind: "device", pub: phone.pub, verifier: sha256hex(token) }]);
  await relay.ready(5000);
  await until(() => f.service.store.channels.has(channel));
  const forged = await f.phone(channel, randomBytes(32), token);
  await assert.rejects(forged("/api/auth/session").then(async (response) => { if (!response.ok) throw new Error(String(response.status)); return response; }));
  assert.equal(f.harness.seen.length, 0);
});

test("without a dusk account no tunnel is made and the state says so", async (t) => {
  const f = await fixture(t);
  const relay = f.relay({ linkGrant: async () => null, signedIn: () => false });
  assert.equal((await relay.ready(200)).status, "signed-out");
  assert.equal(f.service.store.tunnels.size, 0);
  assert.equal(f.harness.syncs.length, 0);
});

test("remote access off keeps the hub down", async (t) => {
  const f = await fixture(t);
  let wanted = false;
  const relay = f.relay({ wanted: () => wanted });
  assert.equal((await relay.ready(200)).status, "off");
  assert.equal(f.harness.syncs.length, 0);
  wanted = true;
  assert.equal((await relay.ready(5000)).status, "ready");
  wanted = false;
  assert.equal((await relay.ready(200)).status, "off");
});

test("a refused tunnel says why and tries again later", async (t) => {
  const f = await fixture(t);
  f.service.store.tunnels.clear();
  const relay = f.relay({ linkGrant: async () => "l1.test.bad.grant" });
  const state = await relay.ready(500);
  assert.equal(state.status, "error");
  assert.equal(state.code, "account_required");
});

test("a tunnel the link service dropped is made again with the same phone keys", async (t) => {
  const f = await fixture(t);
  const store = memoryStore();
  const relay = f.relay({ store });
  assert.equal((await relay.ready(5000)).status, "ready");
  const first = store.peek();
  const gone = await fetch(`${f.base}/v1/tunnels/${first.tunnel.id}`, { method: "DELETE", headers: { authorization: `Bearer ${first.tunnel.token}` } });
  assert.equal(gone.status, 200);
  f.change([]);
  await until(() => store.peek().tunnel && store.peek().tunnel.id !== first.tunnel.id);
  assert.equal(store.peek().keys.pub, first.keys.pub, "phones keep the key their channels were made with");
  await until(() => relay.state().status === "ready" && f.harness.syncs.at(-1).tunnel === store.peek().tunnel.id);
});

test("the saved tunnel is encrypted and kept per workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dusk-phone-relay-store-"));
  try {
    let data = null;
    const jsonFile = () => ({ read: () => data, write: (value) => { data = value; } });
    const encryption = { available: async () => true, encrypt: async (text) => Buffer.from([...Buffer.from(text)].reverse()), decrypt: async (bytes) => ({ result: Buffer.from([...bytes].reverse()).toString() }) };
    let folder = "/data/one";
    const store = phoneRelayStore({ jsonFile, userData: dir, dataDir: () => folder, encryption });
    await store.write({ tunnel: { id: "abcdefghij", token: "secret-token" } });
    assert.equal(JSON.stringify(data).includes("secret-token"), false);
    assert.deepEqual(await store.read(), { tunnel: { id: "abcdefghij", token: "secret-token" } });
    folder = "/data/two";
    assert.equal(await store.read(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("another workspace's harness never replaces a tunnel's channels", async (t) => {
  const f = await fixture(t);
  let folder = "/data/one";
  const kept = new Map();
  const store = { read: async () => structuredClone(kept.get(folder) ?? null), write: async (value) => { kept.set(folder, structuredClone(value)); } };
  const relay = f.relay({ store, scope: () => folder });
  const phone = x25519Pair(), channel = "phoneaaaac";
  f.change([{ id: channel, kind: "device", pub: phone.pub, verifier: sha256hex("token") }]);
  assert.equal((await relay.ready(5000)).status, "ready");
  await until(() => f.service.store.channels.has(channel));
  const first = kept.get("/data/one").tunnel.id;
  folder = "/data/two";
  f.change([]);
  await until(() => kept.get("/data/two")?.tunnel && f.harness.syncs.at(-1).tunnel === kept.get("/data/two").tunnel.id && f.harness.syncs.at(-1).applied === f.harness.rev);
  assert.notEqual(kept.get("/data/two").tunnel.id, first);
  assert.equal(f.service.store.channels.get(channel)?.tunnel, first, "the first workspace's phone keeps its channel");
});
