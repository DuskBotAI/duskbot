import { availableMemory, boxMemory, type BoxMemory } from "../box-memory.ts";
import { engineMemory, type EngineMemory } from "../engine-memory.ts";
import { seenWithin } from "../thread-presence.ts";

export interface SessionIdlePolicy {
  idleMs: number;
  minimumMs: number;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
/** One warm engine and its MCP servers take 250 to 450 MB: on a box this small an idle one is soon given back, and the
 * next turn resumes its session by id. */
export const SMALL_BOX_BYTES = 1.5 * 1024 ** 3;
export const SMALL_BOX_IDLE_MS = 150_000;
const MINIMUM_IDLE_MS = 10_000;
/** setTimeout treats anything above 2^31-1 ms as 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

function usableMilliseconds(raw: string | undefined): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS ? value : null;
}

/** Per-harness names (DUSK_CLAUDE_SESSION_IDLE_*, DUSK_ACP_SESSION_IDLE_*) win over DUSK_SESSION_IDLE_MS /
 *  DUSK_SESSION_IDLE_MIN_MS, which win over the box's default; the floor is the greater of ten seconds and any configured
 *  minimum. */
export function sessionIdlePolicy(
  driverPrefix: string,
  env: Record<string, string | undefined> = process.env,
  boxBytes: number = boxMemory().bytes,
): SessionIdlePolicy {
  const minimumMs = Math.max(
    MINIMUM_IDLE_MS,
    usableMilliseconds(
      env[`DUSK_${driverPrefix}_SESSION_IDLE_MIN_MS`] ?? env.DUSK_SESSION_IDLE_MIN_MS,
    ) ?? 0,
  );
  const configured =
    usableMilliseconds(
      env[`DUSK_${driverPrefix}_SESSION_IDLE_MS`] ?? env.DUSK_SESSION_IDLE_MS,
    ) ?? (boxBytes <= SMALL_BOX_BYTES ? SMALL_BOX_IDLE_MS : DEFAULT_IDLE_MS);
  return { idleMs: Math.max(minimumMs, configured), minimumMs };
}

const GB = 1024 ** 3;
const DESKTOP_MIN_IDLE_ENGINES = 2;
const DESKTOP_MAX_IDLE_ENGINES = 4;

/** How many idle engines may stay warm simultaneously; capped on desktop too so idle Claude/Codex trees do not grow unbounded. */
export function idleEnginesAllowed(
  box: Pick<BoxMemory, "bytes">,
  availableBytes: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const override = env.DUSK_MAX_IDLE_ENGINES?.trim();
  if (override === "Infinity") return Infinity;
  const parsed = Number(override);
  if (override && Number.isInteger(parsed) && parsed >= 1) return parsed;
  if (box.bytes <= SMALL_BOX_BYTES) return availableBytes < box.bytes / 2 ? 1 : Infinity;
  const cap = Math.max(DESKTOP_MIN_IDLE_ENGINES, Math.min(DESKTOP_MAX_IDLE_ENGINES, Math.floor(box.bytes / (4 * GB))));
  return availableBytes < box.bytes / 4 ? Math.min(DESKTOP_MIN_IDLE_ENGINES, cap) : cap;
}

export interface WarmEngine {
  /** Still idle and free to close: no turn running, no hold keeping it up. */
  idle: () => boolean;
  close: () => void;
}

/** Idle engines of every driver, the longest idle first. */
const warmEngines = new Map<string, WarmEngine>();

/** An engine went idle: when the box allows fewer idle engines than are up, the ones idle longest close now. */
export function keepWarm(key: string, engine: WarmEngine, box: Pick<BoxMemory, "bytes"> = boxMemory(),
  available: () => number = availableMemory, env: Record<string, string | undefined> = process.env): void {
  warmEngines.delete(key);
  warmEngines.set(key, engine);
  for (const [other, warm] of warmEngines) if (other !== key && !warm.idle()) warmEngines.delete(other);
  const extra = warmEngines.size - idleEnginesAllowed(box, available(), env);
  if (extra <= 0) return;
  for (const [other, warm] of [...warmEngines].slice(0, extra)) {
    warmEngines.delete(other);
    warm.close();
  }
}

/** Closes an idle engine after `ms`, or sooner on a small box once another engine goes idle after it. */
export function armIdleClose(key: string, ms: number, engine: WarmEngine): ReturnType<typeof setTimeout> {
  const timer = setTimeout(engine.close, ms);
  timer.unref?.();
  keepWarm(key, engine);
  return timer;
}

export function stopIdleClose(key: string, timer: ReturnType<typeof setTimeout> | null): void {
  if (timer) clearTimeout(timer);
  warmEngines.delete(key);
}

export function warmEngineKeys(): string[] {
  return [...warmEngines.keys()];
}

/** A person wrote in, opened or read the thread this recently: it is the conversation in front of them. */
const WATCHED_MS = 30 * 60_000;
/** A thread nobody has in front of them (a teammate's delegated work, a routine) keeps its engine this long. */
export const UNWATCHED_IDLE_MS = 30_000;

/**
 * How long one thread's idle engine stays up after a turn. On a Cloud home: briefly for a thread no person has had in
 * front of them lately, and for the one they have, the configured time scaled by the memory left (down to a tenth).
 * Elsewhere the configured time.
 */
export function engineIdleMs(threadId: string, policy: SessionIdlePolicy, memory: Pick<EngineMemory, "enabled" | "headroom"> = engineMemory,
  now: number = Date.now()): number {
  if (!memory.enabled) return policy.idleMs;
  if (!seenWithin(threadId, WATCHED_MS, now)) return Math.max(policy.minimumMs, Math.min(policy.idleMs, UNWATCHED_IDLE_MS));
  return Math.max(policy.minimumMs, Math.round(policy.idleMs * memory.headroom()));
}
