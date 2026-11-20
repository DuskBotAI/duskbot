import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLinkService, sha256hex } from "../src/app.mjs";
import { MAX_CHANNELS_PER_TUNNEL, PHONE_TUNNEL_IDLE_MS, TUNNEL_IDLE_MS } from "../src/store.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const id = "abcdefghij", other = "klmnopqrst", cid = "phoneaaaaa", second = "phoneaaaab";
const vps = "v".repeat(43), app = "a".repeat(43), phone = "p".repeat(43), wrong = "w".repeat(43);
const lookupId = "a".repeat(32), epoch = "e".repeat(12);
let service, server, base, dir, time;

function makeService() {
  return createLinkService({ base: "http://link.test", dataDir: dir, scriptPath: join(root, "install.sh"), agentPath: join(root, "agent.mjs"), trustProxy: false, now: () => time,
    // roomy tunnel limits: these tests are about the phone channel's own (relay-guards.test.mjs covers the tunnel's)
    limits: { perTunnelBytesPerSec: 64 * 1024 * 1024, burstBytes: 256 * 1024 * 1024, globalCeilingBytesPerSec: 64 * 1024 * 1024, accountBytesPerSec: 64 * 1024 * 1024 } });
}
function tunnel(tid = id) {
  service.store.tunnels.set(tid, { id: tid, createdAt: time, vpsVerifier: sha256hex(vps), appVerifier: sha256hex(app), seenAt: null });
}
beforeEach(async () => {
  time = Date.now();
  dir = mkdtempSync(join(tmpdir(), "omb-mobile-channels-"));
  service = makeService();
  tunnel();
  server = createServer((req, res) => void service.handler(req, res));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  service.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const request = (path, token, method = "GET", body) => fetch(`${base}${path}`, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const device = (channel = cid, token = phone) => ({ id: channel, verifier: sha256hex(token), kind: "device" });
const put = (channels = [device()], tid = id, token = vps) => request(`/v1/tunnels/${tid}/channels`, token, "PUT", { channels });
const post = (frames = ["aaaa"], channel = cid, extra = {}) => request(`/v1/channels/${channel}/to-vps`, phone, "POST", { frames, ...extra });
const take = () => request(`/v1/tunnels/${id}/channels/to-vps`, vps).then((res) => res.json());
const createLookup = (body = {}) => request("/v1/lookups", null, "POST", { id: lookupId, sealed: "sealed", ttlS: 30, ...body });

async function stream(path, token) {
  const response = await request(`${path}?wait=20&stream=1`, token);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^application\/x-ndjson/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  async function* lines() {
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      text += decoder.decode(value, { stream: true });
      let end;
      while ((end = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, end);
        text = text.slice(end + 1);
        if (line) yield JSON.parse(line);
      }
    }
  }
  return lines();
}
const next = async (lines) => (await lines.next()).value;
const ended = async (lines) => expect((await lines.next()).done).toBe(true);

describe("mobile channel registration", () => {
  it("validates the entire set before changing it", async () => {
    expect(await (await put()).json()).toEqual({ ok: true, channels: 1 });
    for (const body of [null, {}, { channels: null }, { channels: [device(), device()] }, { channels: [{ ...device(), id: "bad" }] },
      { channels: [{ ...device(), verifier: "bad" }] }, { channels: [{ ...device(), kind: "bad" }] },
      { channels: [{ ...device(), expiresAt: time + 1000 }] }, { channels: [{ ...device(), kind: "grant" }] },
      { channels: [{ ...device(), kind: "grant", expiresAt: time }] }, { channels: [{ ...device(), kind: "grant", expiresAt: time + 86_400_001 }] },
      { channels: [{ ...device(), kind: "grant", expiresAt: time + 0.5 }] }]) {
      expect((await request(`/v1/tunnels/${id}/channels`, vps, "PUT", body)).status).toBe(400);
      expect(service.store.channels.size).toBe(1);
    }
    const list = Array.from({ length: MAX_CHANNELS_PER_TUNNEL + 1 }, (_, i) => device(`phoneaaaa${String.fromCharCode(97 + i % 26)}`));
    expect((await put(list)).status).toBe(400);
    expect((await put([device(cid), device(second)])).status).toBe(200);
    expect(service.store.channels.get(cid)).toMatchObject({ tunnel: id, kind: "device", expiresAt: null, createdAt: time, seenAt: null });
  });

  it("requires the VPS bearer and hides missing tunnels", async () => {
    for (const token of [null, wrong, app, phone]) expect((await put([device()], id, token)).status).toBe(404);
    expect((await put([device()], other)).status).toBe(404);
    expect(service.store.channels.size).toBe(0);
  });

  it("moves a phone's channel to another tunnel of the same account only with the same phone credential", async () => {
    tunnel(other);
    service.store.tunnels.get(id).acct = "acct-a";
    service.store.tunnels.get(other).acct = "acct-a";
    await put([device(second)], other);
    expect((await put([device(second, wrong)])).status).toBe(409);
    expect((await put([device(second)])).status).toBe(200);
    expect(service.store.channels.get(second).tunnel).toBe(id);
    service.store.tunnels.get(other).acct = "acct-b";
    await put([device("phoneaaaac")], other);
    expect((await put([device("phoneaaaac")])).status).toBe(409);
  });

  it("refuses tunnel, session and another tunnel's channel ids atomically", async () => {
    tunnel(other);
    await put();
    await put([device(second)], other);
    service.store.sessions.set("sessionaaa", { id: "sessionaaa" });
    for (const taken of [id, other, second, "sessionaaa"]) {
      const response = await put([device("phoneaaaac"), device(taken)]);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "taken", id: taken });
      expect(service.store.channels.has(cid)).toBe(true);
      expect(service.store.channels.has("phoneaaaac")).toBe(false);
      expect(service.store.channels.get(second).tunnel).toBe(other);
    }
  });

  it("saves channels and reloads them in a new service", async () => {
    await put([{ ...device(), kind: "grant", expiresAt: time + 30_000 }, device(second)]);
    service.close();
    const saved = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    expect(saved.channels).toHaveLength(2);
    expect(JSON.stringify(saved)).not.toContain(phone);
    service = makeService();
    expect(service.store.channels.get(cid)).toEqual(saved.channels.find((channel) => channel.id === cid));
    expect((await post()).status).toBe(200);
  });
});

