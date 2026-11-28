import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  VOICE_KEYS_CREDENTIAL_KEY, createRealtimeSession, findWhisperCpp, installVoiceInput, sessionOptions, voiceKeyStatus, whisperRunner, whisperText,
} from "./voice-input-main.mjs";
import { encodeWav16 } from "./voice-providers.mjs";

const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function contents() {
  const page = Object.assign(new EventEmitter(), { sent: [], destroyed: false });
  page.send = (channel, payload) => page.sent.push([channel, payload]);
  page.isDestroyed = () => page.destroyed;
  return page;
}

function harness({ credentials = {}, fetch = async () => ok({ text: "" }), placePage = () => false, ...rest } = {}) {
  const h = { handlers: new Map(), listeners: new Map(), guards: [], credentials, writes: 0, log: [] };
  h.voice = installVoiceInput({
    ipcMain: { handle: (channel, handler) => h.handlers.set(channel, handler), on: (channel, handler) => h.listeners.set(channel, handler) },
    localOnly: (channel, handler) => {
      h.guards.push(channel);
      return (...args) => handler(...args);
    },
    placePage,
    readCredentials: () => structuredClone(h.credentials),
    updateCredentials: async (derive) => { h.writes += 1; h.credentials = await derive(structuredClone(h.credentials)); return h.credentials; },
    log: line => h.log.push(line),
    fetch, findWhisper: async () => ({ binaries: [], models: [] }), checkWhisperCpp: async () => {},
    ...rest,
  });
  h.page = contents();
  h.invoke = (channel, ...args) => h.handlers.get(channel)({ sender: h.page }, ...args);
  h.audio = (id, pcm, sender = h.page) => h.listeners.get("voice-input:audio")({ sender }, id, pcm);
  return h;
}

const loud = ms => new Int16Array(Math.round(ms * 16)).fill(8_000);
const quiet = ms => new Int16Array(Math.round(ms * 16));

const VOICE_CHANNELS = ["voice-input:keys:status", "voice-input:keys:set", "voice-input:keys:clear", "voice-input:find-whisper",
  "voice-input:start", "voice-input:finish", "voice-input:stop", "voice-input:audio"];

test("every channel answers this computer's page or a place the person chose, and nowhere else", async () => {
  const local = harness();
  assert.equal((await local.invoke("voice-input:keys:status")).openai, false);
  assert.deepEqual(local.guards, ["voice-input:keys:status"]);
  local.audio("x", new ArrayBuffer(0));
  assert.ok(local.guards.includes("voice-input:audio"));

  const place = harness({
    placePage: () => true,
    credentials: { [VOICE_KEYS_CREDENTIAL_KEY]: { openai: "sk-secret" } },
  });
  assert.equal((await place.invoke("voice-input:keys:status")).openai, true);
  const { id } = await place.invoke("voice-input:start", { provider: "openai" });
  assert.equal(place.voice.active(), 1);
  await place.invoke("voice-input:stop", id);
  assert.equal(place.voice.active(), 0);
  assert.deepEqual(place.guards, []);
  assert.deepEqual(new Set(VOICE_CHANNELS).size, VOICE_CHANNELS.length);
});

test("keys: saved in the credential document, status is booleans only, clear removes them", async () => {
  const h = harness({ credentials: { other: "kept" } });
  await h.invoke("voice-input:keys:set", "openai", "  sk-secret-value  ");
  assert.equal(h.credentials[VOICE_KEYS_CREDENTIAL_KEY].openai, "sk-secret-value");
  assert.equal(h.credentials.other, "kept");
  const status = await h.invoke("voice-input:keys:status");
  assert.equal(status.openai, true);
  assert.equal(status.groq, false);
  assert.equal("whisper-cpp" in status, false);
  assert.ok(Object.values(status).every(value => typeof value === "boolean"));
  assert.doesNotMatch(JSON.stringify(status), /sk-secret-value/);
  await h.invoke("voice-input:keys:clear", "openai");
  assert.equal(VOICE_KEYS_CREDENTIAL_KEY in h.credentials, false);
  assert.equal(h.credentials.other, "kept");
});

test("keys: bad services and bad keys are refused before anything is written", async () => {
  const h = harness();
  for (const [provider, key] of [["nope", "k"], ["whisper-cpp", "k"], ["__proto__", "k"], ["openai", ""], ["openai", "has space"], ["openai", "x".repeat(5_000)], ["openai", 42]]) {
    await assert.rejects(Promise.resolve().then(() => h.invoke("voice-input:keys:set", provider, key)));
  }
  await assert.rejects(Promise.resolve().then(() => h.invoke("voice-input:keys:clear", "constructor")));
  assert.equal(h.writes, 0);
});

