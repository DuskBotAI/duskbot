// The built-in voice: speech in and out on this computer, with no account or key. Models download on first use.
import type { IncomingMessage } from "node:http";
import { BUILT_IN_VOICES, DEFAULT_VOICE, isBuiltInVoice, KOKORO_RATE, MOONSHINE_RATE } from "../local-voice/engine.ts";
import type { DownloadState } from "../local-voice/models.ts";
import { decodeWav, encodeWav } from "../local-voice/wav.ts";
import { redactSecretsInText } from "../redact.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** About one minute of 16 kHz mono 16-bit PCM: a spoken turn, never a recording. */
export const LOCAL_TRANSCRIBE_MAX_BYTES = 2 * 1024 * 1024;
export const LOCAL_SPEAK_MAX_CHARS = 600;

export interface LocalVoiceDeps {
  available(): Promise<boolean>;
  status(): DownloadState;
  /** Starts the download if needed, then loads the models. */
  prepare(): Promise<void>;
  speak(text: string, voice: string, speed: number): Promise<Float32Array>;
  transcribe(samples: Float32Array): Promise<string>;
}

async function readCapped(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    // Answering before the upload is read to its end resets the connection on Windows instead of delivering the 413.
    req.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received <= max) chunks.push(chunk);
    });
    req.on("end", () => resolve(received > max ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createLocalVoiceRoutes(deps: LocalVoiceDeps): RouteHandler {
  let preparing: Promise<void> | null = null;
  const prepare = () => {
    preparing ??= deps.prepare().finally(() => {
      preparing = null;
    });
    return preparing;
  };
  return async ({ req, res, path, method, json, readBody }) => {
    if (!path.startsWith("/api/voice/local")) return PASS;
    if (method === "GET" && path === "/api/voice/local") {
      const available = await deps.available();
      return json(res, 200, {
        available,
        model: available ? deps.status() : { phase: "missing", hear: false, speak: false },
        voices: BUILT_IN_VOICES,
        defaultVoice: DEFAULT_VOICE,
      });
    }
    if (method === "POST" && path === "/api/voice/local/prepare") {
      if (!(await deps.available())) return json(res, 409, { error: "The built-in voice can't run on this computer." });
      const waiting = prepare();
      waiting.catch(() => undefined);
      const body = await readBody(req);
      if (body.wait === true) {
        try {
          await waiting;
        } catch (error) {
          return json(res, 502, { error: error instanceof Error ? error.message : String(error), model: deps.status() });
        }
      }
      return json(res, 202, { model: deps.status() });
    }
    if (method === "POST" && path === "/api/voice/local/speak") {
      const body = await readBody(req);
      const text = redactSecretsInText(String(body.text ?? "")).trim();
      if (!text) return json(res, 400, { error: "text required" });
      if (text.length > LOCAL_SPEAK_MAX_CHARS) return json(res, 413, { error: `spoken lines are limited to ${LOCAL_SPEAK_MAX_CHARS} characters` });
      const voice = isBuiltInVoice(body.voice) ? body.voice : DEFAULT_VOICE;
      const speed = typeof body.speed === "number" && Number.isFinite(body.speed) ? Math.min(1.4, Math.max(0.7, body.speed)) : 1;
      if (!deps.status().speak) return json(res, 409, { error: "The built-in voice is still getting ready.", model: deps.status() });
      try {
        const wav = encodeWav(await deps.speak(text, voice, speed), KOKORO_RATE);
        res.writeHead(200, { "content-type": "audio/wav", "content-length": String(wav.byteLength), "cache-control": "no-store" });
        res.end(Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength));
        return;
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (method === "POST" && path === "/api/voice/local/transcribe") {
      const rawType = req.headers["content-type"];
      const mime = (Array.isArray(rawType) ? rawType[0] : rawType)?.split(";")[0]?.trim().toLowerCase();
      if (mime !== "audio/wav") {
        req.resume();
        return json(res, 400, { error: "content-type must be audio/wav" });
      }
      if (Number(req.headers["content-length"] ?? 0) > LOCAL_TRANSCRIBE_MAX_BYTES) {
        req.resume();
        return json(res, 413, { error: `audio exceeds ${LOCAL_TRANSCRIBE_MAX_BYTES} bytes` });
      }
      const audio = await readCapped(req, LOCAL_TRANSCRIBE_MAX_BYTES);
      if (!audio) return json(res, 413, { error: `audio exceeds ${LOCAL_TRANSCRIBE_MAX_BYTES} bytes` });
      if (!deps.status().hear) return json(res, 409, { error: "The built-in voice is still getting ready.", model: deps.status() });
      let samples: Float32Array;
      try {
        samples = decodeWav(audio, MOONSHINE_RATE);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      try {
        return json(res, 200, { text: await deps.transcribe(samples) });
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return PASS;
  };
}
