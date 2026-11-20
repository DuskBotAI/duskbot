// A bot's automation address on a desktop: the companion's public route passes /hooks/ straight to the webhook
// receiver, without a paired device and without anything that would read as one.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProxyHandler } from "../src/proxy.ts";

let receiver: Server;
let companion: Server;
let base = "";
const seen: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];

const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
    });
  });
  const webhookPort = await listen(receiver);
  companion = createServer(createProxyHandler({
    harnessPort: 1,
    webhookPort,
    authenticate: () => null,
    redeem: () => ({ error: "no" }),
    serverName: () => "test",
  }));
  base = `http://127.0.0.1:${await listen(companion)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => companion.close(() => resolve()));
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

describe("automation addresses through the companion", () => {
  it("passes a POST to /hooks/ to the webhook receiver with its body and delivery headers only", async () => {
    const response = await fetch(`${base}/hooks/wh_abc/whsec_xyz`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "d1", "x-dusk-device-id": "spoofed", cookie: "a=b" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    const last = seen.at(-1)!;
    expect(last.url).toBe("/hooks/wh_abc/whsec_xyz");
    expect(last.body).toBe('{"hello":"world"}');
    expect(last.headers["idempotency-key"]).toBe("d1");
    expect(last.headers["x-dusk-device-id"]).toBeUndefined();
    expect(last.headers.cookie).toBeUndefined();
  });

  it("leaves every other path and method to the paired-device rules", async () => {
    const count = seen.length;
    expect((await fetch(`${base}/hooks/wh_abc/whsec_xyz`)).status).not.toBe(202);
    expect((await fetch(`${base}/api/bots`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${base}/hooks/../api/bots`, { method: "POST", body: "{}" })).status).not.toBe(202);
    expect(seen.length).toBe(count);
  });
});
