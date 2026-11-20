import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createBotMail, failedAuthentication, senderAllowed, type MailEvent } from "./bot-mail.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); });

function mime(from: string, to: string, subject: string, body: string, extra = "") {
  return Buffer.from([
    `From: Sam <${from}>`, `To: ${to}`, `Subject: ${subject}`, "Message-ID: <m1@example.com>", "Date: Thu, 19 Nov 2026 10:00:00 +0000",
    ...(extra ? [extra] : []), "Content-Type: text/plain; charset=utf-8", "", body,
  ].join("\r\n")).toString("base64");
}

async function harness(base = "https://home.example") {
  const dir = mkdtempSync(join(tmpdir(), "dusk-bot-mail-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const delivered: Array<{ botId: string; targetId: string; event: MailEvent }> = [];
  const registered: Array<{ handle: string; url: string; secret: string; key: string }> = [];
  let edgeStatus = 200;
  let hooksBase = base;
  const mail = createBotMail({
    file: join(dir, "bot-mail.json"),
    hooksBase: () => hooksBase,
    edge: { url: "https://in.example", domain: "in.example" },
    bot: (id) => (id === "b1" ? { name: "Receipt Keeper" } : null),
    target: (_botId, id) => (id === "r1" ? { ok: true, name: "Log receipts" } : { ok: false, error: "No automation with that id" }),
    deliver: (botId, targetId, event) => { delivered.push({ botId, targetId, event }); },
    fetch: (async (url: string, init: RequestInit) => {
      const handle = decodeURIComponent(url.split("/").pop()!);
      registered.push({ handle, ...(JSON.parse(String(init.body)) as { url: string; secret: string; key: string }) });
      return new Response("{}", { status: edgeStatus });
    }) as typeof fetch,
  });
  const server: Server = createServer((req, res) => {
    void mail.door(req, res, new URL(req.url ?? "/", "http://x")).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, secret: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${local}${path}`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { mail, delivered, registered, post, dir, setEdge: (status: number) => { edgeStatus = status; }, setBase: (next: string) => { hooksBase = next; } };
}

describe("a bot's own mail address", () => {
  it("registers a route with the edge and turns allowed mail into the routed automation's run", async () => {
    const h = await harness();
    const view = await h.mail.setRoute("b1", { alias: "receipts", targetId: "r1", from: ["me@example.com", "@shop.example"] });
    expect(view.address).toMatch(/^receipt-keeper-[a-f0-9]{10}@in\.example$/);
    expect(view.routes[0]).toMatchObject({ address: view.address.replace("@", "+receipts@"), name: "Log receipts" });
    expect(view.reachable).toBe(true);
    const registration = h.registered[0]!;
    expect(registration.url).toMatch(/^https:\/\/home\.example\/hooks\/mail\/mb_/);
    const path = new URL(registration.url).pathname;
    expect((statSync(join(h.dir, "bot-mail.json")).mode & 0o777).toString(8)).toBe("600");

    const check = await h.post(path, registration.secret, {}, { "x-dusk-mail-check": "n1" });
    expect(await check.json()).toEqual({ check: createHmac("sha256", registration.secret).update("n1").digest("hex") });

    const to = view.address.replace("@", "+receipts@");
    const ok = await h.post(path, registration.secret, { from: "bills@shop.example", to, raw: mime("bills@shop.example", to, "Your receipt", "Total: $12") });
    expect(ok.status).toBe(202);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toMatchObject({ botId: "b1", targetId: "r1", event: { eventName: "email", deliveryId: "mail:<m1@example.com>", payload: { from: "bills@shop.example", subject: "Your receipt", fromName: "Sam" } } });
    expect(h.delivered[0]!.event.payload.text).toContain("Total: $12");
  });

  it("drops mail from anyone off the list, to an alias with no route, or that failed DMARC, without delivering", async () => {
    const h = await harness();
    const view = await h.mail.setRoute("b1", { alias: "", targetId: "r1", from: ["me@example.com"] });
    const { url, secret } = h.registered[0]!;
    const path = new URL(url).pathname;
    const send = async (from: string, to: string, extra = "") => (await (await h.post(path, secret, { from, to, raw: mime(from, to, "s", "b", extra) })).json()) as { ignored?: string };
    expect((await send("stranger@evil.example", view.address)).ignored).toBe("sender not allowed");
    expect((await send("me@example.com", view.address.replace("@", "+other@"))).ignored).toBe("no route");
    expect((await send("me@example.com", view.address, "Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=example.com")).ignored).toBe("failed authentication");
    expect(h.delivered).toHaveLength(0);
    expect(h.mail.view("b1")?.dropped).toBe(3);
    expect((await h.post(path, "wrong", { to: view.address, raw: "" })).status).toBe(401);
  });

  it("says why mail can't arrive yet on a computer the internet can't reach, and registers once it can", async () => {
    const h = await harness("http://127.0.0.1:8800");
    const view = await h.mail.setRoute("b1", { alias: "", targetId: "r1", from: ["me@example.com"] });
    expect(view.reachable).toBe(false);
    expect(view.problem).toMatch(/Remote access/);
    expect(h.registered).toHaveLength(0);
    h.setBase("https://tunnel.example");
    await h.mail.sync();
    expect(h.registered[0]!.url).toMatch(/^https:\/\/tunnel\.example\//);
    expect(h.mail.view("b1")?.reachable).toBe(true);
  });

  it("refuses bad aliases, senders and targets, and removing every sender removes the route", async () => {
    const h = await harness();
    await expect(h.mail.setRoute("b1", { alias: "a b", targetId: "r1", from: ["me@example.com"] })).rejects.toThrow(/alias/);
    await expect(h.mail.setRoute("b1", { alias: "", targetId: "r1", from: ["not an address"] })).rejects.toThrow(/not an email/);
    await expect(h.mail.setRoute("b1", { alias: "", targetId: "nope", from: ["me@example.com"] })).rejects.toThrow(/No automation/);
    await h.mail.setRoute("b1", { alias: "x", targetId: "r1", from: ["me@example.com"] });
    expect((await h.mail.setRoute("b1", { alias: "x", targetId: "r1", from: [] })).routes).toEqual([]);
  });

  it("matches senders by address or @domain, and reads a failed SPF without a passing DKIM as failed", () => {
    expect(senderAllowed(["@shop.example"], "Bills@Shop.example")).toBe(true);
    expect(senderAllowed(["@shop.example"], "x@evilshop.example")).toBe(false);
    expect(failedAuthentication("spf=fail; dkim=pass")).toBe(false);
    expect(failedAuthentication("spf=softfail; dkim=none")).toBe(true);
    expect(failedAuthentication(undefined)).toBe(false);
  });
});
