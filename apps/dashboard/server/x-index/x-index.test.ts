// The keyless X index end to end on loopback: the account service's routes, and the workspace's own client
// (server/x-providers/x-index.ts) signing as a Cloud home or carrying a desktop's token. treg is a stub.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { searchXIndex, xIndexAuthHeaders } from "../../../../server/x-providers/x-index.ts";
import { createSealer } from "../clouds/seal.ts";
import type { StoredCloud } from "../clouds/types.ts";
import { createXIndexRoutes, xIndexRoutesFromEnv } from "./routes.ts";
import { createXIndexService, tregXIndexSearch } from "./service.ts";

const machineId = "c012345678901234567890123", secret = "fixture-bootstrap-secret";
const DESKTOP = `omc_${"d".repeat(43)}`;
const ROWS = [
  { url: "https://x.com/OpenAI/status/2123899406550528422", title: "OpenAI on X", snippet: "How AI is helping" },
  { url: "https://x.com/OpenAI", title: "OpenAI (@OpenAI)" },
  { url: "https://example.com/x.com/a/status/1234567890", title: "not X" },
];

function fixtureCloud(time: number, sealer: { seal(value: string): string }, status = "running"): StoredCloud {
  const spec = { vcpu: 2, ramGb: 4, diskGb: 40 };
  return { id: machineId, accountId: "account-home", name: "fixture", color: null, kind: "dedicated", placement: "dedicated", subscriptionId: null, spec, desiredSpec: spec, region: "test", botComputers: null, status, setupStep: null, wantPower: "on", serverId: null, ipv4: null, origin: null, bootstrapSecret: sealer.seal(secret), workspaceId: null, primary: true, hidden: false, paymentProblem: false, suspended: null, destroyAt: null, error: null, attempts: 0, nextAttemptAt: 0, createdAt: time, updatedAt: time, powerSince: time } as StoredCloud;
}

describe("keyless X index", () => {
  let dir: string, base: string, server: Server, time: number, cloud: StoredCloud;
  const sealer = createSealer(randomBytes(32));
  const search = vi.fn(async (_query: string) => ROWS);
  const mount = (daily = 3) => {
    const service = createXIndexService({ dataDir: dir, clouds: { get: (id) => (id === machineId ? cloud : null) }, unseal: sealer.unseal, search, publicUrl: base, daily, now: () => time });
    const routes = createXIndexRoutes(service, (req) => (req.headers.authorization === `Bearer ${DESKTOP}` ? { id: "account-desktop", email: "a@test-mail.invalid" } : null));
    server.removeAllListeners("request");
    server.on("request", (req, res) => { void routes.handle(req, res, new URL(req.url ?? "/", base)).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }); });
  };
  const home = () => ({ kind: "home" as const, url: `${base}/api/cloud/x-index`, machineId, secret });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "x-index-"));
    time = Date.UTC(2026, 10, 21, 12);
    cloud = fixtureCloud(time, sealer);
    search.mockClear();
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    mount();
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it("answers a Cloud home's signed search with X post links only", async () => {
    const text = await searchXIndex(home(), "openai science", { now: () => time });
    expect(JSON.parse(text)).toEqual([ROWS[0]]);
    expect(search).toHaveBeenCalledWith("openai science");
  });

  it("refuses a wrong signature, a replayed one, and a cloud that is gone", async () => {
    const body = JSON.stringify({ query: "a" });
    const bad = { ...xIndexAuthHeaders({ ...home(), secret: "wrong" }, body, time) };
    expect((await fetch(`${base}/api/cloud/x-index`, { method: "POST", body, headers: bad })).status).toBe(401);
    const good = xIndexAuthHeaders(home(), body, time);
    expect((await fetch(`${base}/api/cloud/x-index`, { method: "POST", body, headers: good })).status).toBe(200);
    expect((await fetch(`${base}/api/cloud/x-index`, { method: "POST", body, headers: good })).status).toBe(401);
    cloud = fixtureCloud(time, sealer, "destroyed");
    await expect(searchXIndex(home(), "a", { now: () => time })).rejects.toMatchObject({ code: "unavailable" });
    expect(search).toHaveBeenCalledOnce();
  });

  it("issues a signed-in desktop its own token, which then searches; a new one replaces it", async () => {
    expect((await fetch(`${base}/api/cloud/desktop/services/x-index`, { method: "POST", headers: { authorization: `Bearer omc_${"z".repeat(43)}` } })).status).toBe(401);
    const issued = await (await fetch(`${base}/api/cloud/desktop/services/x-index`, { method: "POST", headers: { authorization: `Bearer ${DESKTOP}` } })).json() as { url: string; token: string; cloudContractVersion: number };
    expect(issued).toMatchObject({ url: `${base}/api/cloud/x-index`, cloudContractVersion: 1 });
    expect(issued.token).toMatch(/^dusk_xi_[A-Za-z0-9_-]{43}$/);
    expect(JSON.parse(await searchXIndex({ kind: "desktop", url: issued.url, token: issued.token }, "a"))).toEqual([ROWS[0]]);
    const again = await (await fetch(`${base}/api/cloud/desktop/services/x-index`, { method: "POST", headers: { authorization: `Bearer ${DESKTOP}` } })).json() as { token: string };
    await expect(searchXIndex({ kind: "desktop", url: issued.url, token: issued.token }, "a")).rejects.toMatchObject({ code: "unavailable" });
    expect(JSON.parse(await searchXIndex({ kind: "desktop", url: issued.url, token: again.token }, "a"))).toHaveLength(1);
  });

  it("caps each account's searches a day, keeps the count over a restart, and starts again the next day", async () => {
    for (let i = 0; i < 3; i++) await searchXIndex(home(), `q${i}`, { now: () => time });
    await expect(searchXIndex(home(), "q4", { now: () => time })).rejects.toMatchObject({ code: "rate_limited" });
    mount();
    await expect(searchXIndex(home(), "q5", { now: () => time })).rejects.toMatchObject({ code: "rate_limited" });
    time += 24 * 60 * 60_000;
    expect(JSON.parse(await searchXIndex(home(), "q6", { now: () => time }))).toHaveLength(1);
    expect(search).toHaveBeenCalledTimes(4);
  });

  it("checks the query and says when the index itself is down", async () => {
    const body = JSON.stringify({ query: "x".repeat(301) });
    expect((await fetch(`${base}/api/cloud/x-index`, { method: "POST", body, headers: xIndexAuthHeaders(home(), body, time) })).status).toBe(400);
    search.mockRejectedValueOnce(new Error("down"));
    await expect(searchXIndex(home(), "a", { now: () => time })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("is off (404) without dusk's treg key", async () => {
    const routes = xIndexRoutesFromEnv({ dataDir: dir, publicUrl: base, clouds: { get: () => null }, fromBearer: () => null, env: {} });
    server.removeAllListeners("request");
    server.on("request", (req, res) => { void routes.handle(req, res, new URL(req.url ?? "/", base)); });
    expect((await fetch(`${base}/api/cloud/x-index`, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("asks treg's free TinyFish endpoint, limited to x.com, with the key only in its header", async () => {
    const fetcher = vi.fn(async () => Response.json({ query: "q", results: ROWS })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    expect(await tregXIndexSearch("treg-key", fetcher)("claude code")).toEqual(ROWS);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://treg.to/call/tinyfish.web.search?query=claude+code&domain_type=web&include_domains=x.com");
    expect(init.headers).toMatchObject({ "x-treg-token": "treg-key" });
  });
});