describe("mobile channel frames", () => {
  it("streams channel batches to the VPS after an empty liveness line", async () => {
    await put();
    await post(["aaaa"]);
    const lines = await stream(`/v1/tunnels/${id}/channels/to-vps`, vps);
    expect(await next(lines)).toEqual({ frames: [] });
    expect(await next(lines)).toEqual({ channel: cid, frames: ["aaaa"] });
    await post(["bbbb"]);
    expect(await next(lines)).toEqual({ channel: cid, frames: ["bbbb"] });
    await request(`/v1/tunnels/${id}`, vps, "DELETE");
    await ended(lines);
  });

  it("streams VPS frames to the phone and tracks phone reads", async () => {
    await put();
    const lines = await stream(`/v1/channels/${cid}/to-app`, phone);
    expect(await next(lines)).toEqual({ frames: [] });
    expect(service.store.channels.get(cid).seenAt).toBe(time);
    await request(`/v1/tunnels/${id}/channels/${cid}/to-app`, vps, "POST", { frames: ["bbbb"], epoch, seq: 1 });
    await request(`/v1/tunnels/${id}/channels/${cid}/to-app`, vps, "POST", { frames: ["aaaa"], epoch, seq: 0 });
    expect(await next(lines)).toEqual({ frames: ["aaaa", "bbbb"] });
    await request(`/v1/channels/${cid}`, phone, "DELETE");
    await ended(lines);
  });

  it("keeps each phone's frames separate from other phones and the Mac", async () => {
    await put([device(), device(second)]);
    await request(`/v1/tunnels/${id}/to-vps`, app, "POST", { frames: ["mac"] });
    await post(["bbbb"], cid, { epoch, seq: 1 });
    await post(["cccc"], second);
    await post(["aaaa"], cid, { epoch, seq: 0 });
    expect(await take()).toEqual({ batches: [{ channel: cid, frames: ["aaaa", "bbbb"] }, { channel: second, frames: ["cccc"] }] });
    expect(await take()).toEqual({ batches: [] });
    expect(await (await request(`/v1/tunnels/${id}/to-vps`, vps)).json()).toEqual({ frames: ["mac"] });
  });

  it("takes channel batches round robin while a busy channel has more", async () => {
    await put([device(), device(second)]);
    await post(Array(256).fill("aaaa"));
    await post(["bbbb"]);
    await post(["cccc"], second);
    const lines = await stream(`/v1/tunnels/${id}/channels/to-vps`, vps);
    expect(await next(lines)).toEqual({ frames: [] });
    expect((await next(lines)).frames).toHaveLength(256);
    expect(await next(lines)).toEqual({ channel: second, frames: ["cccc"] });
    expect(await next(lines)).toEqual({ channel: cid, frames: ["bbbb"] });
    await request(`/v1/tunnels/${id}`, vps, "DELETE");
    await ended(lines);
  });

  it("wakes an aggregated long poll on a channel post", async () => {
    await put();
    const waiting = request(`/v1/tunnels/${id}/channels/to-vps?wait=2`, vps);
    await post();
    expect(await (await waiting).json()).toEqual({ batches: [{ channel: cid, frames: ["aaaa"] }] });
  });

  it("hands aggregated and phone streams to the newest reader", async () => {
    await put();
    for (const [path, token] of [[`/v1/tunnels/${id}/channels/to-vps`, vps], [`/v1/channels/${cid}/to-app`, phone]]) {
      const older = await stream(path, token);
      expect(await next(older)).toEqual({ frames: [] });
      const newer = await stream(path, token);
      expect(await next(newer)).toEqual({ frames: [] });
      await ended(older);
      if (token === vps) {
        await post();
        expect(await next(newer)).toEqual({ channel: cid, frames: ["aaaa"] });
        await put([]);
      } else {
        await request(`/v1/tunnels/${id}/channels/${cid}/to-app`, vps, "POST", { frames: ["aaaa"] });
        expect(await next(newer)).toEqual({ frames: ["aaaa"] });
      }
      await request(`/v1/tunnels/${id}`, vps, "DELETE");
      await ended(newer);
      tunnel();
      await put();
    }
  });

  it("hides channels from wrong tokens and from other tunnels", async () => {
    tunnel(other);
    await put();
    for (const path of [`/v1/channels/${cid}/to-app`, `/v1/tunnels/${id}/channels/to-vps`]) {
      const response = await request(path, wrong);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not found", code: "not_found" });
    }
    expect((await request(`/v1/channels/${cid}/to-vps`, wrong, "POST", { frames: ["aaaa"] })).status).toBe(404);
    expect((await request(`/v1/channels/${cid}`, wrong, "DELETE")).status).toBe(404);
    expect((await request(`/v1/tunnels/${other}/channels/${cid}/to-app`, vps, "POST", { frames: ["aaaa"] })).status).toBe(404);
  });

  it("validates frames in both directions and reports full queues", async () => {
    await put();
    for (const [path, token] of [[`/v1/channels/${cid}/to-vps`, phone], [`/v1/tunnels/${id}/channels/${cid}/to-app`, vps]]) {
      for (const frames of [null, [], [42], ["has space"], Array(257).fill("aaaa"), ["a".repeat(1024 * 1024 + 65)]]) {
        expect((await request(path, token, "POST", { frames })).status).toBe(400);
      }
      for (let i = 0; i < 4; i += 1) expect((await request(path, token, "POST", { frames: Array(256).fill("aaaa") })).status).toBe(200);
      const full = await request(path, token, "POST", { frames: ["aaaa"] });
      expect(full.status).toBe(429);
      expect(await full.json()).toMatchObject({ code: "queue_full" });
    }
  });
});

