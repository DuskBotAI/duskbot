import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Paused, type ModelStore } from "./models.ts";

const run = promisify(execFile);

export interface PrefetchDeps {
  models: Pick<ModelStore, "status" | "ensure" | "pauseBackground">;
  /** A bot is answering someone: the download makes way. */
  busy(): boolean;
  onBattery(): Promise<boolean>;
  /** Loads what has arrived, so a call starts warm. */
  warm(): Promise<void>;
  now?: () => number;
  /** Quiet this long after the harness starts before anything is fetched. */
  idleMs?: number;
  checkMs?: number;
  /** After a failed download, wait this long before trying again. */
  retryMs?: number;
}

/** Fetches the built-in voice's models while nothing else is going on, so the first call already has them. Returns
 * the stop. */
export function startPrefetch(deps: PrefetchDeps): () => void {
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? 90_000;
  const retryMs = deps.retryMs ?? 10 * 60_000;
  let quietSince = now();
  let retryAt = 0;
  let running = false;
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      if (deps.models.status().phase === "ready") {
        stop();
        return;
      }
      if (deps.busy() || (await deps.onBattery())) {
        quietSince = now();
        deps.models.pauseBackground();
        return;
      }
      if (running || now() - quietSince < idleMs || now() < retryAt) return;
      running = true;
      deps.models.ensure({ background: true }).then(
        () => deps.warm().catch(() => undefined),
        (error: unknown) => {
          if (!(error instanceof Paused)) retryAt = now() + retryMs;
        },
      ).finally(() => {
        running = false;
      });
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), deps.checkMs ?? 15_000);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  return stop;
}

/** On battery, or in macOS's Low Power Mode. Unknown counts as not. */
export async function onBattery(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    if (platform === "darwin") {
      const [battery, settings] = await Promise.all([
        run("/usr/bin/pmset", ["-g", "batt"], { timeout: 3_000 }),
        run("/usr/bin/pmset", ["-g"], { timeout: 3_000 }),
      ]);
      return /'Battery Power'/.test(battery.stdout) || /lowpowermode\s+1/.test(settings.stdout);
    }
    if (platform === "linux") {
      const root = "/sys/class/power_supply";
      for (const supply of await readdir(root)) {
        const status = await readFile(`${root}/${supply}/status`, "utf8").catch(() => "");
        if (status.trim() === "Discharging") return true;
      }
    }
  } catch {
  }
  return false;
}
