import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sealValues } from "../src/lib/card-seal.ts";
import { createCardSealer, type CardSealer } from "./card-seal.ts";
import { json, readBody } from "./harness/http.ts";
import { probeModel, probeVerdict, suggestModel, verifyProviderKey } from "./key-check.ts";
import type { RequestAuth } from "./request-auth.ts";
import { createStatusRoutes, type StatusRouteDeps } from "./routes/status.ts";
import { dispatchRoutes } from "./routes/table.ts";

const KEY = "sk-fixture-SECRET-0123456789";

describe("probeVerdict", () => {
  it.each([
    [401, '{"error":{"message":"Incorrect API key provided: sk-abc.","code":"invalid_api_key"}}', true, "wrong_key"],
    [400, '[{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}]', true, "wrong_key"],
    [403, '{"error":{"message":"Forbidden"}}', false, "wrong_key"],
    [402, '{"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402}}', true, "no_credit"],
    [402, '{"error":{"message":"Insufficient Balance","type":"unknown_error"}}', false, "no_credit"],
    [429, '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","code":"insufficient_quota"}}', true, "no_credit"],
    [400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', true, "no_credit"],
    [404, '{"error":{"message":"The model `gpt-9` does not exist or you do not have access to it.","code":"model_not_found"}}', true, "wrong_model"],
    [404, '{"error":{"message":"The model `gpt-9` does not exist or you do not have access to it.","code":"model_not_found"}}', false, "works"],
    [404, '{"type":"error","error":{"type":"not_found_error","message":"model: claude-x"}}', true, "wrong_model"],
    [403, '{"error":{"message":"Project `proj_x` does not have access to model `gpt-5`","code":"model_not_found"}}', true, "wrong_model"],
    [429, '{"error":{"message":"Rate limit reached for model `llama` on tokens per minute (TPM). Please try again in 2s.","code":"rate_limit_exceeded"}}', true, "busy"],
    [529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', true, "busy"],
    [500, "Internal Server Error", true, "unreachable"],
    [400, '{"error":{"message":"Unsupported parameter: max_tokens"}}', true, "works"],
  ] as const)("HTTP %i %s (named model: %s) is %s", (status, body, chosen, result) => {
    expect(probeVerdict(status, body, chosen)).toBe(result);
  });

  it("probes a small chat model and suggests the closest listed one", () => {
    expect(probeModel(["text-embedding-3-small", "gpt-5", "gpt-5-mini", "whisper-1"])).toBe("gpt-5-mini");
    expect(probeModel(["models/gemini-embedding-001", "models/gemini-2.5-pro"])).toBe("gemini-2.5-pro");
    expect(probeModel(["omni-moderation-latest"])).toBeUndefined();
    expect(suggestModel(["llama-3.1-8b-instant", "llama-3.3-70b-versatile"], "llama-3.3-70b")).toBe("llama-3.3-70b-versatile");
    expect(suggestModel(["mistral-small-latest", "codestral-latest"], "mistral-large-2407")).toBe("mistral-small-latest");
    expect(suggestModel(["kimi-k2"], "gpt-5")).toBe("kimi-k2");
  });
});

type Seen = { method: string; path: string; body: string; headers: IncomingMessage["headers"] };

// A local stand-in for a provider; no real provider or engine is contacted in this file.
describe("a pasted key, checked with one provider call", () => {
  let server: Server;
  let base: string;
  let seen: Seen[];
  let reply: (request: Seen) => { status: number; body: unknown };

  beforeEach(async () => {
    seen = [];
    reply = () => ({ status: 200, body: { choices: [] } });
    server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = { method: req.method ?? "", path: req.url ?? "", body, headers: req.headers };
      seen.push(request);
      const key = req.headers["x-api-key"] ?? req.headers.authorization?.replace(/^Bearer /, "");
      if (key !== KEY && !(key === "public" && request.path.endsWith("/models"))) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${String(key)}` } }));
        return;
      }
      if (request.path.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "big-model" }, { id: "small-mini" }, { id: "text-embed" }] }));
        return;
      }
      const answer = reply(request);
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("says works after a 1-token reply from a small listed model, and never sends the key anywhere else", async () => {
    const verdict = await verifyProviderKey({ provider: "groq", key: KEY, url: base });
    expect(verdict).toEqual({ ok: true, check: "models", models: ["big-model", "small-mini", "text-embed"], result: "works", model: "small-mini" });
    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /v1/models", "POST /v1/chat/completions"]);
    expect(JSON.parse(seen[1]!.body)).toEqual({ model: "small-mini", messages: [{ role: "user", content: "Say ok." }], stream: false, max_tokens: 1 });
    expect(JSON.stringify(verdict)).not.toContain("SECRET");
  });

  it("says wrong key at the model list, without spending a reply", async () => {
    expect(await verifyProviderKey({ provider: "groq", key: "sk-wrong", url: base })).toEqual({ ok: false, reason: "rejected", status: 401, result: "wrong_key" });
    expect(seen).toHaveLength(1);
  });

  it("says wrong key when only the reply refuses it, for a provider whose list is public", async () => {
    const verdict = await verifyProviderKey({ provider: "openaiCompat", key: "public", url: base });
    expect(verdict).toMatchObject({ ok: false, reason: "rejected", status: 401, result: "wrong_key" });
    expect(JSON.stringify(verdict)).not.toContain("public");
  });

  it("says no credit, and keeps the provider's words out of the answer", async () => {
    reply = () => ({ status: 402, body: { error: { message: `Insufficient Balance for ${KEY}` } } });
    const verdict = await verifyProviderKey({ provider: "mistral", key: KEY, url: base });
    expect(verdict).toMatchObject({ ok: false, reason: "credits", status: 402, result: "no_credit" });
    expect(JSON.stringify(verdict)).not.toContain("SECRET");
  });

  it("says wrong model for the person's own model, with a listed one to use instead", async () => {
    reply = (request) => JSON.parse(request.body).model === "big-model-v2"
      ? { status: 404, body: { error: { message: "The model `big-model-v2` does not exist", code: "model_not_found" } } }
      : { status: 200, body: {} };
    expect(await verifyProviderKey({ provider: "openaiCompat", key: KEY, url: base, model: "big-model-v2" })).toEqual({
      ok: false, reason: "model", status: 404, models: ["big-model", "small-mini", "text-embed"], result: "wrong_model", model: "big-model-v2", suggestedModel: "big-model",
    });
  });

  it("calls a busy provider's key working", async () => {
    reply = () => ({ status: 429, body: { error: { message: "Rate limit reached, please try again in 2s.", code: "rate_limit_exceeded" } } });
    expect(await verifyProviderKey({ provider: "cerebras", key: KEY, url: base })).toMatchObject({ ok: true, result: "busy" });
  });

  it("speaks Anthropic's messages API for an Anthropic key", async () => {
    await verifyProviderKey({ provider: "anthropic", key: KEY, url: base.replace(/\/v1$/, ""), model: "claude-fixture" });
    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /v1/models", "POST /v1/messages"]);
    expect(seen[1]!.headers).toMatchObject({ "x-api-key": KEY, "anthropic-version": "2023-06-01" });
    expect(JSON.parse(seen[1]!.body)).toEqual({ model: "claude-fixture", max_tokens: 1, messages: [{ role: "user", content: "Say ok." }] });
  });

  it("says unreachable for a provider that does not answer in time", async () => {
    const hanging: typeof fetch = (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    expect(await verifyProviderKey({ provider: "groq", key: KEY }, hanging, 50)).toEqual({ ok: false, reason: "unreachable", result: "unreachable" });
  });

  describe("POST /api/keys/test", () => {
    const route = (options: { auth?: "loopback" | "session"; sealer?: CardSealer } = {}) => {
      const routes = [createStatusRoutes({ cfg: { groq: { url: base } }, store: { bots: [] }, sealer: options.sealer } as unknown as StatusRouteDeps)];
      const api = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const auth = { kind: options.auth ?? "loopback", scopes: ["admin"] } as unknown as RequestAuth;
        if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
      });
      return new Promise<{ post: (body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>; close: () => Promise<void> }>((ready) => {
        api.listen(0, "127.0.0.1", () => {
          const at = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/keys/test`;
          ready({
            post: async (body) => {
              const response = await fetch(at, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
              return { status: response.status, body: await response.json() as Record<string, unknown> };
            },
            close: () => new Promise((done) => api.close(() => done())),
          });
        });
      });
    };

    it("checks a pasted key and model before anything is saved, and refuses malformed input", async () => {
      const { post, close } = await route();
      try {
        reply = (request) => JSON.parse(request.body).model === "missing"
          ? { status: 404, body: { error: { message: "model `missing` not found", code: "model_not_found" } } }
          : { status: 200, body: {} };
        expect(await post({ provider: "groq", key: KEY })).toMatchObject({ status: 200, body: { ok: true, result: "works" } });
        expect(await post({ provider: "groq", key: KEY, model: "missing" })).toMatchObject({ status: 200, body: { result: "wrong_model", suggestedModel: "big-model" } });
        expect(await post({ provider: "groq", key: "sk-wrong" })).toMatchObject({ status: 200, body: { ok: false, result: "wrong_key" } });
        for (const body of [{ provider: "groq", key: KEY, model: "has spaces" }, { provider: "groq", key: KEY, model: 7 }, { provider: "groq", key: KEY, url: 7 }, { provider: "nope", key: KEY }]) {
          expect((await post(body)).status).toBe(400);
        }
        expect(JSON.stringify(seen.map((request) => request.path))).not.toContain("SECRET");
      } finally {
        await close();
      }
    });

    it("takes a key from anything but this computer's own app only sealed for this check", async () => {
      const sealer = createCardSealer();
      const { post, close } = await route({ auth: "session", sealer });
      try {
        expect(await post({ provider: "groq", key: KEY })).toMatchObject({ status: 400, body: { code: "seal_required" } });
        const wrongPurpose = await sealValues({ key: KEY }, sealer.publicKey(), "model-provider", ["groq"]);
        expect((await post({ provider: "groq", sealed: wrongPurpose })).status).toBeGreaterThanOrEqual(400);
        const sealed = await sealValues({ key: KEY }, sealer.publicKey(), "key.test", ["groq"]);
        expect(await post({ provider: "groq", sealed })).toMatchObject({ status: 200, body: { ok: true, result: "works" } });
      } finally {
        await close();
      }
      const unsealable = await route({ auth: "session" });
      try {
        expect((await unsealable.post({ provider: "groq", key: KEY })).status).toBe(400);
      } finally {
        await unsealable.close();
      }
    });

    it("is for admins only", async () => {
      const { requiredScope } = await import("./request-auth.ts");
      expect(requiredScope("POST", "/api/keys/test")).toBe("admin");
    });
  });
});