describe("mobile channel lifetime", () => {
  it("revokes omitted channels, ends their streams and drops both queues", async () => {
    await put();
    const lines = await stream(`/v1/channels/${cid}/to-app`, phone);
    expect(await next(lines)).toEqual({ frames: [] });
    await post();
    await put([]);
    await ended(lines);
    expect((await request(`/v1/channels/${cid}/to-app`, phone)).status).toBe(404);
    await put();
    expect(await take()).toEqual({ batches: [] });
    expect(await (await request(`/v1/channels/${cid}/to-app`, phone)).json()).toEqual({ frames: [] });
  });

  it("rotates a verifier, ends old reads and discards queued frames", async () => {
    await put();
    const lines = await stream(`/v1/channels/${cid}/to-app`, phone);
    expect(await next(lines)).toEqual({ frames: [] });
    await post();
    await put([device(cid, wrong)]);
    await ended(lines);
    expect((await request(`/v1/channels/${cid}/to-app`, phone)).status).toBe(404);
    expect((await request(`/v1/channels/${cid}/to-app`, wrong)).status).toBe(200);
    expect(await take()).toEqual({ batches: [] });
  });

  it("lets a phone forget only its own channel", async () => {
    await put([device(), device(second)]);
    await post();
    expect(await (await request(`/v1/channels/${cid}`, phone, "DELETE")).json()).toEqual({ ok: true });
    expect(service.store.channels.has(cid)).toBe(false);
    expect(service.store.channels.has(second)).toBe(true);
    expect(await take()).toEqual({ batches: [] });
  });

  it("deletes a tunnel's channels and ends both kinds of stream", async () => {
    tunnel(other);
    await put([device(), device(second)]);
    await put([device("phoneaaaac")], other);
    const phoneLines = await stream(`/v1/channels/${cid}/to-app`, phone);
    const vpsLines = await stream(`/v1/tunnels/${id}/channels/to-vps`, vps);
    await next(phoneLines); await next(vpsLines);
    expect((await request(`/v1/tunnels/${id}`, app, "DELETE")).status).toBe(200);
    await ended(phoneLines); await ended(vpsLines);
    expect([...service.store.channels.keys()]).toEqual(["phoneaaaac"]);
  });

  it("expires grants at the injected clock and sweeps orphans", async () => {
    await put([{ ...device(), kind: "grant", expiresAt: time + 30_000 }, device(second)]);
    const lines = await stream(`/v1/channels/${cid}/to-app`, phone);
    await next(lines);
    time += 30_000;
    expect((await request(`/v1/channels/${cid}/to-app`, phone)).status).toBe(404);
    await ended(lines);
    expect(service.store.channels.has(cid)).toBe(false);
    service.store.tunnels.delete(id);
    service.store.sweep();
    expect(service.store.channels.size).toBe(0);
  });

  it("sweeps expired grants and wakes their readers", async () => {
    await put([{ ...device(), kind: "grant", expiresAt: time + 30_000 }]);
    const lines = await stream(`/v1/channels/${cid}/to-app`, phone);
    await next(lines);
    time += 30_000;
    service.store.sweep();
    await ended(lines);
    expect(service.store.channels.size).toBe(0);
  });
});

