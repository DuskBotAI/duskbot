// the operator's delete route through the whole dashboard app: an admin's own cloud is refused unless asked for by name
import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CSRF_HEADER } from "../../../shared/account-api.ts";
import { createBilling } from "../../dashboard/server/billing/index.ts";
import { createDashboardApp } from "../../dashboard/server/app.ts";
import { memoryMailer } from "../../dashboard/server/auth/mail.ts";
import type { BillingState } from "../../dashboard/server/billing/store.ts";
import { startFakeInstaboxApi } from "./fake-instabox-api.ts";

vi.mock("../../dashboard/server/billing/index.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../../dashboard/server/billing/index.ts")>();
  return { ...actual, createBilling: vi.fn(actual.createBilling) };
});
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const OPS_TOKEN = "t".repeat(40);

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dusk-ops-delete-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const time = Date.UTC(2026, 10, 9, 12);
  const now = () => time, mailer = memoryMailer();
  const api = await startFakeInstaboxApi({ now }); cleanup.push(() => api.close());
  api.onExec(({ machine, cmd }) => {
    if (cmd.includes("omb-home start") && !machine.volume.size) machine.volume.set("data/.omb-cloud-home.json", Buffer.from(JSON.stringify({ version: 1, machine: machine.metadata["omb.cloud"] })));
    if (cmd.includes("omb-home start")) machine.volume.set(`data/${CLOUD_HOME.dataName}/config.json`, Buffer.from("{}"));
    return null;
  });
  for (const key of ["DUSK_BILLING_PROVIDER", "DUSK_CLOUD_PROVIDER", "DUSK_POOL_DRIVER", "DUSK_CLOUD_SEAL_KEY", "DUSK_DODO_PRODUCTS"]) vi.stubEnv(key, undefined);
  vi.stubEnv("DUSK_MANAGED", "1"); vi.stubEnv("INSTABOX_API_KEY", api.key); vi.stubEnv("INSTABOX_BASE_URL", api.baseUrl);
  vi.stubEnv("DUSK_MANAGED_HOME_PACKAGE_URL", "https://packages.example.test/home.tgz"); vi.stubEnv("DUSK_MANAGED_HOME_PACKAGE_SHA256", "b".repeat(64)); vi.stubEnv("DUSK_MANAGED_BACKUP_MIN_FREE_GB", "1");
  vi.stubEnv("DUSK_OPS_TOKEN", OPS_TOKEN); vi.stubEnv("DUSK_ADMIN_EMAILS", "admin@example.test"); vi.stubEnv("DUSK_GROWTH_ADMIN_EMAILS", "growth@example.test");
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname.endsWith(".instabox.tech")) {
      const body = url.pathname === "/api/cloud/health" ? { v: 1 } : url.pathname === "/api/cloud/power" ? { v: 1, idle: false, busy: ["turn"], nextDueAt: null }
        : url.pathname === "/api/cloud/entitlement" ? { ok: true, expiresAt: now() + 86_400_000 } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return fetch(input, init);
  };
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address.");
  const origin = `http://127.0.0.1:${address.port}`;
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const app = createDashboardApp({ dataDir: dir, publicUrl: origin, mailer, staticDir: null, now, fetch: fetcher });
  cleanup.push(() => app.close());
  server.on("request", app.handle);
  const billing = vi.mocked(createBilling).mock.results.at(-1)!.value as ReturnType<typeof createBilling>;
  const csrf = new Map<string, string>();
  const page = (path: string, body?: unknown, cookie?: string) => fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie, [CSRF_HEADER]: csrf.get(cookie) ?? "" } : {}), origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function login(email: string) {
    const { attempt } = await (await page("/v1/auth/start", { email })).json() as { attempt: string };
    const code = mailer.outbox.findLast(m => m.to === email && /\b\d{8}\b/.test(m.text))!.text.match(/\b\d{8}\b/)![0];
    const verify = await page("/v1/auth/verify", { attempt, code });
    const cookie = verify.headers.get("set-cookie")!.split(";")[0]!;
    csrf.set(cookie, (await verify.json() as { csrfToken: string }).csrfToken);
    return cookie;
  }
  /** a paid cloud whose plan then ended, so only the admin guard stands between it and the operator's delete */
  async function endedCloud(email: string) {
    const cookie = await login(email);
    expect((await page("/v1/billing/checkout", { kind: "cart", cart: { interval: "month", license: { kind: "none" }, desktop: { kind: "shared_s", region: "us-west-2" } } }, cookie)).status).toBe(200);
    const stored = (JSON.parse(readFileSync(join(dir, "billing.json"), "utf8")) as BillingState).checkouts.at(-1)!;
    const deliver = async (deliveries: Array<{ headers: Record<string, string>; body: Buffer | Uint8Array }>) => {
      for (const d of deliveries) expect((await fetch(`${origin}/v1/billing/webhooks/dodo`, { method: "POST", headers: { "content-type": "application/json", ...d.headers }, body: new Uint8Array(d.body) })).status).toBe(200);
    };
    await deliver(billing.fake!.complete(stored.providerSessionId!));
    const cloud = billing.clouds.get(stored.cloudId!)!;
    for (let n = 0; n < 20 && cloud.status !== "running"; n++) { cloud.nextAttemptAt = 0; await billing.clouds.reconcile(); }
    expect(cloud).toMatchObject({ backend: "managed", status: "running" });
    const subscriptionId = (JSON.parse(readFileSync(join(dir, "billing.json"), "utf8")) as BillingState).subscriptions.find(s => s.cloudId === cloud.id)!.providerSubscriptionId!;
    await deliver(billing.fake!.expire(subscriptionId));
    return cloud;
  }
  const opsDelete = (cloudId: string, body: Record<string, unknown>) => fetch(`${origin}/v1/billing/ops/clouds/${cloudId}/delete`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPS_TOKEN}` }, body: JSON.stringify(body) });
  return { api, billing, opsDelete, endedCloud };
}

it("refuses the operator's delete of an admin's or growth admin's cloud unless allowAdminOwned is sent, and lets any other through", async () => {
  const f = await fixture();
  for (const email of ["admin@example.test", "growth@example.test"]) {
    const cloud = await f.endedCloud(email);
    const refused = await f.opsDelete(cloud.id, { reason: "test_account" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "admin_owned" });
    expect(cloud.managed!.deleteRequest).toBeNull();
    expect(() => f.billing.operatorDelete(cloud, "admin_panel")).toThrow("admin_owned");
    expect(cloud.managed!.deleteRequest).toBeNull();
    expect((await f.opsDelete(cloud.id, { reason: "test_account", allowAdminOwned: "yes" })).status).toBe(400);
    expect((await f.opsDelete(cloud.id, { reason: "test_account", allowAdminOwned: true })).status).toBe(200);
    expect(cloud.managed!.deleteRequest).toMatchObject({ by: "operator" });
  }
  const other = await f.endedCloud("someone@example.test");
  expect((await f.opsDelete(other.id, { reason: "test_account" })).status).toBe(200);
  expect(other.managed!.deleteRequest).toMatchObject({ by: "operator" });
});