test("voiceKeyStatus ignores junk in the stored document", () => {
  assert.deepEqual(voiceKeyStatus({ [VOICE_KEYS_CREDENTIAL_KEY]: { openai: 5, groq: "g", "whisper-cpp": "x", evil: "y" } }),
    { elevenlabs: false, openai: false, groq: true, deepgram: false, assemblyai: false, "openai-compatible": false });
  assert.equal(voiceKeyStatus({ [VOICE_KEYS_CREDENTIAL_KEY]: ["x"] }).openai, false);
});

test("start options are checked field by field", () => {
  assert.deepEqual(sessionOptions({ provider: "groq", language: "en-US", model: "whisper-large-v3", extra: "dropped" }),
    { provider: "groq", language: "en-US", model: "whisper-large-v3", realtime: false, baseUrl: undefined, whisperCpp: undefined });
  for (const bad of [null, "groq", { provider: "nope" }, { provider: "groq", language: "en US; rm" }, { provider: "groq", model: "a b" },
    { provider: "groq", model: "m".repeat(101) }, { provider: "groq", language: 5 }, { provider: "openai-compatible", baseUrl: {} }]) {
    assert.throws(() => sessionOptions(bad));
  }
});

test("start without a key rejects with a plain message, and no session is made", async () => {
  const h = harness();
  await assert.rejects(Promise.resolve().then(() => h.invoke("voice-input:start", { provider: "openai" })), /Add your OpenAI key/);
  await assert.rejects(Promise.resolve().then(() => h.invoke("voice-input:start", { provider: "openai-compatible" })), /address/);
  assert.equal(h.voice.active(), 0);
});

test("a batch session: audio in, pieces to the service with the saved key, words and one end back", async () => {
  const calls = [];
  let n = 0;
  const h = harness({
    credentials: { [VOICE_KEYS_CREDENTIAL_KEY]: { groq: "gsk-secret" } },
    fetch: async (url, init) => { calls.push({ url, init }); n += 1; return ok({ text: `word${n}` }); },
  });
  const { id } = await h.invoke("voice-input:start", { provider: "groq", language: "en" });
  assert.match(id, /^[0-9a-f-]{36}$/);
  h.audio(id, loud(400).buffer);
  h.audio(id, quiet(800).buffer);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, "Bearer gsk-secret");
  h.audio(id, loud(300).buffer);
  await h.invoke("voice-input:finish", id);
  assert.deepEqual(h.page.sent, [
    ["voice-input:transcript", { id, text: "word1", partial: true }],
    ["voice-input:transcript", { id, text: "word1 word2", partial: true }],
    ["voice-input:transcript", { id, text: "word1 word2", partial: false }],
    ["voice-input:end", { id, code: 0, reason: "completed" }],
  ]);
  assert.doesNotMatch(JSON.stringify(h.page.sent), /gsk-secret/);
  assert.equal(h.voice.active(), 0);
});

test("audio is refused from another page, for another id, or when it is not 16-bit PCM", async () => {
  const calls = [];
  const h = harness({ credentials: { [VOICE_KEYS_CREDENTIAL_KEY]: { groq: "g" } }, fetch: async (url) => { calls.push(url); return ok({ text: "x" }); } });
  const { id } = await h.invoke("voice-input:start", { provider: "groq" });
  const other = contents();
  h.audio(id, loud(400).buffer, other);
  h.audio("not-an-id", loud(400).buffer);
  h.audio(id, new ArrayBuffer(3));
  h.audio(id, "text");
  h.audio(id, new ArrayBuffer(300 * 1024));
  h.audio(id, quiet(900).buffer);
  await h.invoke("voice-input:finish", id);
  assert.equal(calls.length, 0);
  // a stranger cannot finish or stop it either
  const second = await h.invoke("voice-input:start", { provider: "groq" });
  await h.handlers.get("voice-input:stop")({ sender: other }, second.id);
  assert.equal(h.voice.active(), 1);
  h.voice.close();
});

test("too much audio finishes the session with what was heard", async () => {
  const h = harness({ credentials: { [VOICE_KEYS_CREDENTIAL_KEY]: { groq: "g" } }, fetch: async () => ok({ text: "capped" }), maxBytes: 30_000 });
  const { id } = await h.invoke("voice-input:start", { provider: "groq" });
  h.audio(id, loud(600).buffer);
  h.audio(id, loud(600).buffer);
  await settle();
  assert.deepEqual(h.page.sent.at(-1), ["voice-input:end", { id, code: 0, reason: "max-duration" }]);
});