describe("mobile channel rate limits", () => {
  it("allows a burst of 400 posts and refills at 50 per second", async () => {
    await put([device(), device(second)]);
    for (let i = 0; i < 400; i += 1) expect((await post()).status).toBe(200);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
    expect((await post(["aaaa"], second)).status).toBe(200);
    time += 20;
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
  });

  it("limits phone reads to 600 per minute", async () => {
    await put();
    for (let i = 0; i < 600; i += 1) expect((await request(`/v1/channels/${cid}/to-app`, phone)).status).toBe(200);
    const limited = await request(`/v1/channels/${cid}/to-app`, phone);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
    time += 60_000;
    expect((await request(`/v1/channels/${cid}/to-app`, phone)).status).toBe(200);
  });

  it("limits frame text to 256 MiB per rolling minute", async () => {
    await put();
    const frames = Array(3).fill("a".repeat(1024 * 1024));
    // 200 ms apart, under the roomy tunnel rate above, so only the channel's own minute total stops it
    for (let i = 0; i < 85; i += 1) { expect((await post(frames)).status).toBe(200); await take(); time += 200; }
    expect((await post([frames[0]])).status).toBe(200);
    await take();
    const limited = await post(["a"]);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
    time += 60_000;
    await take();
    expect((await post()).status).toBe(200);
  });
});

describe("a server that is not reading its channels", () => {
  it("answers a phone's frames at once instead of holding them, from a short while after its last read", async () => {
    await put();
    expect((await post()).status).toBe(200);
    time += 25_000;
    const away = await post();
    expect(away.status).toBe(503);
    expect(await away.json()).toMatchObject({ code: "server_away" });
    await take();
    expect((await post()).status).toBe(200);
  });

  it("counts a server in the middle of a long read as there, however long it has waited", async () => {
    await put();
    const lines = await stream(`/v1/tunnels/${id}/channels/to-vps`, vps);
    expect(await next(lines)).toEqual({ frames: [] });
    time += 60_000;
    expect((await post()).status).toBe(200);
    expect(await next(lines)).toMatchObject({ channel: cid, frames: ["aaaa"] });
  });
});

