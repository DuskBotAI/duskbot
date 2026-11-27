import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { addHeldSecretScrubber } from "../redact.ts";
import { VOICE_FIRST_BLOCK_MAX_CHARS } from "../tts/speech-text.ts";
import { PASS } from "./table.ts";
import { createTtsRoutes, TRANSCRIBE_MAX_BYTES } from "./tts.ts";

async function call(method: string, path: string, body: unknown = {}, cfg = {} as AppConfig, req = {} as never) {
  const answers: Array<[number, unknown]> = [];
  const out = await createTtsRoutes({ config: () => cfg })({
    req, res: {} as never, url: new URL(`http://x${path}`), path: new URL(`http://x${path}`).pathname, method,
    auth: { kind: "loopback", scopes: ["admin", "client"] },
    json: ((_res: unknown, status: number, value: unknown) => { answers.push([status, value]); }) as never, readBody: (async () => body) as never,
  });
  return { out, answers };
}

describe("voice routes", () => {
  it("leave every other path to the next route", async () => {
    expect((await call("GET", "/api/connectors/catalog")).out).toBe(PASS);
    expect((await call("DELETE", "/api/tts/voices")).out).toBe(PASS);
  });

  it("add a Voice Library voice only with an owner, a voice id and a name made of plain ids", async () => {
    for (const body of [{}, { publicOwnerId: "owner1", voiceId: "../voices", name: "x" }, { publicOwnerId: "owner1", voiceId: "v1", name: " " }]) {
      expect((await call("POST", "/api/tts/voices/add", body)).answers).toEqual([[400, { error: "publicOwnerId, voiceId and name required" }]]);
    }
  });

  it("prepare a reply with a short first block, and never a held secret", async () => {
    const remove = addHeldSecretScrubber((text) => text.replaceAll("correct-horse-battery", "••••••"));
    try {
      const text = `I logged in with correct-horse-battery and then ${Array.from({ length: 30 }, (_, i) => `checked item ${i}`).join(", ")}. Done.`;
      const { answers } = await call("POST", "/api/tts/prepare", { text });
      const { utterances } = answers[0]![1] as { utterances: string[] };
      expect(utterances[0]!.length).toBeLessThanOrEqual(VOICE_FIRST_BLOCK_MAX_CHARS);
      expect(utterances.length).toBeGreaterThan(2);
      expect(utterances.join(" ")).not.toContain("correct-horse-battery");
    } finally {
      remove();
    }
  });

  it("list no voices, and say why, when no voice provider is set up", async () => {
    const { answers } = await call("GET", "/api/tts/voices?q=calm");
    expect(answers).toHaveLength(1);
    expect(answers[0]![0]).toBe(200);
    const voices = (answers[0]![1] as { voices: Array<{ id: string }> }).voices;
    // a Mac lists its own built-in voices (the built-in voice is the default); no provider adds any
    if (process.platform === "darwin") expect(voices.every((voice) => !voice.id.includes(":"))).toBe(true);
    else expect(voices).toEqual([]);
  });
});

describe("transcribe route", () => {
  afterEach(() => vi.unstubAllGlobals());
  const withKey = { tts: { fishKey: "fish-key" } } as AppConfig;
  const upload = (bytes: Buffer, type = "audio/wav") =>
    Object.assign(Readable.from([bytes]), { headers: { "content-type": type, "content-length": String(bytes.byteLength) } }) as never;

  it("refuses anything but WAV audio", async () => {
    const { answers } = await call("POST", "/api/tts/transcribe", {}, withKey, upload(Buffer.from("x"), "application/json"));
    expect(answers).toEqual([[400, { error: "content-type must be audio/wav" }]]);
  });

  it("asks for a key that can listen when none is saved", async () => {
    const { answers } = await call("POST", "/api/tts/transcribe", {}, {} as AppConfig, upload(Buffer.from("x")));
    expect(answers[0]![0]).toBe(409);
    expect((answers[0]![1] as { error: string }).error).toContain("Fish Audio key");
  });

  it("refuses audio over the cap", async () => {
    const { answers } = await call("POST", "/api/tts/transcribe", {}, withKey, upload(Buffer.alloc(TRANSCRIBE_MAX_BYTES + 1)));
    expect(answers[0]![0]).toBe(413);
  });

  it("returns the text Fish heard", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ text: "hi bot" }), { status: 200 })));
    const { answers } = await call("POST", "/api/tts/transcribe", {}, withKey, upload(Buffer.from("RIFF")));
    expect(answers).toEqual([[200, { text: "hi bot" }]]);
  });

  it("hears with another connected key when there is no Fish key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "hello from deepgram" }] }] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cfg = { openai: { key: "sk-proj-x" }, tts: { deepgramKey: "dg-key" } } as AppConfig;
    const { answers } = await call("POST", "/api/tts/transcribe", {}, cfg, upload(Buffer.from("RIFF")));
    expect(answers).toEqual([[200, { text: "hello from deepgram" }]]);
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toMatch(/^https:\/\/api\.deepgram\.com\/v1\/listen\?/);
  });

  it("hears in the language the call asks for, and lets the service detect it otherwise", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: "какая погода завтра" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cfg = { openai: { key: "sk-proj-x" } } as AppConfig;
    const sent = (index: number) => ((fetchMock.mock.calls[index] as unknown as [string, RequestInit])[1].body as FormData).get("language");
    expect((await call("POST", "/api/tts/transcribe?language=ru-RU", {}, cfg, upload(Buffer.from("RIFF")))).answers).toEqual([[200, { text: "какая погода завтра" }]]);
    expect(sent(0)).toBe("ru");
    await call("POST", "/api/tts/transcribe?language=", {}, cfg, upload(Buffer.from("RIFF")));
    expect(sent(1)).toBeNull();
    await call("POST", "/api/tts/transcribe?language=..%2Fx", {}, cfg, upload(Buffer.from("RIFF")));
    expect(sent(2)).toBeNull();
  });

  it("answers 502 with Fish's message when Fish fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "nope" }), { status: 401 })));
    const { answers } = await call("POST", "/api/tts/transcribe", {}, withKey, upload(Buffer.from("RIFF")));
    expect(answers[0]![0]).toBe(502);
    expect((answers[0]![1] as { error: string }).error).toContain("rejected that API key");
  });
});
