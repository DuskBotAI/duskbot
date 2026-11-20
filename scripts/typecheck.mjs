// tsc's project build and the server project need more old-space heap than Node gives by default on a
// machine that reports less memory: with that default (about 2 GB) the run dies with exit 134, "heap out
// of memory", before a single type error is printed. The dev commands raise it to what the same work
// takes, the way the packaged builds already do.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const HEAP_MB = 4096;
/** The two passes `pnpm typecheck` has always meant: the referenced projects, then the server's own. */
export const STEPS = [["-b"], ["-p", "server/tsconfig.json"]];

/** NODE_OPTIONS for the tsc children: `HEAP_MB`, or more when the caller asked for more. */
export function nodeOptionsFor(existing = "") {
  const asked = Number(/--max-old-space-size=(\d+)/.exec(existing)?.[1] ?? 0);
  const rest = existing.replace(/--max-old-space-size=\d+/, "").trim();
  return `--max-old-space-size=${Math.max(HEAP_MB, asked)}${rest ? ` ${rest}` : ""}`;
}

/** Runs every step in order and stops at the first failure, whose status it returns. */
export function typecheck({ env = process.env, spawn = spawnSync } = {}) {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const childEnv = { ...env, NODE_OPTIONS: nodeOptionsFor(env.NODE_OPTIONS) };
  for (const args of STEPS) {
    const done = spawn(process.execPath, [tsc, ...args], { stdio: "inherit", env: childEnv });
    if (done.status !== 0) return done.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(typecheck());
