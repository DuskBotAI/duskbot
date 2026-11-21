// A throwaway dusk bot server for the stress eval: its own data dir under --tmp, a port pair in 8900-8999, one
// OpenAI-compatible engine instance pointed straight at the gateway (streaming, as the app runs it). The key is written
// only into the sandbox's own config.json (0600) and never printed.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Gateway } from "../memory-eval/sandbox.ts";

const taken = new Set<number>();

async function free(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer().once("error", () => resolve(false)).once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function freePair(): Promise<number> {
  for (let port = 8900; port < 8998; port += 2) {
    if (taken.has(port)) continue;
    if ((await free(port)) && (await free(port + 1))) { taken.add(port); return port; }
  }
  throw new Error("no free port pair in 8900-8999");
}

export interface StressServer {
  url: string;
  root: string;
  dataDir: string;
  logPath: string;
  child: ChildProcess;
  close(keep?: boolean): Promise<void>;
}

export type Engine = "openai-compat" | "codex" | "opencode";

/** The one engine instance ("gw") a server's bots run on: the gateway as an OpenAI-compatible endpoint, Codex with the
 * gateway as its Company endpoint, or OpenCode with Zen's free models (no key; needs the network). */
function instanceFor(engine: Engine, gateway: Gateway, models: string[], dataDir: string): Record<string, unknown> {
  if (engine === "codex") {
    mkdirSync(join(dataDir, "codex-home"), { recursive: true });
    return { driver: "codex", displayName: "Eval Codex", environment: { DUSK_COMPANY_API_KEY: gateway.key, CODEX_HOME: join(dataDir, "codex-home") }, config: { managed: { url: gateway.url, models } } };
  }
  if (engine === "opencode") return { driver: "opencodeGo", displayName: "Eval OpenCode" };
  return { driver: "openai-compat", displayName: "Eval gateway", config: { url: gateway.url, key: gateway.key, model: models[0] } };
}

/** `reuseRoot`: start again on the data folder of a server closed with keep, as after a restart. */
export async function launchServer(repo: string, tmp: string, gateway: Gateway, models: string[], extraConfig: Record<string, unknown> = {}, reuseRoot?: string,
  options: { engine?: Engine; env?: Record<string, string> } = {}): Promise<StressServer> {
  const port = await freePair();
  mkdirSync(tmp, { recursive: true });
  const root = reuseRoot ?? mkdtempSync(join(tmp, "srv-"));
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "tmp"), { recursive: true });
  if (!reuseRoot) writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    features: { smartSetupChoices: false },
    instances: { gw: instanceFor(options.engine ?? "openai-compat", gateway, models, dataDir) },
    ...extraConfig,
  }, null, 2), { mode: 0o600 });
  const logPath = join(root, "server.log");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: dataDir,
    TMPDIR: join(dataDir, "tmp"),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TZ: process.env.TZ,
    DUSK_DATA_DIR: dataDir,
    DUSK_PORT: String(port),
    DUSK_WEBHOOK_PORT: String(port + 1),
    DUSK_NO_TEST_BOTS: "1",
    // HOME is the data folder here, so the Vault key would land inside it and saving secrets would be refused
    DUSK_SAVED_SECRETS_KEY_FILE: join(root, "saved-secrets.key"),
    ...(process.env.DUSK_MODEL_DIR ? { DUSK_MODEL_DIR: process.env.DUSK_MODEL_DIR } : {}),
    ...options.env,
    // a live eval that means to run Codex or OpenCode: each has its own CODEX_HOME or HOME here, never the person's sign-in
    ...(options.engine && options.engine !== "openai-compat" ? { DUSK_ALLOW_REAL_ENGINES: "1" } : {}),
  };
  const url = `http://127.0.0.1:${port}`;
  const log = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, ["--experimental-strip-types", join(repo, "server", "index.ts")], { cwd: repo, env, stdio: ["ignore", log, log] });
  closeSync(log);
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited; see ${logPath}`);
    const ok = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) }).then((r) => r.ok ? r.json() : null).catch(() => null) as { app?: string } | null;
    if (ok?.app === "duskbot") break;
    if (Date.now() > deadline) throw new Error(`server did not start; see ${logPath}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    url, root, dataDir, logPath, child,
    async close(keep = false) {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((r) => { child.once("exit", r); setTimeout(r, 8_000); });
      }
      taken.delete(port);
      // an engine's own child (OpenCode) can still be writing for a moment after the server exits
      if (!keep) try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* left for the next tmp clean */ }
    },
  };
}
