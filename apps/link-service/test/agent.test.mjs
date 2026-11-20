import { ClientRequest, createServer } from "node:http";
import { describe, expect, it } from "vitest";

import { connect as tcpConnect } from "node:net";

import { createEgressProxy, createTunnelAgent, EGRESS_DIAL_MS, EGRESS_PROBE, createCloudRelay, keepHubRunning, openFrame, sealBytes, sealFrame } from "../agent.mjs";

const id = "abcdefghij";
const key = Buffer.alloc(32, 3);
const credentials = { base: "http://relay.test", id, key: key.toString("base64url"), token: "v".repeat(43) };

function pendingFetch(signal) {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(signal.reason);
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve("timed out"), 300); })]);
  } finally {
    clearTimeout(timer);
  }
}

describe("tunnel agent shutdown", () => {
  it("a successful reply post wakes a failed poll's retry delay", async () => {
    let retrying, release, resumed;
    const retry = new Promise((resolve) => { retrying = resolve; });
    const posted = new Promise((resolve) => { release = resolve; });
    const active = new Promise((resolve) => { resumed = resolve; });
    let polls = 0;
    const agent = createTunnelAgent({ ...credentials, log: retrying, fetchImpl: async (_url, init) => {
      if (init.method === "POST") { await posted; return Response.json({ ok: true }); }
      polls += 1;
      if (polls === 1) return Response.json({ frames: [sealFrame(key, id, "to-vps", { t: "ctl", r: "r".repeat(12), op: "ping" })] });
      if (polls === 2) throw new Error("temporary poll disconnect");
      resumed("resumed");
      return pendingFetch(init.signal);
    } });
    const running = agent.run();
    try {
      await retry;
      release();
      expect(await bounded(active)).toBe("resumed");
    } finally {
      release();
      agent.stop();
      await running;
    }
  });

  it("aborts an in-flight reply post when stopped", async () => {
    let posted;
    const started = new Promise((resolve) => { posted = resolve; });
    let first = true;
    const agent = createTunnelAgent({ ...credentials, log: () => {}, fetchImpl: async (_url, init) => {
      if (init.method === "POST") {
        posted(init.signal);
        return pendingFetch(init.signal);
      }
      if (!first) return pendingFetch(init.signal);
      first = false;
      return Response.json({ frames: [sealFrame(key, id, "to-vps", { t: "ctl", r: "r".repeat(12), op: "ping" })] });
    } });
    const running = agent.run();
    try {
      const signal = await started;
      agent.stop();
      expect(signal.aborted).toBe(true);
      expect(await bounded(running)).toBe("stopped");
    } finally {
      agent.stop();
      await running;
    }
  });

  it("wakes retry backoff immediately when stopped", async () => {
    let retrying;
    const started = new Promise((resolve) => { retrying = resolve; });
    const agent = createTunnelAgent({ ...credentials, log: retrying, fetchImpl: async () => { throw new Error("offline"); } });
    const running = agent.run();
    try {
      await started;
      agent.stop();
      expect(await bounded(running)).toBe("stopped");
    } finally {
      agent.stop();
      await running;
    }
  });

  it("an unlinked reply post also stops an outstanding long poll", async () => {
    let first = true;
    const agent = createTunnelAgent({ ...credentials, log: () => {}, fetchImpl: async (_url, init) => {
      if (init.method === "POST") return Response.json({ error: "not found" }, { status: 404 });
      if (!first) return pendingFetch(init.signal);
      first = false;
      return Response.json({ frames: [sealFrame(key, id, "to-vps", { t: "ctl", r: "r".repeat(12), op: "ping" })] });
    } });
    const running = agent.run();
    try {
      expect(await bounded(running)).toBe("unlinked");
    } finally {
      agent.stop();
      await running;
    }
  });
});

