// Reading an engine CLI's `--version` probe and comparing dotted versions.
import { execCli } from "../../procs.ts";

/** Hermes writes its whole `--version` banner to stderr with an empty stdout. */
export function versionFromProbe(stdout: string | undefined, stderr: string | undefined): string | null {
  const out = (stdout ?? "").trim();
  if (out) return out;
  const err = (stderr ?? "").trim().split(/\r\n|\n|\r/, 1)[0]?.trim() ?? "";
  return err || null;
}

export type VersionTriple = readonly [number, number, number];

export function parseVersionTriple(value: string): VersionTriple | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(installed: VersionTriple, floor: VersionTriple): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (installed[i] !== floor[i]) return installed[i] > floor[i];
  }
  return true;
}

/** An engine CLI's `--version`, or the one plain sentence Settings shows when it could not be read; the CLI's own
 * output and environment never reach that sentence. */
export function probeCliVersion(cli: string, env: NodeJS.ProcessEnv, timeout: number): Promise<{ version?: string; reason?: string }> {
  return new Promise((resolve) => {
    execCli(cli, ["--version"], { timeout, env }, (err, stdout, stderr) => {
      if (err) {
        const failure = err as NodeJS.ErrnoException & { killed?: boolean };
        resolve({ reason: failure.code === "ENOENT"
          ? `\`${cli}\` isn't installed, or isn't on this app's PATH. Install it for the user running dusk bot or use Set CLI, then check again.`
          : failure.code === "EACCES" || failure.code === "EPERM"
            ? `\`${cli}\` isn't executable. Check its file permissions, then check again.`
            : failure.killed && failure.code == null
              ? `\`${cli}\` version check timed out after ${Math.round(timeout / 1000)} seconds. Try again in a moment.`
              : `\`${cli}\` version check failed. Run it with --version on the server to diagnose the installation, then check again.` });
        return;
      }
      const version = versionFromProbe(stdout, stderr);
      resolve(version ? { version } : { reason: `\`${cli}\` returned no version. Check the configured executable with --version, then try again.` });
    });
  });
}
