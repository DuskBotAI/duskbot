// The computer-control driver (cua-driver) this app already runs, spoken to over its own stdio MCP client, for the
// screen jobs a dusk cloud's bots send this computer (cloud-mac.mjs). It acts through this app's own Accessibility and
// Screen Recording grants; nothing here opens a port.
import { spawn } from "node:child_process";

const IDLE_MS = 2 * 60_000;
const START_MS = 15_000;
const CALL_MS = 55_000;
const TEXT_MAX = 1_000_000;

/** The stdio command a ready driver connection names, or null (cua.mjs: embedded or standalone, never unavailable). */
export function driverCommand(connection) {
  if (!connection || (connection.mode !== "embedded" && connection.mode !== "standalone")) return null;
  if (typeof connection.mcpCommand !== "string" || !connection.mcpCommand || !Array.isArray(connection.mcpArgs) ||
      !connection.mcpArgs.every((arg) => typeof arg === "string")) return null;
  const env = connection.mcpEnv && typeof connection.mcpEnv === "object" ? connection.mcpEnv : {};
  return { command: connection.mcpCommand, args: connection.mcpArgs, env: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")) };
}

const failed = (text) => ({ content: [{ type: "text", text }], isError: true });

/** A driver result as a job outcome: its text joined, its first image, its structuredContent. */
export function screenOutcome(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").slice(0, TEXT_MAX);
  const picture = content.find((part) => part?.type === "image" && typeof part.data === "string" && (part.mimeType === "image/png" || part.mimeType === "image/jpeg"));
  const structured = result?.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent) ? result.structuredContent : undefined;
  return { ok: true, result: { text, ...(picture ? { image: { data: picture.data, mimeType: picture.mimeType } } : {}), ...(structured ? { structured } : {}), ...(result?.isError === true ? { isError: true } : {}) } };
}

/**
 * @param {{ connection(): any, spawnImpl?: typeof spawn, log?(line: string): void, idleMs?: number, requestAccess?(): Promise<unknown> }} deps
 *   `connection`: the driver record cua.mjs keeps; `requestAccess`: turns computer control on, asking for its grants.
 */
export function createScreenDriver(deps) {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const log = deps.log ?? (() => {});
  let child = null, key = null, ready = null, version = "", idle = null, sequence = 0;
  const waiting = new Map();

  const stop = () => {
    clearTimeout(idle);
    const was = child;
    child = null; ready = null; key = null;
    for (const done of waiting.values()) done({ error: { message: "The computer-control helper closed." } });
    waiting.clear();
    try { was?.kill(); } catch { /* gone */ }
  };
  const send = (method, params, ms) => new Promise((resolve) => {
    if (!child) return resolve({ error: { message: "The computer-control helper closed." } });
    const id = ++sequence;
    const timer = setTimeout(() => { waiting.delete(id); resolve({ error: { message: `${method} got no answer in ${Math.round(ms / 1000)} s` } }); }, ms);
    waiting.set(id, (frame) => { clearTimeout(timer); resolve(frame); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  function open() {
    const target = driverCommand(deps.connection());
    if (!target) return null;
    const nextKey = JSON.stringify(target);
    if (child && key === nextKey) return ready;
    stop();
    key = nextKey;
    const proc = spawnImpl(target.command, target.args, { env: { ...process.env, ...target.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child = proc;
    let buffered = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buffered += chunk;
      for (let at = buffered.indexOf("\n"); at !== -1; at = buffered.indexOf("\n")) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        const done = waiting.get(frame?.id);
        if (done) { waiting.delete(frame.id); done(frame); }
      }
    });
    proc.stderr?.on("data", () => {});
    proc.on("error", (error) => { log(`cloud screen: the computer-control helper did not start (${error?.message ?? error})`); if (child === proc) stop(); });
    proc.on("exit", () => { if (child === proc) stop(); });
    ready = send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dusk cloud screen", version: "1" } }, START_MS).then((frame) => {
      if (frame.error) throw new Error(frame.error.message);
      version = typeof frame.result?.serverInfo?.version === "string" ? frame.result.serverInfo.version : "";
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    });
    ready.catch(() => { if (child === proc) stop(); });
    return ready;
  }
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(stop, deps.idleMs ?? IDLE_MS);
    idle.unref?.();
  };

  return {
    /** The driver connection is up (this app's computer control is on and granted). */
    available: () => driverCommand(deps.connection()) !== null,
    version: () => version,
    /** `{ driver, tools }` as the cloud reads it from a mac_screen_tools job. */
    async tools() {
      const started = open();
      if (!started) throw new Error("This computer's computer control is not on.");
      await started;
      touch();
      const frame = await send("tools/list", {}, START_MS);
      if (frame.error) throw new Error(frame.error.message);
      const tools = Array.isArray(frame.result?.tools) ? frame.result.tools : [];
      return { driver: version, tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    },
    /** One driver call; the MCP result, a failed one when it could not be made. */
    async call(name, args, signal) {
      const started = open();
      if (!started) return failed("This computer's computer control is not on: turn it on in dusk bot on this computer.");
      try { await started; } catch (error) { return failed(`The computer-control helper did not start: ${error?.message ?? error}`); }
      if (signal?.aborted) return failed("Stopped on this computer by the person. It did not run.");
      touch();
      const answer = send("tools/call", { name, arguments: args ?? {} }, CALL_MS);
      const stopped = new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ error: { message: "Stopped on this computer by the person." } }), { once: true }));
      const frame = await Promise.race([answer, stopped]);
      touch();
      if (frame.error) return failed(String(frame.error.message ?? "The computer-control helper failed."));
      return frame.result && typeof frame.result === "object" ? frame.result : failed("The computer-control helper gave no result.");
    },
    close: stop,
    ...(deps.requestAccess ? { requestAccess: deps.requestAccess } : {}),
  };
}
