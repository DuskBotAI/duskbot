import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { engineFreePath } from "./testing/engine-free-path.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(join(tmpdir(), "dusk-port-conflict-"));
afterAll(async () => { await removeTempDir(home); });

it("a second server on a held port says so and stops, instead of crashing on an unhandled error", async () => {
  const base = await freePortBlock([0, 1]);
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(base, "127.0.0.1", () => resolve()));
  const offline = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => new Response("offline fixture", { status: 503 });')}`;
  const roomyDisk = pathToFileURL(join(SERVER_DIR, "testing", "roomy-disk.mjs")).href;
  const child = spawn(process.execPath, ["--import", roomyDisk, "--import", offline, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."), stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: engineFreePath(home, process.env.PATH), HOME: home, DUSK_DATA_DIR: join(home, ".duskbot"), DUSK_PORT: String(base), DUSK_WEBHOOK_PORT: String(base + 1), DUSK_NO_TEST_BOTS: "1" },
  });
  let said = "";
  child.stderr.on("data", (chunk) => { said += chunk; });
  child.stdout.on("data", (chunk) => { said += chunk; });
  try {
    const outcome = await Promise.race([
      new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code))),
      new Promise((resolve) => setTimeout(() => resolve("still running"), 60_000)),
    ]);
    await waitForExit(child, { signal: "SIGTERM" });
    expect(outcome, said.slice(-2000)).toBe(1);
    expect(said).toMatch(/DUSK_PORT/);
    expect(said).not.toMatch(/Unhandled 'error' event/);
    expect(said).not.toMatch(/EADDRINUSE/);
  } finally {
    holder.close();
    rmSync(join(home, ".duskbot"), { recursive: true, force: true });
  }
}, 90_000);