describe("tunnel agent receiving buffers", () => {
  it("fails a flooded upload within its own buffer limit while another request completes", async () => {
    const server = createServer((_req, res) => res.end("healthy"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const slow = "s".repeat(12), healthy = "h".repeat(12);
    const frames = [sealFrame(key, id, "to-vps", { t: "req", r: slow, method: "POST", path: "/slow", end: false })];
    for (let index = 0; index < 128; index += 1) frames.push(sealBytes(key, id, "to-vps", slow, Buffer.alloc(128 * 1024, 1)));
    frames.push(sealFrame(key, id, "to-vps", { t: "req", r: healthy, method: "GET", path: "/healthy", end: true }));
    let first = true, maxBuffered = 0, finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const replies = [];
    const agent = createTunnelAgent({ ...credentials, server: { host: "127.0.0.1", port: server.address().port }, log: () => {}, fetchImpl: async (_url, init) => {
      if (init.method === "POST") {
        for (const value of JSON.parse(init.body).frames) {
          const frame = openFrame(key, id, "to-app", value);
          replies.push(frame);
          if (frame.r === healthy && frame.t === "end") finish();
        }
        return Response.json({ ok: true });
      }
      if (!first) return pendingFetch(init.signal);
      first = false;
      return Response.json({ frames });
    } });
    const originalWrite = ClientRequest.prototype.write;
    ClientRequest.prototype.write = function (...args) {
      const result = originalWrite.apply(this, args);
      if (this.path === "/slow") maxBuffered = Math.max(maxBuffered, this.writableLength);
      return result;
    };
    const running = agent.run();
    try {
      await expect.poll(() => replies.some((frame) => frame.r === healthy && frame.t === "end"), { timeout: 5000 }).toBe(true);
      await done;
      expect(maxBuffered).toBeGreaterThan(7 * 1024 * 1024);
      expect(maxBuffered).toBeLessThanOrEqual(8 * 1024 * 1024);
      const errors = replies.filter((frame) => frame.r === slow && frame.t === "err");
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("could not keep up");
      expect(replies.some((frame) => frame.r === healthy && frame.t === "head" && frame.status === 200)).toBe(true);
      expect(Buffer.concat(replies.filter((frame) => frame.r === healthy && frame.t === "bytes").map((frame) => frame.b)).toString()).toBe("healthy");
    } finally {
      agent.stop();
      await running;
      ClientRequest.prototype.write = originalWrite;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("egress dial timing", () => {
  it("probes the app's path when no stream measured it lately and reports the median dial time", async () => {
    let t = 1_000_000;
    const sent = [], reports = [];
    const proxy = createEgressProxy({ send: (frame) => sent.push(frame), bytes: () => true, queued: () => 0, onDrain: () => {}, bind: () => null,
      now: () => t, reportMs: 60_000, report: async (state) => { reports.push(state); return { enabled: true }; } });
    proxy.handle({ t: "egress", ready: true });
    await proxy.start();
    const dial = sent.find((frame) => frame.t === "dial");
    expect(dial).toMatchObject({ host: EGRESS_PROBE.host, port: EGRESS_PROBE.port });
    expect(reports.at(-1).dialMs).toBeNull();
    t += 420;
    expect(proxy.handle({ t: "dialed", r: dial.r, ok: true })).toBe(true);
    expect(sent.at(-1)).toEqual({ t: "cancel", r: dial.r });
    expect(proxy.dialLatency()).toBe(420);
    expect(proxy.stats().active).toBe(0);
    // a fresh sample means no second probe until a minute passes
    sent.length = 0;
    proxy.handle({ t: "egress", ready: true });
    t += 30_000;
    await proxy.stop();
    expect(sent.filter((frame) => frame.t === "dial")).toHaveLength(0);
    t += 200_000;
    expect(proxy.dialLatency()).toBeNull();
  });
});

describe("egress fallback", () => {
  /** a socks5 connect through the proxy: the reply code and how long it took */
  function socksConnect(port, host = "www.instagram.com") {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const socket = tcpConnect({ host: "127.0.0.1", port });
      let got = Buffer.alloc(0), stage = 0;
      socket.on("error", reject);
      socket.on("connect", () => socket.write(Buffer.from([5, 1, 0])));
      socket.on("data", (chunk) => {
        got = Buffer.concat([got, chunk]);
        if (stage === 0 && got.length >= 2) {
          got = got.subarray(2);
          stage = 1;
          const name = Buffer.from(host);
          socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([1, 187])]));
        }
        if (stage === 1 && got.length >= 10) { socket.destroy(); resolve({ code: got[1], ms: Date.now() - started }); }
      });
    });
  }

  it("waits a bounded time for an app that stopped answering, then sends the rest straight to the direct fallback", async () => {
    expect(EGRESS_DIAL_MS).toBeLessThanOrEqual(2000);
    const sent = [];
    const proxy = createEgressProxy({ send: (frame) => sent.push(frame), bytes: () => true, queued: () => 0, onDrain: () => {}, report: null, probe: null,
      dialMs: 150, bind: () => ({ host: "127.0.0.1", port: 0, allow: () => true }) });
    await proxy.start();
    try {
      proxy.handle({ t: "egress", ready: true });
      const first = await socksConnect(proxy.listening.port);
      expect(first.code).toBe(1);
      expect(first.ms).toBeGreaterThanOrEqual(140);
      expect(first.ms).toBeLessThan(1500);
      expect(proxy.online()).toBe(false);
      const next = await socksConnect(proxy.listening.port);
      expect(next.code).toBe(1);
      expect(next.ms).toBeLessThan(100);
      expect(sent.filter((frame) => frame.t === "dial")).toHaveLength(1);
      expect(proxy.stats()).toMatchObject({ fallbacks: 2, active: 0 });
    } finally {
      await proxy.stop();
    }
  });

  it("a slow dial leaves the streams already open, and only an app silent for good closes them", async () => {
    // live 2026-11-09: one dial past the limit closed every open stream, the http/2 connections carrying a page's css
    // and scripts with them, and instagram.com/zuck stayed unstyled html with broken images
    let offset = 0;
    const sent = [], carried = [];
    const proxy = createEgressProxy({ send: (frame) => sent.push(frame), bytes: (r, chunk) => carried.push([r, chunk.toString()]), queued: () => 0, onDrain: () => {},
      report: null, probe: null, reportMs: 25, now: () => Date.now() + offset, dialMs: 150, bind: () => ({ host: "127.0.0.1", port: 0, allow: () => true }) });
    await proxy.start();
    const socket = tcpConnect({ host: "127.0.0.1", port: proxy.listening.port });
    try {
      proxy.handle({ t: "egress", ready: true });
      let got = Buffer.alloc(0);
      const closed = new Promise((resolve) => socket.on("close", resolve));
      socket.on("data", (chunk) => { got = Buffer.concat([got, chunk]); });
      const until = async (check) => { for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10)); expect(check()).toBe(true); };
      socket.write(Buffer.from([5, 1, 0]));
      await until(() => got.length >= 2);
      const name = Buffer.from("static.cdninstagram.com");
      socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([1, 187])]));
      await until(() => sent.some((frame) => frame.t === "dial"));
      const { r } = sent.find((frame) => frame.t === "dial");
      proxy.handle({ t: "dialed", r, ok: true });
      await until(() => got.length >= 12);
      expect(got[3]).toBe(0);

      const slow = await socksConnect(proxy.listening.port);
      expect(slow.code).toBe(1);
      expect(proxy.online()).toBe(false);
      expect(proxy.stats().active).toBe(1);
      socket.write("css please");
      await until(() => carried.some(([id, text]) => id === r && text === "css please"));
      proxy.handle({ t: "bytes", r, b: Buffer.from("body{}") });
      await until(() => got.subarray(12).toString() === "body{}");

      offset = 41_000;
      await closed;
      expect(proxy.stats().active).toBe(0);
    } finally {
      socket.destroy();
      await proxy.stop();
    }
  });
});

