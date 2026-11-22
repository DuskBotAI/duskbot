import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Place } from "../../shared/model-providers.ts";
import { sealValues } from "../../src/lib/card-seal.ts";
import { createCardSealer } from "../card-seal.ts";
import type { InstanceConfigMap } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import { ModelCatalogStore } from "../model-catalog/catalog.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { createModelProviderRoutes } from "./model-providers.ts";
import { dispatchRoutes } from "./table.ts";

const LOOPBACK = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
const SESSION = { kind: "session", scopes: ["admin"] } as unknown as RequestAuth;
const catalog = new ModelCatalogStore({ dataDir: "/nonexistent", fetchDisabled: true, openCodeCachePath: null, log: () => {} });

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(options: { place?: Place; auth?: RequestAuth; described?: unknown[]; fetch?: typeof fetch } = {}) {
  const saved: InstanceConfigMap = {};
  const persisted: string[] = [];
  const sealer = createCardSealer();
  const local = vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes(":11434")) return new Response("{}", { status: 200 });
    throw new TypeError("refused");
  });
  const routes = [createModelProviderRoutes({
    catalog, place: options.place ?? "computer", sealer,
    describeInstances: async () => options.described ?? [],
    instances: () => saved,
    persistProviderInstance: async (instanceId, instances) => { Object.assign(saved, instances); persisted.push(instanceId); },
    busy: { get: () => false, set: () => {} },
    fetch: (options.fetch ?? local) as unknown as typeof fetch,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: options.auth ?? LOOPBACK, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text };
  };
  return { call, saved, persisted, sealer };
}