describe("typed-code lookups", () => {
  it("creates, reads, refuses duplicates and expires a lookup", async () => {
    const made = await createLookup();
    expect(made.status).toBe(201);
    expect(await made.json()).toEqual({ ok: true, expiresAt: time + 30_000 });
    expect(await (await request(`/v1/lookups/${lookupId}`)).json()).toEqual({ sealed: "sealed", expiresAt: time + 30_000 });
    const taken = await createLookup();
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: "taken" });
    expect((await request(`/v1/lookups/${"b".repeat(32)}`)).status).toBe(404);
    time += 30_000;
    expect((await request(`/v1/lookups/${lookupId}`)).status).toBe(404);
    expect((await createLookup()).status).toBe(201);
  });

  it("validates ids, sealed text, TTL and optional delete verifiers", async () => {
    for (const body of [{ id: "A".repeat(32) }, { id: "short" }, { sealed: "" }, { sealed: "has spaces" }, { sealed: "a".repeat(16_385) },
      { ttlS: 29 }, { ttlS: 901 }, { ttlS: 30.5 }, { deleteVerifier: "bad" }, { deleteVerifier: null }]) {
      expect((await createLookup(body)).status).toBe(400);
    }
    expect((await createLookup({ sealed: "a".repeat(16_384), ttlS: 900 })).status).toBe(201);
  });

  it("rate limits misses after 240 in an hour, with live lookups still readable", async () => {
    await createLookup({ ttlS: 900 });
    const missing = `/v1/lookups/${"b".repeat(32)}`;
    for (let i = 0; i < 240; i += 1) expect((await request(missing)).status).toBe(404);
    const limited = await request(missing);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
    expect((await request(`/v1/lookups/${lookupId}`)).status).toBe(200);
    time += 3_600_000;
    expect((await request(missing)).status).toBe(404);
  });

  it("rate limits creations to 120 per IP per hour", async () => {
    for (let i = 0; i < 120; i += 1) expect((await createLookup({ id: i.toString(16).padStart(32, "0") })).status).toBe(201);
    const limited = await createLookup();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
    time += 3_600_000;
    service.store.sweep();
    expect((await createLookup()).status).toBe(201);
  });

  it("allows deletion only with the optional delete token", async () => {
    await createLookup({ deleteVerifier: sha256hex(phone) });
    expect((await request(`/v1/lookups/${lookupId}`, wrong, "DELETE")).status).toBe(404);
    expect((await request(`/v1/lookups/${lookupId}`, null, "DELETE")).status).toBe(404);
    expect(await (await request(`/v1/lookups/${lookupId}`, phone, "DELETE")).json()).toEqual({ ok: true });
    expect((await request(`/v1/lookups/${lookupId}`)).status).toBe(404);
    await createLookup();
    expect((await request(`/v1/lookups/${lookupId}`, phone, "DELETE")).status).toBe(404);
  });

  it("never persists lookup payloads across a restart", async () => {
    await createLookup();
    await put();
    service.close();
    expect(readFileSync(join(dir, "state.json"), "utf8")).not.toContain("sealed");
    service = makeService();
    expect((await request(`/v1/lookups/${lookupId}`)).status).toBe(404);
    expect((await request(`/v1/channels/${cid}/to-app`, phone)).status).toBe(200);
  });
});

describe("tunnel retention", () => {
  it("drops a tunnel whose server stayed silent past the idle limit, with its channels and readers", async () => {
    tunnel(other);
    await put();
    time += PHONE_TUNNEL_IDLE_MS - 1000;
    expect((await request(`/v1/tunnels/${other}/to-vps`, vps)).status).toBe(200);
    const lines = await stream(`/v1/channels/${cid}/to-app`, phone);
    await next(lines);
    time += 2000;
    service.store.sweep();
    await ended(lines);
    expect(service.store.tunnels.has(id)).toBe(false);
    expect(service.store.tunnels.has(other)).toBe(true);
    expect(service.store.channels.size).toBe(0);
    expect((await request(`/v1/tunnels/${id}/to-vps`, vps)).status).toBe(404);
  });

  it("keeps a tunnel with paired phones past a week off, so its phones are not told they were removed", async () => {
    tunnel(other);
    await put();
    expect((await put([{ id: second, verifier: sha256hex(phone), kind: "grant", expiresAt: time + 60_000 }], other)).status).toBe(200);
    time += TUNNEL_IDLE_MS + 60_000;
    service.store.sweep();
    expect(service.store.tunnels.has(id)).toBe(true);
    expect(service.store.tunnels.has(other)).toBe(false);
    const meanwhile = await request(`/v1/channels/${cid}/to-vps`, phone, "POST", { frames: ["aaaa"], epoch, seq: 0 });
    expect(meanwhile.status).toBe(503);
    expect(await meanwhile.json()).toMatchObject({ code: "server_away" });
    time += PHONE_TUNNEL_IDLE_MS - TUNNEL_IDLE_MS;
    service.store.sweep();
    expect(service.store.tunnels.has(id)).toBe(false);
    expect((await request(`/v1/channels/${cid}/to-vps`, phone, "POST", { frames: ["aaaa"], epoch, seq: 1 })).status).toBe(404);
  });

  it("counts the phone hub's channel poll as the server being alive", async () => {
    time += TUNNEL_IDLE_MS - 1000;
    expect((await request(`/v1/tunnels/${id}/channels/to-vps`, vps)).status).toBe(200);
    time += 2000;
    service.store.sweep();
    expect(service.store.tunnels.has(id)).toBe(true);
  });
});

describe("health", () => {
  it("answers on /health as well as /healthz", async () => {
    for (const path of ["/health", "/healthz"]) expect(await (await request(path)).json()).toEqual({ ok: true });
  });
});
