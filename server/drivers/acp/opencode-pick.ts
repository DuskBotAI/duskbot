// Which OpenCode program a turn runs: the person's own copy on PATH, unless it is older than the build this app pins and
// that build is installed here. OpenCode Go refuses requests without an x-opencode-session header ("MissingSessionID"),
// which older OpenCode builds never send.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";

import { appStandaloneProgram, isAppStandaloneCopy } from "../../engine-standalone.ts";
import { findCliCandidates } from "../../env-path.ts";
import { OPENCODE_STANDALONE } from "./opencode-release.ts";
import { parseVersionTriple, versionAtLeast, versionFromProbe } from "./version-probe.ts";

export interface OpenCodePickDeps {
  own(): string | null;
  found(cli: string, path: string | undefined): string | undefined;
  version(program: string): Promise<string | null>;
}

const versions = new Map<string, Promise<string | null>>();

function probeVersion(program: string): Promise<string | null> {
  let stamp = "-";
  try { const stat = statSync(program); stamp = `${stat.size}:${stat.mtimeMs}`; } catch {}
  const key = `${program}\u0000${stamp}`;
  let read = versions.get(key);
  if (!read) {
    read = new Promise((resolve) => execFile(program, ["--version"], { timeout: 8_000 }, (error, stdout, stderr) => resolve(error ? null : versionFromProbe(stdout, stderr))));
    versions.set(key, read);
  }
  return read;
}

const DEFAULT_DEPS: OpenCodePickDeps = {
  own: () => appStandaloneProgram(OPENCODE_STANDALONE),
  found: (cli, path) => (isAppStandaloneCopy(cli, undefined, path) ? undefined : findCliCandidates(cli, path)[0]),
  version: probeVersion,
};

/** The command to run for `cli`: the app's pinned build when the copy `cli` finds is older than it (or says no version),
 * else `cli` as set. A path the person typed is always kept. */
export async function openCodeCommand(cli: string, path: string | undefined, deps: OpenCodePickDeps = DEFAULT_DEPS): Promise<{ command: string; env?: Record<string, string> }> {
  if (cli !== "opencode") return { command: cli };
  const own = deps.own();
  const found = own ? deps.found(cli, path) : undefined;
  if (!own || !found) return { command: cli };
  const version = parseVersionTriple((await deps.version(found)) ?? "");
  const pinned = parseVersionTriple(OPENCODE_STANDALONE.version)!;
  return version && versionAtLeast(version, pinned) ? { command: cli } : { command: own, env: { ...OPENCODE_STANDALONE.runEnv } };
}