test("one session per page; a closed page ends its session; a service failure ends with its reason", async () => {
  const h = harness({ credentials: { [VOICE_KEYS_CREDENTIAL_KEY]: { openai: "o" } }, fetch: async () => new Response("{}", { status: 401 }) });
  const first = await h.invoke("voice-input:start", { provider: "openai" });
  const second = await h.invoke("voice-input:start", { provider: "openai" });
  assert.notEqual(first.id, second.id);
  assert.equal(h.voice.active(), 1);
  h.audio(second.id, loud(400).buffer);
  h.audio(second.id, quiet(800).buffer);
  await settle();
  const [, end] = h.page.sent.at(-1);
  assert.equal(end.id, second.id);
  assert.equal(end.code, 1);
  assert.equal(end.reason, "service-bad-key");
  assert.equal(h.voice.active(), 0);
  await h.invoke("voice-input:start", { provider: "openai" });
  h.page.destroyed = true;
  h.page.emit("destroyed");
  assert.equal(h.voice.active(), 0);
});

test("stop drops the session without words or an end", async () => {
  const h = harness({ credentials: { [VOICE_KEYS_CREDENTIAL_KEY]: { openai: "o" } }, fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))) });
  const { id } = await h.invoke("voice-input:start", { provider: "openai" });
  h.audio(id, loud(400).buffer);
  h.audio(id, quiet(800).buffer);
  await h.invoke("voice-input:stop", id);
  await settle();
  assert.deepEqual(h.page.sent, []);
  assert.equal(h.voice.active(), 0);
});

test("whisperText drops timestamps and markers", () => {
  assert.equal(whisperText("\n [00:00:00.000 --> 00:00:02.000]  Hello there.\n [BLANK_AUDIO]\n (wind blowing)\n  General Kenobi.\n"), "Hello there. General Kenobi.");
});

test("whisper.cpp: a temp WAV per piece, the program with -m -f -l -nt -np and no shell, the folder removed after", async () => {
  const spawned = [];
  let wavPath = null;
  const spawn = (binary, args, options) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
    spawned.push({ binary, args, options });
    wavPath = args[args.indexOf("-f") + 1];
    assert.ok(existsSync(wavPath));
    setImmediate(() => { child.stdout.emit("data", " Hello from whisper.\n"); child.emit("close", 0); });
    return child;
  };
  const run = whisperRunner({ binary: "/opt/homebrew/bin/whisper-cli", model: "/models/ggml-base.en.bin", language: "en-GB", spawn });
  assert.equal(await run(encodeWav16(new Int16Array(16))), "Hello from whisper.");
  assert.deepEqual(spawned[0].args, ["-m", "/models/ggml-base.en.bin", "-f", wavPath, "-l", "en", "-nt", "-np"]);
  assert.equal(spawned[0].options.shell, undefined);
  assert.equal(existsSync(path.dirname(wavPath)), false);
});

test("whisper.cpp: a failed program is a service failure and still cleans up", async () => {
  let wavPath;
  const spawn = (_binary, args) => {
    wavPath = args[args.indexOf("-f") + 1];
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
    setImmediate(() => { child.stderr.emit("data", "error: failed to load model\n"); child.emit("close", 1); });
    return child;
  };
  await assert.rejects(whisperRunner({ binary: "/x/whisper-cli", model: "/m/ggml-a.bin", spawn })(encodeWav16(new Int16Array(4))), { reason: "service" });
  assert.equal(existsSync(path.dirname(wavPath)), false);
});

test("whisper.cpp start refuses programs that are not whisper.cpp", async () => {
  const h = harness({ checkWhisperCpp: undefined });
  for (const whisperCpp of [{ binary: "/bin/sh", model: "/m/ggml-a.bin" }, { binary: "whisper-cli", model: "/m/ggml-a.bin" }, { binary: "/nowhere/whisper-cli", model: "/m/ggml-a.bin" }]) {
    await assert.rejects(Promise.resolve().then(() => h.invoke("voice-input:start", { provider: "whisper-cpp", whisperCpp })), /whisper\.cpp/);
  }
  assert.equal(h.voice.active(), 0);
});

test("findWhisperCpp finds programs on PATH and ggml models in the usual folders", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "voice-home-"));
  try {
    const { mkdir, writeFile, chmod } = await import("node:fs/promises");
    const bin = path.join(home, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "whisper-cli"), "#!/bin/sh\n");
    await chmod(path.join(bin, "whisper-cli"), 0o755);
    await mkdir(path.join(home, ".cache", "whisper"), { recursive: true });
    await writeFile(path.join(home, ".cache", "whisper", "ggml-base.en.bin"), "x");
    await writeFile(path.join(home, ".cache", "whisper", "notes.txt"), "x");
    const found = await findWhisperCpp({ env: { PATH: bin }, homedir: home, platform: "darwin" });
    assert.ok(found.binaries.includes(path.join(bin, "whisper-cli")));
    assert.ok(found.models.includes(path.join(home, ".cache", "whisper", "ggml-base.en.bin")));
    assert.ok(found.models.every(file => /ggml-.*\.bin$/.test(file)));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

