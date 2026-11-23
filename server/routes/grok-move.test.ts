import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { GROK_EXPORT_MAX_CHARS } from "../../shared/grok-import.ts";
import { GROK_MOVE_ROUTES as R } from "../../shared/grok-move.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { SYNTHETIC_BOTS, syntheticExport } from "../testing/grok-bot-profile.ts";
import { grokMoveFixture, removeGrokMoveFixtures } from "../testing/grok-move-fixture.ts";
import { createGrokMoveRoutes } from "./grok-move.ts";
import { dispatchRoutes } from "./table.ts";

const AUTH: Record<string, RequestAuth> = {
  owner: { kind: "loopback", scopes: ["admin", "client"] },
  service: { kind: "loopback", scopes: ["client"], trust: "service" },
  paired: { kind: "session", via: "bearer", scopes: ["admin", "client"], session: { id: "s1" } } as unknown as RequestAuth,
};
const NOVA = SYNTHETIC_BOTS[0]!.id;
const TALLY = SYNTHETIC_BOTS[3]!.id;

let fixture: Awaited<ReturnType<typeof grokMoveFixture>> | null = null;
const servers: Server[] = [];
afterAll(removeGrokMoveFixtures);
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await fixture?.close();
  fixture = null;
});

async function serve(local = true) {
  fixture = await grokMoveFixture();
  const app = fixture;
  const routes = [createGrokMoveRoutes({ local, mover: () => app.mover })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = AUTH[String(req.headers["x-test-auth"] ?? "owner")]!;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "next handler" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, options: { auth?: string; body?: unknown; type?: string } = {}) => fetch(`${base}${path}`, {
    method,
    headers: { "x-test-auth": options.auth ?? "owner", ...(options.body === undefined ? {} : { "content-type": options.type ?? "application/json" }) },
    ...(options.body === undefined ? {} : { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) }),
  });
  return { call, app };
}

describe("the Grok Bot move routes", () => {
  it("answer only the owner's own loopback on the desktop app's server", async () => {
    const { call } = await serve();
    for (const auth of ["paired", "service"]) {
      for (const [method, path] of [["GET", R.detect], ["GET", R.waiting], ["POST", R.start], ["GET", `${R.photo}?id=${NOVA}`]] as const) {
        expect((await call(method, path, { auth, ...(method === "POST" ? { body: { bots: [{ rosterId: NOVA }] } } : {}) })).status, `${auth} ${path}`).toBe(403);
      }
    }
    expect(fixture!.store.bots.some((bot) => bot.installedPackage?.origin)).toBe(false);
  });

  it("say detection is not available away from the desktop app, and refuse the rest there", async () => {
    const { call } = await serve(false);
    const detect = await call("GET", R.detect);
    expect(await detect.json()).toEqual(expect.objectContaining({ available: false, reason: "notDesktop", bots: [] }));
    expect((await call("GET", R.detect, { auth: "paired" })).status).toBe(403);
    expect((await call("POST", R.start, { body: { bots: [{ rosterId: NOVA }] } })).status).toBe(403);
  });

  it("check methods, paths, content type and bodies", async () => {
    const { call } = await serve();
    expect((await call("POST", R.detect, { body: {} })).status).toBe(405);
    expect((await call("GET", `${R.detect}/../x`)).status).toBe(404);
    expect((await call("GET", "/api/setup-import/grok/move/nope")).status).toBe(404);
    expect((await call("POST", R.start, { body: "{}", type: "text/plain" })).status).toBe(415);
    for (const body of [{}, { bots: [] }, { bots: [{ rosterId: "../../etc" }] }, { bots: [{ rosterId: NOVA, extra: 1 }] }, "not json"]) {
      expect((await call("POST", R.start, { body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call("GET", `${R.photo}?id=a/b`)).status).toBe(400);
    expect((await call("GET", `${R.undo}?moveId=nope`)).status).toBe(400);
    expect((await call("POST", R.request, { body: { rosterId: "" } })).status).toBe(400);
    expect((await call("POST", R.acceptExport, { body: { text: "" } })).status).toBe(400);
  });

  it("detect, move, show progress, then undo after a preview", async () => {
    const { call, app } = await serve();
    const detect = await call("GET", R.detect);
    expect(detect.headers.get("cache-control")).toBe("no-store");
    expect((await detect.json() as { bots: unknown[] }).bots).toHaveLength(SYNTHETIC_BOTS.length);
    const photo = await call("GET", `${R.photo}?id=${NOVA}`);
    expect([photo.status, photo.headers.get("content-type")]).toEqual([200, "image/png"]);
    expect((await call("GET", `${R.photo}?id=${TALLY}`)).status).toBe(404);
    expect((await call("GET", R.progress)).status).toBe(404);
    expect((await call("POST", R.stop, { body: {} })).status).toBe(409);

    const started = await call("POST", R.start, { body: { bots: [{ rosterId: NOVA }, { rosterId: TALLY, chat: false }] } });
    expect(started.status).toBe(202);
    const { moveId } = await started.json() as { moveId: string };
    await app.mover.settled();
    expect(await (await call("GET", R.progress)).json()).toMatchObject({ moveId, state: "done", done: 2 });

    expect((await call("POST", R.undo, { body: { moveId } })).status).toBe(400);
    expect(await (await call("GET", `${R.undo}?moveId=${moveId}`)).json()).toMatchObject({ bots: [{ name: "Nova" }, { name: "Tally" }] });
    expect(await (await call("POST", R.undo, { body: { moveId, confirm: true } })).json()).toMatchObject({ removedBots: 2 });
    expect((await call("POST", R.undo, { body: { moveId, confirm: true } })).status).toBe(409);
    expect((await call("GET", `${R.undo}?moveId=00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });

  it("hand out the request for a moved bot, and take a pasted or oversized export", async () => {
    const { call, app } = await serve();
    expect((await call("POST", R.request, { body: { rosterId: NOVA } })).status).toBe(409);
    await call("POST", R.start, { body: { bots: [{ rosterId: NOVA }] } });
    await app.mover.settled();
    const request = await (await call("POST", R.request, { body: { rosterId: NOVA } })).json() as { url: string; text: string; file: string };
    expect(request.url).toMatch(/^grokbot:\/\/app\/v1\/prompt\?id=/);
    expect(request.text).toContain(request.file);
    expect(await (await call("GET", R.waiting)).json()).toMatchObject({ waiting: 1 });
    const accepted = await (await call("POST", R.acceptExport, { body: { text: syntheticExport("Nova"), rosterId: NOVA, file: "drop.md" } })).json();
    expect(accepted).toMatchObject({ applied: [{ rosterId: NOVA, state: "arrived" }], problems: [] });
    expect(JSON.stringify(accepted)).not.toContain("keep notes short");
    const big = await (await call("POST", R.acceptExport, { body: { text: "x".repeat(GROK_EXPORT_MAX_CHARS + 1) } })).json();
    expect(big).toMatchObject({ applied: [], problems: [{ code: "tooLarge" }] });
    const refused = await (await call("POST", R.acceptExport, { body: { text: JSON.stringify({ format: "grok-bot-export", bots: [{ name: "Nova", token: "x" }] }) } })).json();
    expect(refused).toMatchObject({ problems: [{ code: "credentials" }] });
  });
});
