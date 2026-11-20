import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { ComposeUpdateStatus } from "../shared/server-update.ts";
import type { UpdateCheck } from "./update-check.ts";

type Action = "apply" | "auto" | "enable" | "disable";
const SOCKET = "/run/dusk-compose-updater/control.sock";
const offline: ComposeUpdateStatus = { supported: false, automatic: false, phase: "idle",
  message: "Use Docker Compose on the host, or install the optional host updater." };

function contactHost(path: string, token?: string): Promise<ComposeUpdateStatus> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: SOCKET, path, method: token ? "POST" : "GET",
      signal: AbortSignal.timeout(15_000) }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("error", reject);
      res.on("data", chunk => { data += chunk; if (data.length > 4096) req.destroy(new Error("Invalid host updater response.")); });
      res.on("end", () => {
        try {
          const body = JSON.parse(data);
          if (res.statusCode !== 200) throw new Error(body.error || "The host updater refused the request.");
          resolve(body);
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.end(token);
  });
}

export function createComposeUpdates(deps: {
  check(): Promise<UpdateCheck>;
  idle(): boolean;
  reserve(): (() => void) | null;
  eligible(): boolean;
  host?: typeof contactHost;
}) {
  const host = deps.host ?? contactHost;
  const status = async () => {
    try { return await host("/status"); } catch { return offline; }
  };
  let intent: { token: string; claimed?: boolean; action: Action; current?: string; latest?: string } | undefined;
  let permit: { token: string; expires: number; release?: () => void } | undefined;

  async function request(action: Action) {
    if (!deps.eligible()) throw new Error("This updater requires a single-owner Compose workspace.");
    const check = (action === "apply" || action === "auto") ? await deps.check() : undefined;
    if (check && (!check.available || !check.latest)) throw new Error("There is no newer stable server release.");
    if (check && !deps.idle()) throw new Error("The server is busy. Try again when work finishes.");
    if (intent) throw new Error("Another update request is in progress.");
    const token = randomBytes(32).toString("hex");
    intent = { token, action, current: check?.current, latest: check?.latest };
    try { return await host("/request", token); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error) throw new Error("Could not reach the Compose updater. Start its service on the server host.");
      throw error;
    }
    finally { intent = undefined; }
  }

  // The host redeems an opaque intent against its own running container. A bot with socket access cannot mint one.
  function redeem(step: unknown, token: unknown) {
    if (typeof token !== "string" || !token) return null;
    if (step === "claim" && intent && !intent.claimed && intent.token === token && deps.eligible()) {
      const { action, current, latest } = intent;
      intent.claimed = true;
      if (action === "enable" || action === "disable") return { action };
      if (permit?.release) return null;
      permit = { token: randomBytes(32).toString("hex"), expires: Date.now() + 20 * 60_000 };
      return { action, current, latest, permit: permit.token };
    }
    if (!permit || permit.token !== token) return null;
    if (step === "release") { permit.release?.(); permit = undefined; return { ok: true }; }
    if (step !== "reserve" || permit.expires < Date.now() || permit.release || !deps.eligible()) return null;
    const release = deps.reserve();
    if (!release) return { busy: true };
    const timer = setTimeout(() => { release(); permit = undefined; }, 180_000);
    timer.unref();
    permit.release = () => { clearTimeout(timer); release(); };
    return { ready: true };
  }

  async function tick() {
    if (!deps.eligible() || !deps.idle()) return;
    const state = await status();
    if (state.supported && state.automatic && state.phase !== "updating" && state.phase !== "failed") {
      const check = await deps.check();
      if (check.available) await request("auto");
    }
  }
  return { status, request, redeem, tick };
}
export type ComposeUpdates = ReturnType<typeof createComposeUpdates>;
