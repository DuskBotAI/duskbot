import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveProxy } from "../proxy-paths.ts";

export type VoiceRequest =
  | { op: "warm"; halves: { hear: boolean; speak: boolean } }
  | { op: "speak"; text: string; voice: string; speed: number }
  | { op: "transcribe"; samples: Float32Array };

type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

export interface VoiceProcess {
  /** False once ONNX Runtime has crashed on this computer with this app version: calls use the computer's own voice. */
  usable(): boolean;
  warm(halves: { hear: boolean; speak: boolean }): Promise<void>;
  speak(text: string, voice: string, speed: number): Promise<Float32Array>;
  transcribe(samples: Float32Array): Promise<string>;
  stop(): void;
}

const DEFAULT_VOICE_IDLE_MS = 3 * 60_000;

/** ONNX Runtime 1.31.1 has taken down the whole harness on Windows and Linux while loading the voice's models, so it
 * runs in a child of its own; a crash there ends only the voice. */
export function createVoiceProcess({ modelDir, entry = resolveProxy("local-voice/voice-worker"), version = process.env.DUSK_APP_VERSION || "dev", idleMs, log = () => {} }: {
  modelDir: string;
  entry?: string;
  version?: string;
  idleMs?: number;
  log?: (line: string) => void;
}): VoiceProcess {
  const configuredIdle = Number(process.env.DUSK_VOICE_IDLE_MS);
  const idleTimeoutMs = idleMs ?? (Number.isFinite(configuredIdle) && configuredIdle >= 1_000 ? configuredIdle : DEFAULT_VOICE_IDLE_MS);
  const marker = path.join(modelDir, "runtime-crashed.json");
  let crashed = (() => {
    try {
      return JSON.parse(readFileSync(marker, "utf8")).version === version;
    } catch {
      return false;
    }
  })();
  type Pending = Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  let child: { proc: ChildProcess; pending: Pending } | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const stopped = new WeakSet<ChildProcess>();
  let nextId = 1;

  const clearIdle = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  const stopChild = () => {
    clearIdle();
    if (!child) return;
    stopped.add(child.proc);
    child.proc.kill();
    child = null;
  };

  const armIdle = () => {
    clearIdle();
    if (!child || child.pending.size > 0 || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (child && child.pending.size === 0) stopChild();
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };

  const start = () => {
    const pending: Pending = new Map();
    const failAll = (error: Error) => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };
    const proc = fork(entry, [], {
      execPath: process.execPath,
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DUSK_VOICE_MODELS_DIR: modelDir },
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    proc.on("message", (reply: Reply) => {
      const waiter = pending.get(reply.id);
      if (!waiter) return;
      pending.delete(reply.id);
      if (reply.ok) waiter.resolve(reply.value);
      else waiter.reject(new Error(reply.error));
      if (child?.proc === proc && pending.size === 0) armIdle();
    });
    proc.once("error", (error) => {
      if (child?.proc === proc) child = null;
      clearIdle();
      failAll(error);
    });
    proc.once("exit", (code, signal) => {
      if (child?.proc === proc) child = null;
      clearIdle();
      if (stopped.has(proc)) return failAll(new Error("the built-in voice was stopped"));
      crashed = true;
      log(`built-in voice process crashed (code=${code} signal=${signal}); calls use this computer's own voice until the app updates`);
      try {
        mkdirSync(modelDir, { recursive: true });
        writeFileSync(marker, JSON.stringify({ version, code, signal }));
      } catch {
      }
      failAll(new Error("the built-in voice cannot run on this computer"));
    });
    proc.unref();
    proc.channel?.unref();
    return { proc, pending };
  };

  const request = <T>(message: VoiceRequest): Promise<T> => {
    if (crashed) return Promise.reject(new Error("the built-in voice cannot run on this computer"));
    clearIdle();
    const { proc, pending } = (child ??= start());
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      proc.send({ ...message, id }, (error) => {
        if (error && pending.delete(id)) {
          if (pending.size === 0) armIdle();
          reject(error);
        }
      });
    });
  };

  return {
    usable: () => !crashed,
    warm: (halves) => request({ op: "warm", halves }),
    speak: (text, voice, speed) => request({ op: "speak", text, voice, speed }),
    transcribe: (samples) => request({ op: "transcribe", samples }),
    stop: stopChild,
  };
}