describe("model provider routes", () => {
  it("are for admins only", () => {
    expect(requiredScope("GET", "/api/model-providers")).toBe("admin");
    expect(requiredScope("GET", "/api/model-providers/search")).toBe("admin");
    expect(requiredScope("POST", "/api/model-providers/connect")).toBe("admin");
  });

  it("list every provider with where the bots run, what is connected and which local servers run", async () => {
    const { call } = await serve({ described: [{ instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: true } }] });
    const { status, body } = await call("GET", "/api/model-providers");
    expect(status).toBe(200);
    expect(body.place).toBe("computer");
    expect(body.catalog).toMatchObject({ origin: "snapshot" });
    expect(body.catalog.models).toBeGreaterThan(1000);
    const byId = Object.fromEntries(body.providers.map((provider: { id: string }) => [provider.id, provider]));
    expect(byId.anthropic.connected).toEqual(["claude"]);
    expect(byId.ollama).toMatchObject({ offered: true });
    expect(byId.ollama.reason).toBeUndefined();
    expect(byId.lmstudio).toMatchObject({ offered: true, reason: "not-running" });
    expect(byId.openrouter.modelCount).toBeGreaterThan(100);
    expect(byId.openrouter.hosts).toBeUndefined();
    expect(body.more.length).toBeGreaterThan(50);
  });

  it("leave local models out on dusk cloud", async () => {
    const { call } = await serve({ place: "cloud" });
    const { body } = await call("GET", "/api/model-providers");
    const ollama = body.providers.find((provider: { id: string }) => provider.id === "ollama");
    expect(ollama).toMatchObject({ offered: false, reason: "cloud" });
    expect((await call("POST", "/api/model-providers/connect", { provider: "ollama" })).status).toBe(400);
  });

  it("search connected engines' own models first, with catalog facts, then the catalog", async () => {
    const { call } = await serve({ described: [
      { instanceId: "openai-compat-a", driverKind: "openai-compat", displayName: "My gateway", url: "http://127.0.0.1:8317/v1", access: "custom",
        snapshot: { state: "available", authenticated: false }, models: { options: [{ id: "claude-sonnet-4-5", label: "claude-sonnet-4-5" }, { id: "gpt-5", label: "gpt-5" }] } },
    ] });
    const { body } = await call("GET", "/api/model-providers/search?q=sonnet");
    expect(body.hits[0].group).toMatchObject({ providerId: "cliproxyapi", connected: true, instanceId: "openai-compat-a", label: "My gateway" });
    expect(body.hits[0].models[0]).toMatchObject({ id: "claude-sonnet-4-5", tools: true });
    expect(body.hits[0].models[0].context).toBeGreaterThan(0);
    expect(body.hits.some((hit: { group: { providerId: string } }) => hit.group.providerId === "anthropic")).toBe(true);
    expect((await call("GET", "/api/model-providers/search?q=")).body.hits).toEqual([]);
  });

  it("connect a provider on this server and keep the key out of the answer", async () => {
    const { call, saved, persisted } = await serve();
    const answer = await call("POST", "/api/model-providers/connect", { provider: "groq", key: "gsk_secret_value" });
    expect(answer.status).toBe(201);
    expect(answer.body.place).toBe("computer");
    expect(answer.text).not.toContain("gsk_secret_value");
    expect(persisted).toEqual([answer.body.instanceId]);
    expect(saved[answer.body.instanceId]).toMatchObject({ driver: "openai-compat", config: { url: "https://api.groq.com/openai/v1", key: "gsk_secret_value" } });
  });

  it("take a key from a remote app only sealed for this server", async () => {
    const { call, saved, sealer } = await serve({ auth: SESSION, place: "cloud" });
    const plain = await call("POST", "/api/model-providers/connect", { provider: "groq", key: "gsk_plain" });
    expect(plain.status).toBe(400);
    expect(plain.body.code).toBe("seal_required");
    const wrongTarget = await sealValues({ key: "gsk_sealed" }, sealer.publicKey(), "model-provider", ["openai"]);
    expect((await call("POST", "/api/model-providers/connect", { provider: "groq", sealed: wrongTarget })).status).toBeGreaterThanOrEqual(400);
    const sealed = await sealValues({ key: "gsk_sealed" }, sealer.publicKey(), "model-provider", ["groq"]);
    const answer = await call("POST", "/api/model-providers/connect", { provider: "groq", sealed });
    expect(answer.status).toBe(201);
    expect(saved[answer.body.instanceId]).toMatchObject({ config: { key: "gsk_sealed" } });
  });

  it("list a provider's live models with a key, falling back to the catalog when it lists none", async () => {
    const provider = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "llama-3.3-70b-versatile" }] }), { status: 200 }));
    const { call } = await serve({ fetch: provider as unknown as typeof fetch });
    expect((await call("POST", "/api/model-providers/models", { provider: "groq", key: "k" })).body)
      .toEqual({ ok: true, models: ["llama-3.3-70b-versatile"], source: "provider", result: "works", model: "llama-3.3-70b-versatile" });
    const perplexity = (await call("POST", "/api/model-providers/models", { provider: "perplexity", key: "k" })).body;
    expect(perplexity.source).toBe("catalog");
    expect(perplexity.models.length).toBeGreaterThan(0);
    expect((await call("POST", "/api/model-providers/models", { provider: "custom-openai", key: "k", fields: { baseUrl: "http://example.com/v1" } })).status).toBe(400);
  });

  it("say plainly whether a pasted key runs a reply: wrong key, no credit, wrong model with one to use, or unreachable", async () => {
    let probe: { status: number; body: unknown } = { status: 200, body: {} };
    const asked: string[] = [];
    const provider = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      asked.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "llama-3.3-70b-versatile" }, { id: "llama-3.1-8b-instant" }] });
      return Response.json(probe.body, { status: probe.status });
    });
    const { call } = await serve({ fetch: provider as unknown as typeof fetch });
    const check = async (fields?: Record<string, string>) => (await call("POST", "/api/model-providers/models", { provider: "groq", key: "gsk_secret_value", ...(fields ? { fields } : {}) })).body;

    expect(await check()).toMatchObject({ ok: true, result: "works", model: "llama-3.1-8b-instant" });
    expect(asked.at(-1)).toBe("POST https://api.groq.com/openai/v1/chat/completions");
    probe = { status: 401, body: { error: { message: "Invalid API Key gsk_secret_value" } } };
    const wrong = await check();
    expect(wrong).toMatchObject({ result: "wrong_key" });
    expect(JSON.stringify(wrong)).not.toContain("gsk_secret_value");
    probe = { status: 429, body: { error: { message: "You exceeded your current quota, please check your plan and billing details.", code: "insufficient_quota" } } };
    expect(await check()).toMatchObject({ result: "no_credit" });
    probe = { status: 404, body: { error: { message: "The model `llama-3.3-70b` does not exist or you do not have access to it.", code: "model_not_found" } } };
    expect(await check({ model: "llama-3.3-70b" })).toMatchObject({ result: "wrong_model", model: "llama-3.3-70b", suggestedModel: "llama-3.3-70b-versatile" });

    const offline = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const { call: callOffline } = await serve({ fetch: offline as unknown as typeof fetch });
    expect((await callOffline("POST", "/api/model-providers/models", { provider: "groq", key: "k" })).body).toEqual({ ok: false, reason: "unreachable", result: "unreachable" });
  });

  it("check a pasted key and its model with one 1-token reply before saving, and save no key or model the provider refuses", async () => {
    let probe: { status: number; body: unknown } = { status: 401, body: { error: { message: "Invalid API Key gsk_wrong" } } };
    const provider = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "llama-3.3-70b-versatile" }, { id: "llama-3.1-8b-instant" }] });
      return Response.json(probe.body, { status: probe.status });
    });
    const { call, persisted } = await serve({ fetch: provider as unknown as typeof fetch });
    const wrongKey = await call("POST", "/api/model-providers/connect", { provider: "groq", key: "gsk_wrong" });
    expect(wrongKey).toMatchObject({ status: 400, body: { check: "wrong_key", error: expect.stringContaining("did not accept this key") } });
    expect(wrongKey.text).not.toContain("gsk_wrong");
    probe = { status: 404, body: { error: { message: "The model `llama-3.3-70b` does not exist", code: "model_not_found" } } };
    const wrongModel = await call("POST", "/api/model-providers/connect", { provider: "groq", key: "gsk_ok", models: ["llama-3.3-70b"] });
    expect(wrongModel).toMatchObject({ status: 400, body: { check: "wrong_model", suggestedModel: "llama-3.3-70b-versatile", error: "Groq does not offer the model llama-3.3-70b. Try llama-3.3-70b-versatile." } });
    expect(persisted).toEqual([]);
    probe = { status: 429, body: { error: { message: "You exceeded your current quota", code: "insufficient_quota" } } };
    expect(await call("POST", "/api/model-providers/connect", { provider: "groq", key: "gsk_ok", models: ["llama-3.3-70b-versatile"] })).toMatchObject({ status: 201, body: { check: "no_credit" } });
    probe = { status: 200, body: {} };
    expect(await call("POST", "/api/model-providers/connect", { provider: "groq", key: "gsk_ok", models: ["llama-3.3-70b-versatile"] })).toMatchObject({ status: 201, body: { check: "works" } });
    expect(persisted).toHaveLength(2);
  });
});