describe("the phone hub beside a running tunnel", () => {
  it("is made again when the relay refused it, and stays stopped once the tunnel ends", async () => {
    const hubs = [];
    const make = () => {
      let end;
      const hub = { done: false, run: () => new Promise((resolve) => { end = resolve; }), stop: () => { hub.done = true; end?.(); }, refuse: () => end() };
      hubs.push(hub);
      return hub;
    };
    const kept = keepHubRunning(make, { againMs: 10 });
    expect(hubs).toHaveLength(1);
    hubs[0].refuse();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(hubs).toHaveLength(2);
    hubs[1].refuse();
    kept.stop();
    await kept.done;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(hubs).toHaveLength(2);
  });
});

describe("the cloud relay before the app registered this link", () => {
  it("asks again soon at first instead of waiting the long unknown wait", async () => {
    let asked = 0;
    const relay = createCloudRelay({ url: "https://relay.test", id: "abcdefghij", key: "k".repeat(43), hub: {}, log: () => {}, unknownFirstMs: 20, unknownMs: 60_000,
      connect: async () => { asked += 1; throw Object.assign(new Error("not found"), { status: 404 }); } });
    relay.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    relay.stop();
    expect(asked).toBeGreaterThanOrEqual(3);
    expect(asked).toBeLessThan(8);
  });
});
