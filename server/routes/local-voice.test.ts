import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { DownloadState } from "../local-voice/models.ts";
import { decodeWav, encodeWav } from "../local-voice/wav.ts";
import { createLocalVoiceRoutes, LOCAL_SPEAK_MAX_CHARS, type LocalVoiceDeps } from "./local-voice.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function fixture(over: Partial<LocalVoiceDeps> = {}) {
  const state = { model: { phase: "ready", hear: true, speak: true } as DownloadState, spoken: [] as Array<[string, string, number]>, heard: [] as number[], prepared: 0 };
  const deps: LocalVoiceDeps = {
    available: async () => true,
    status: () => state.model,
    prepare: async () => { state.prepared += 1; },
    speak: async (text, voice, speed) => {
      state.spoken.push([text, voice, speed]);
      return new Float32Array(2400).fill(0.25);
    },
    transcribe: async (samples) => {
      state.heard.push(samples.length);
      return "hello there";
    },
    ...over,
  };
  const routes = [createLocalVoiceRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { state, base };
}

describe("built-in voice routes", () => {
  it("reports the voices and whether the model is ready", async () => {
    const { base } = await fixture();
    const body = await (await fetch(`${base}/api/voice/local`)).json() as { voices: Array<{ id: string }> };
    expect(body).toMatchObject({ available: true, model: { phase: "ready" }, defaultVoice: "af_heart" });
    expect(body.voices.map((voice: { id: string }) => voice.id)).toContain("bm_george");
  });

  it("says it cannot run on a computer without the runtime", async () => {
    const { base } = await fixture({ available: async () => false });
    expect(await (await fetch(`${base}/api/voice/local`)).json()).toMatchObject({ available: false, model: { phase: "missing" } });
    expect((await fetch(`${base}/api/voice/local/prepare`, { method: "POST" })).status).toBe(409);
  });

  it("speaks a line as a WAV in the chosen voice, speed held to a sane range", async () => {
    const { base, state } = await fixture();
    const res = await fetch(`${base}/api/voice/local/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Sure thing.", voice: "bf_emma", speed: 3 }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(decodeWav(new Uint8Array(await res.arrayBuffer()), 24_000)).toHaveLength(2400);
    expect(state.spoken).toEqual([["Sure thing.", "bf_emma", 1.4]]);
  });

  it("falls back to the default voice and refuses empty or long lines", async () => {
    const { base, state } = await fixture();
    const post = (body: unknown) => fetch(`${base}/api/voice/local/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ text: "Hi", voice: "../../etc" })).status).toBe(200);
    expect(state.spoken[0]![1]).toBe("af_heart");
    expect((await post({ text: "   " })).status).toBe(400);
    expect((await post({ text: "a".repeat(LOCAL_SPEAK_MAX_CHARS + 1) })).status).toBe(413);
  });

  it("never speaks a secret it can recognise", async () => {
    const { base, state } = await fixture();
    await fetch(`${base}/api/voice/local/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Your key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD" }) });
    expect(state.spoken[0]![0]).not.toContain("abcdefghijklmnop");
  });

  it("hears a spoken turn sent as a WAV", async () => {
    const { base, state } = await fixture();
    const wav = encodeWav(new Float32Array(16_000).fill(0.1), 16_000);
    const res = await fetch(`${base}/api/voice/local/transcribe`, { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
    expect(await res.json()).toEqual({ text: "hello there" });
    expect(state.heard).toEqual([16_000]);
  });

  it("refuses audio that is not a WAV, and answers 409 while the model downloads", async () => {
    const { base, state } = await fixture();
    expect((await fetch(`${base}/api/voice/local/transcribe`, { method: "POST", headers: { "content-type": "audio/webm" }, body: "x" })).status).toBe(400);
    expect((await fetch(`${base}/api/voice/local/transcribe`, { method: "POST", headers: { "content-type": "audio/wav" }, body: "not a wav" })).status).toBe(400);
    state.model = { phase: "downloading", received: 10, total: 100, hear: true, speak: false, background: false };
    const busy = await fetch(`${base}/api/voice/local/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ model: { phase: "downloading", received: 10 } });
  });

  it("starts preparing once, however many clients ask", async () => {
    let finish: () => void = () => {};
    const { base, state } = await fixture({ prepare: () => { state.prepared += 1; return new Promise<void>((resolve) => { finish = resolve; }); } });
    await Promise.all([1, 2, 3].map(() => fetch(`${base}/api/voice/local/prepare`, { method: "POST" })));
    expect(state.prepared).toBe(1);
    finish();
  });
});