class FakeSocket extends EventTarget {
  static last = null;
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.last = this;
    setImmediate(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  message(body) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(body) })); }
}

test("ElevenLabs realtime: a single-use token, never the key, on the socket; partials and commits become cumulative words", async () => {
  const fetches = [];
  const texts = [], errors = [];
  const session = createRealtimeSession({
    key: "xi-secret", model: "scribe_v2_realtime", language: "en-US",
    onText: (text, partial) => texts.push([text, partial]), onError: error => errors.push(error),
    fetch: async (url, init) => { fetches.push({ url, init }); return ok({ token: "sutkn_abc" }); },
    WebSocket: FakeSocket,
  });
  session.push(loud(100));
  await settle();
  assert.equal(fetches[0].url, "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe");
  assert.equal(fetches[0].init.headers["xi-api-key"], "xi-secret");
  const socket = FakeSocket.last;
  const url = new URL(socket.url);
  assert.equal(url.origin + url.pathname, "wss://api.elevenlabs.io/v1/speech-to-text/realtime");
  assert.equal(url.searchParams.get("token"), "sutkn_abc");
  assert.equal(url.searchParams.get("model_id"), "scribe_v2_realtime");
  assert.equal(url.searchParams.get("audio_format"), "pcm_16000");
  assert.equal(url.searchParams.get("language_code"), "en");
  assert.doesNotMatch(socket.url, /xi-secret/);
  assert.equal(socket.sent[0].message_type, "input_audio_chunk");
  assert.equal(socket.sent[0].commit, false);
  assert.equal(socket.sent[0].sample_rate, 16_000);
  assert.equal(Buffer.from(socket.sent[0].audio_base_64, "base64").length, 1_600 * 2);
  socket.message({ message_type: "session_started", session_id: "s" });
  socket.message({ message_type: "partial_transcript", text: "hello" });
  socket.message({ message_type: "committed_transcript", text: "Hello." });
  socket.message({ message_type: "committed_transcript_with_timestamps", text: "Hello.", words: [] });
  socket.message({ message_type: "partial_transcript", text: "how are" });
  const finished = session.finish();
  assert.deepEqual(socket.sent.at(-1), { message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: 16_000 });
  socket.message({ message_type: "committed_transcript", text: "How are you?" });
  await finished;
  assert.deepEqual(texts, [["hello", true], ["Hello.", true], ["Hello. how are", true], ["Hello. How are you?", true], ["Hello. How are you?", false]]);
  assert.deepEqual(errors, []);
  assert.equal(socket.readyState, 3);
});

test("ElevenLabs realtime: an auth error from the socket ends as bad-key; a refused token too", async () => {
  const errors = [];
  createRealtimeSession({ key: "k", model: "m", onText() {}, onError: e => errors.push(e), fetch: async () => ok({ token: "t" }), WebSocket: FakeSocket });
  await settle();
  FakeSocket.last.message({ message_type: "auth_error", error: "bad token" });
  assert.equal(errors[0].reason, "bad-key");
  createRealtimeSession({ key: "k", model: "m", onText() {}, onError: e => errors.push(e), fetch: async () => new Response("{}", { status: 401 }), WebSocket: FakeSocket });
  await settle();
  assert.equal(errors[1].reason, "bad-key");
});

test("ElevenLabs realtime: a refused token says why in the log, never on the card, and a key ElevenLabs refuses with 400 reads as the key", async () => {
  const errors = [];
  const refuse = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  createRealtimeSession({ key: "k", model: "m", onText() {}, onError: e => errors.push(e), WebSocket: FakeSocket,
    fetch: refuse(400, { detail: { status: "missing_permissions", message: "The API key you used is missing the permission speech_to_text to execute this operation." } }) });
  createRealtimeSession({ key: "k", model: "m", onText() {}, onError: e => errors.push(e), WebSocket: FakeSocket,
    fetch: refuse(400, { detail: { status: "invalid_model", message: "scribe_v9 is not a model" } }) });
  await settle();
  assert.equal(errors[0].reason, "bad-key");
  assert.match(errors[0].detail, /missing_permissions.*speech_to_text/);
  assert.doesNotMatch(errors[0].message, /400|permission/);
  assert.equal(errors[1].reason, "service");
  assert.match(errors[1].detail, /400 invalid_model/);
  assert.doesNotMatch(errors[1].message, /400/);
});
