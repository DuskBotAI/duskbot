import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { doorUrl, handleEmail, handleFetch, handleOf, MAX_RAW_BYTES } from "../src/index.js";

function kv() {
  const map = new Map();
  return {
    map,
    get: async (key) => (map.has(key) ? JSON.parse(map.get(key)) : null),
    put: async (key, value) => { map.set(key, value); },
    delete: async (key) => { map.delete(key); },
  };
}

const SECRET = "s".repeat(43);
const KEY = "k".repeat(43);
const DOOR = "https://home.example/hooks/mail/mb_abcdefgh12";

/** A dusk bot mail door: answers the check with HMAC(secret, nonce), and takes deliveries. */
function door({ honest = true, status = 202 } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    const check = init.headers["x-dusk-mail-check"];
    if (check) {
      const answer = honest ? createHmac("sha256", init.headers.authorization.slice(7)).update(check).digest("hex") : "nope";
      return new Response(JSON.stringify({ check: answer }), { status: 200 });
    }
    return new Response("{}", { status });
  };
  return { calls, fetcher };
}

const env = () => ({ MAILBOXES: kv(), MAIL_DOMAIN: "in.dusk.bot" });
const put = (handle, body, key = KEY) => new Request(`https://in.dusk.bot/v1/mailboxes/${handle}`, { method: "PUT", body: JSON.stringify({ url: DOOR, secret: SECRET, key, ...body }) });

function message(to, raw = "Subject: hi\r\n\r\nbody") {
  const bytes = new TextEncoder().encode(raw);
  let rejected = null;
  return {
    from: "me@example.com", to,
    raw: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    setReject: (reason) => { rejected = reason; },
    get rejected() { return rejected; },
  };
}

describe("registering a mailbox", () => {
  it("keeps a mailbox only after its door answers the check, and keeps the handle for the key that took it", async () => {
    const e = env();
    const ok = door();
    expect((await handleFetch(put("scout-1a2b3c"), e, ok.fetcher)).status).toBe(200);
    expect(JSON.parse(e.MAILBOXES.map.get("scout-1a2b3c"))).toMatchObject({ url: DOOR, secret: SECRET });
    expect((await handleFetch(put("scout-1a2b3c", {}, "x".repeat(43)), e, ok.fetcher)).status).toBe(409);
    expect((await handleFetch(put("other-1a2b3c"), e, door({ honest: false }).fetcher)).status).toBe(422);
    expect(e.MAILBOXES.map.has("other-1a2b3c")).toBe(false);
  });

  it("refuses destinations that are not a mail door on a public https host", async () => {
    expect(doorUrl("http://home.example/hooks/mail/mb_abcdefgh12")).toBeNull();
    expect(doorUrl("https://10.0.0.1/hooks/mail/mb_abcdefgh12")).toBeNull();
    expect(doorUrl("https://victim.example/api/anything")).toBeNull();
    expect(doorUrl("https://home.example/hooks/mail/mb_abcdefgh12?x=1")).toBeNull();
    expect(doorUrl(DOOR)).toBe(DOOR);
    expect((await handleFetch(put("scout-1a2b3c", { url: "https://victim.example/" }), env(), door().fetcher)).status).toBe(400);
  });

  it("deletes only with the key that owns it", async () => {
    const e = env();
    await handleFetch(put("scout-1a2b3c"), e, door().fetcher);
    const del = (key) => new Request("https://in.dusk.bot/v1/mailboxes/scout-1a2b3c", { method: "DELETE", headers: { authorization: `Bearer ${key}` } });
    expect((await handleFetch(del("wrong"), e)).status).toBe(403);
    expect((await handleFetch(del(KEY), e)).status).toBe(200);
    expect(e.MAILBOXES.map.size).toBe(0);
  });
});

describe("delivering mail", () => {
  it("posts the message to the door with its secret, the alias kept in the recipient", async () => {
    const e = env();
    const d = door();
    await handleFetch(put("scout-1a2b3c"), e, d.fetcher);
    const mail = message("Scout-1a2b3c+Receipts@in.dusk.bot");
    await handleEmail(mail, e, d.fetcher);
    expect(mail.rejected).toBeNull();
    const delivery = d.calls.at(-1);
    expect(delivery.url).toBe(DOOR);
    expect(delivery.init.headers.authorization).toBe(`Bearer ${SECRET}`);
    const body = JSON.parse(delivery.init.body);
    expect(body.to).toBe("Scout-1a2b3c+Receipts@in.dusk.bot");
    expect(atob(body.raw)).toContain("Subject: hi");
  });

  it("bounces unknown handles and an unreachable home, never a sender the door dropped, and caps the size", async () => {
    const e = env();
    const unknown = message("nobody-123456@in.dusk.bot");
    await handleEmail(unknown, e, door().fetcher);
    expect(unknown.rejected).toBe("No such mailbox");
    await handleFetch(put("scout-1a2b3c"), e, door().fetcher);
    const down = message("scout-1a2b3c@in.dusk.bot");
    await handleEmail(down, e, async () => { throw new Error("offline"); });
    expect(down.rejected).toMatch(/try again later/);
    const dropped = message("scout-1a2b3c@in.dusk.bot");
    await handleEmail(dropped, e, door({ status: 202 }).fetcher);
    expect(dropped.rejected).toBeNull();
    const big = door();
    await handleEmail(message("scout-1a2b3c@in.dusk.bot", "x".repeat(MAX_RAW_BYTES + 5_000)), e, big.fetcher);
    expect(atob(JSON.parse(big.calls.at(-1).init.body).raw).length).toBe(MAX_RAW_BYTES);
    expect(handleOf("a@other.example", "in.dusk.bot")).toBeNull();
  });
});
