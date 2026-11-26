import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import { antigravityRuntimesRoot } from "../engine-roots.ts";
import { augmentedPath } from "../env-path.ts";
import { downloadMeter, type ProgressSink } from "../install-progress.ts";
import {
  compareSemver,
  fetchAntigravityCliRelease,
  resolveAntigravityReleaseAsset,
  type AntigravityReleaseAsset,
} from "./antigravity-release.ts";

const FREE_SPACE_MARGIN = 256 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 45 * 60_000;
const STAGING_PREFIX = ".install-";
const INSTALL_RECORD = ".install-complete.json";
const ACTIVE_RECORD = "active.json";
const RELEASE_ID_PATTERN = /^[a-f0-9]{64}$/u;

/** Windows refuses to rename or delete a held file with EPERM/EBUSY/EACCES, not "in use" (a just-stopped runtime, an antivirus scan). */
export function transientWindowsFileError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOTEMPTY";
}

export interface RetryOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms));

export async function retryOnWindowsFileLock<T>(step: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 8;
  const sleep = options.sleep ?? wait;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      if (attempt >= attempts || !transientWindowsFileError(error)) throw error;
      await sleep(Math.min(2_000, (options.delayMs ?? 250) * 2 ** (attempt - 1)));
    }
  }
}

export interface AntigravityRuntime {
  executablePath: string;
  source: "managed" | "override" | "path";
  version: string | null;
}

export class AntigravitySetupError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "AntigravitySetupError";
  }
}

interface InstallRecord {
  releaseId: string;
  version: string;
  executable: { name: string; bytes: number };
}

interface ActiveRecord {
  releaseId: string;
}

export interface AntigravityInstallOptions {
  baseDir?: string;
  asset?: AntigravityReleaseAsset | null;
  fetchImpl?: typeof fetch;
  validate?: (runtime: AntigravityRuntime, expectedVersion: string) => Promise<void>;
  onProgress?: ProgressSink;
}

const installs = new Map<string, Promise<AntigravityRuntime>>();

function runtimeRoot(baseDir = DATA_DIR): string {
  return join(antigravityRuntimesRoot(baseDir), `${process.platform}-${process.arch}`);
}

function cliExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "agy.exe" : "antigravity";
}

function pathExecutableNames(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? ["agy.exe", "antigravity.exe"] : ["agy", "antigravity"];
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    await readlink(path);
    return true;
  } catch {
    return false;
  }
}

async function executableFile(path: string, bytes?: number): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile() || (bytes !== undefined && info.size !== bytes)) return false;
    if (process.platform !== "win32") await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function inspectManagedRelease(directory: string, expectedReleaseId: string): Promise<AntigravityRuntime | null> {
  try {
    if (await isSymlink(directory)) return null;
    const recordPath = join(directory, INSTALL_RECORD);
    if (await isSymlink(recordPath)) return null;
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Partial<InstallRecord>;
    if (
      record.releaseId !== expectedReleaseId ||
      typeof record.version !== "string" || !record.version.trim() ||
      record.executable?.name !== cliExecutableName() ||
      !Number.isSafeInteger(record.executable.bytes) || record.executable.bytes <= 0
    ) {
      return null;
    }
    const executablePath = join(directory, record.executable.name);
    if (await isSymlink(executablePath)) return null;
    if (!(await executableFile(executablePath, record.executable.bytes))) return null;
    return { executablePath, source: "managed", version: record.version };
  } catch {
    return null;
  }
}

async function activeManagedRelease(baseDir = DATA_DIR): Promise<AntigravityRuntime | null> {
  const root = runtimeRoot(baseDir);
  const versions = join(root, "versions");
  const activePath = join(root, ACTIVE_RECORD);
  if ((await isSymlink(root)) || (await isSymlink(versions)) || (await isSymlink(activePath))) return null;
  try {
    const active = JSON.parse(await readFile(activePath, "utf8")) as Partial<ActiveRecord>;
    if (typeof active.releaseId !== "string" || !RELEASE_ID_PATTERN.test(active.releaseId)) return null;
    return inspectManagedRelease(join(versions, active.releaseId), active.releaseId);
  } catch {
    return null;
  }
}

async function hasLegacyManagedInstall(baseDir = DATA_DIR): Promise<boolean> {
  try {
    const entries = await readdir(join(runtimeRoot(baseDir), "versions"));
    return entries.some((entry) => RELEASE_ID_PATTERN.test(entry));
  } catch {
    return false;
  }
}

function pathCandidates(binary: string, env: NodeJS.ProcessEnv): string[] {
  if (isAbsolute(binary) || binary.includes("/") || binary.includes("\\")) return [resolve(binary)];
  const pathValue = process.platform === "win32"
    ? Object.entries(env).findLast(([key]) => key.toUpperCase() === "PATH")?.[1]
    : env.PATH;
  return (pathValue ?? augmentedPath())
    .split(delimiter)
    .map((part) => part.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean)
    .map((part) => resolve(part, binary));
}

async function externalRuntime(candidate: string, source: "override" | "path"): Promise<AntigravityRuntime | null> {
  const executablePath = resolve(candidate);
  if (!(await executableFile(executablePath))) return null;
  return { executablePath, source, version: null };
}

// `agy acp` and `acp --login` arrived in 1.5.0; 1.3 and older read `acp` as a stray prompt ("unexpected argument").
export const ANTIGRAVITY_MIN_ACP_VERSION = "1.5.0";
// The Windows build unpacks its runtime into TEMP on every start, which antivirus can stretch.
const VERSION_PROBE_MS = 60_000;
const versionProbes = new Map<string, Promise<string | null>>();
const warnedOld = new Set<string>();
const refusedAcp = new Set<string>();

/** A CLI dusk bot did not install that turned `agy acp --login` away as an unknown command is skipped from now on,
 * so the next status read offers the managed install instead of the same failed sign-in. */
export function markAntigravityRuntimeOutdated(runtime: AntigravityRuntime): void {
  if (runtime.source === "managed" || refusedAcp.has(runtime.executablePath)) return;
  refusedAcp.add(runtime.executablePath);
  console.warn(`antigravity: skipping ${runtime.executablePath} from now on (it does not know acp --login)`);
}

export function parseAntigravityVersion(output: string): string | null {
  return /^\s*v?(\d+\.\d+\.\d+)\b/u.exec(output)?.[1] ?? null;
}

export type AntigravityVersionProbe = (executablePath: string, env: NodeJS.ProcessEnv) => Promise<string | null>;

/** `--version` of a CLI dusk bot did not install, cached per file; null when it could not be read. */
const probeVersion: AntigravityVersionProbe = async (executablePath, env) => {
  let key = executablePath;
  try {
    const info = await stat(executablePath);
    key = `${executablePath}\0${info.size}\0${info.mtimeMs}`;
  } catch {}
  const cached = versionProbes.get(key);
  if (cached) return cached;
  const running = new Promise<string | null>((resolveProbe) => {
    execFile(executablePath, ["--version"], {
      env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
      timeout: VERSION_PROBE_MS,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => resolveProbe(error ? null : parseAntigravityVersion(String(stdout))));
  });
  versionProbes.set(key, running);
  return running;
};
let versionProbe: AntigravityVersionProbe = probeVersion;

/** For tests. */
export function setAntigravityVersionProbe(probe: AntigravityVersionProbe | null): void {
  versionProbe = probe ?? probeVersion;
  versionProbes.clear();
  refusedAcp.clear();
}

/** A CLI found on PATH that reports a version older than `agy acp`, or that sign-in found too old, is skipped; one
 * whose version cannot be read is still tried. */
async function usableExternal(runtime: AntigravityRuntime, env: NodeJS.ProcessEnv): Promise<AntigravityRuntime | null> {
  if (refusedAcp.has(runtime.executablePath)) return null;
  const version = await versionProbe(runtime.executablePath, env);
  if (version && compareSemver(version, ANTIGRAVITY_MIN_ACP_VERSION) < 0) {
    if (!warnedOld.has(runtime.executablePath)) {
      warnedOld.add(runtime.executablePath);
      console.warn(`antigravity: skipping ${runtime.executablePath} (version ${version}, needs ${ANTIGRAVITY_MIN_ACP_VERSION} or newer for acp)`);
    }
    return null;
  }
  return { ...runtime, version };
}

/** Legacy `agy` commands (saved absolute paths, Windows shims) migrate without editing user config. */
export async function resolveAntigravityRuntime(
  binaryPath?: string,
  env: NodeJS.ProcessEnv = process.env,
  baseDir = DATA_DIR,
): Promise<AntigravityRuntime> {
  const override = binaryPath?.trim();
  const legacyCli = override !== undefined && /(?:^|[\\/])agy(?:\.(?:cmd|bat|exe|ps1))?$/iu.test(override);
  let tooOld = false;
  if (override && override !== "agy" && override !== "antigravity") {
    for (const candidate of pathCandidates(override, env)) {
      const found = await externalRuntime(candidate, "override");
      if (!found) continue;
      if (!legacyCli) {
        if (refusedAcp.has(found.executablePath)) {
          throw new AntigravitySetupError(
            "The custom Antigravity executable is too old for dusk bot. Clear the custom path or point it at Antigravity 1.5 or newer.",
          );
        }
        return found;
      }
      const usable = await usableExternal(found, env);
      if (usable) return usable;
      tooOld = true;
    }
    if (!legacyCli) {
      throw new AntigravitySetupError(
        "The custom Antigravity executable is missing or not executable.",
      );
    }
  }

  const managed = await activeManagedRelease(baseDir);
  if (managed) return managed;

  for (const name of pathExecutableNames()) {
    for (const candidate of pathCandidates(name, env)) {
      const found = await externalRuntime(candidate, "path");
      if (!found) continue;
      const usable = await usableExternal(found, env);
      if (usable) return usable;
      tooOld = true;
    }
  }

  if (!resolveAntigravityReleaseAsset()) {
    throw new AntigravitySetupError(
      `Google does not publish an Antigravity runtime for ${process.platform}-${process.arch}. Set a custom executable path.`,
    );
  }
  const hadLegacy = legacyCli || tooOld || (await hasLegacyManagedInstall(baseDir));
  throw new AntigravitySetupError(hadLegacy
    ? "Antigravity now uses Google's official Antigravity CLI. Choose Install official Antigravity, then Sign in with Google."
    : "Antigravity is not installed. Install the official Google runtime to continue.");
}

async function unlockDirectoryTree(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    if (await isSymlink(directory)) return;
    const info = await lstat(directory);
    if (!info.isDirectory()) return;
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory)) {
      const child = join(directory, entry);
      if (await isSymlink(child)) continue;
      const childInfo = await lstat(child).catch(() => null);
      if (childInfo?.isDirectory()) await unlockDirectoryTree(child);
      else if (childInfo?.isFile()) await chmod(child, 0o600).catch(() => {});
    }
  } catch {}
}

async function removeReleaseDirectory(directory: string): Promise<void> {
  await unlockDirectoryTree(directory);
  await retryOnWindowsFileLock(() => rm(directory, { recursive: true, force: true }));
}

async function lockReleaseDirectory(directory: string, executablePath: string): Promise<void> {
  if (process.platform === "win32") return;
  // Prevent the native CLI auto-updater from overwriting the managed binary in place.
  await chmod(executablePath, 0o555);
  await chmod(join(directory, INSTALL_RECORD), 0o400);
  await chmod(directory, 0o500);
}

async function extractTarGzExecutable(
  archivePath: string,
  outputDirectory: string,
  executableName: string,
): Promise<string> {
  let unsafe = false;
  let extracted = 0;
  const tar = await import("tar");
  await tar.x({
    file: archivePath,
    cwd: outputDirectory,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    umask: 0o022,
    filter: (entryPath, entry) => {
      const type = "type" in entry ? entry.type : undefined;
      const name = entryPath.replace(/^(?:\.\/)+/u, "");
      if (type !== "File" || name !== executableName || name.includes("/") || name.includes("\\")) {
        unsafe = true;
        return false;
      }
      extracted += 1;
      if (extracted > 1) {
        unsafe = true;
        return false;
      }
      return true;
    },
  });
  if (unsafe || extracted !== 1) {
    throw new Error("The Antigravity archive must contain one regular executable.");
  }
  const executablePath = join(outputDirectory, executableName);
  const info = await lstat(executablePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_EXECUTABLE_BYTES) {
    throw new Error("The extracted Antigravity executable failed its safety check.");
  }
  return executablePath;
}

async function pruneInactiveReleases(versionsDirectory: string, activeReleaseId: string): Promise<void> {
  try {
    for (const entry of await readdir(versionsDirectory)) {
      if (entry === activeReleaseId || !RELEASE_ID_PATTERN.test(entry)) continue;
      await removeReleaseDirectory(join(versionsDirectory, entry)).catch(() => {});
    }
  } catch {}
}

async function installOnce(options: AntigravityInstallOptions): Promise<AntigravityRuntime> {
  const asset = options.asset === undefined
    ? await fetchAntigravityCliRelease({ fetchImpl: options.fetchImpl })
    : options.asset;
  if (!asset) {
    throw new Error(`Google does not publish an Antigravity runtime for ${process.platform}-${process.arch}.`);
  }
  const releaseId = asset.sha512.slice(0, 64).toLowerCase();
  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error("Invalid Antigravity release checksum.");
  }

  const root = runtimeRoot(options.baseDir);
  const versions = join(root, "versions");
  const destination = join(versions, releaseId);
  const activePath = join(root, ACTIVE_RECORD);
  await mkdir(versions, { recursive: true, mode: 0o700 });

  const existing = await inspectManagedRelease(destination, releaseId);
  if (existing && existing.version === asset.version) {
    await options.validate?.(existing, asset.version);
    writeFileAtomic(activePath, `${JSON.stringify({ releaseId })}\n`, { mode: 0o600 });
    await pruneInactiveReleases(versions, releaseId);
    return existing;
  }

  try {
    const disk = await statfs(versions, { bigint: true });
    const required = BigInt(MAX_DOWNLOAD_BYTES + MAX_EXECUTABLE_BYTES + FREE_SPACE_MARGIN);
    if (disk.bavail * disk.bsize < required) {
      throw new Error(`Antigravity needs at least ${Math.ceil(Number(required) / 1024 / 1024)} MiB of free space to install.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("Antigravity needs")) throw error;
    // statfs is unavailable on a few filesystems.
  }

  // Another process may be installing into this versions folder; the in-memory map cannot protect its staging dir.
  const staging = await mkdtemp(join(versions, `${STAGING_PREFIX}${randomUUID()}-`));
  let failed = false;
  try {
    const archivePath = join(staging, "download");
    const runtimeDirectory = join(staging, "runtime");
    await mkdir(runtimeDirectory, { mode: 0o700 });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await (options.fetchImpl ?? fetch)(asset.url, { signal: controller.signal, redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`Google download failed (${response.status}).`);
      const finalUrl = new URL(response.url || asset.url);
      if (finalUrl.protocol !== "https:" || finalUrl.hostname !== "storage.googleapis.com") {
        throw new Error("The Antigravity download redirected outside storage.googleapis.com.");
      }
      const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
      const lengthHeader = response.headers.get("content-length");
      const declaredBytes = (!encoding || encoding === "identity") && lengthHeader ? Number(lengthHeader) : Number.NaN;
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_DOWNLOAD_BYTES) {
        throw new Error("The Antigravity download exceeded its allowed size.");
      }
      const totalBytes = Number.isSafeInteger(declaredBytes) && declaredBytes > 0
        ? declaredBytes
        : asset.archiveBytes ?? null;
      const handle = await open(archivePath, "wx", 0o600);
      const hash = createHash("sha512");
      const meter = downloadMeter(totalBytes, options.onProgress);
      let downloaded = 0;
      try {
        for await (const raw of response.body as unknown as AsyncIterable<Uint8Array>) {
          const chunk = Buffer.from(raw);
          if (downloaded + chunk.length > MAX_DOWNLOAD_BYTES) {
            throw new Error("The Antigravity download exceeded its allowed size.");
          }
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
            if (bytesWritten <= 0) throw new Error("The Antigravity download could not be written completely.");
            offset += bytesWritten;
          }
          hash.update(chunk);
          downloaded += chunk.length;
          meter.add(chunk.length);
        }
      } finally {
        await handle.close();
      }
      if (downloaded <= 0 || hash.digest("hex") !== asset.sha512.toLowerCase()) {
        throw new Error("The Antigravity download failed its SHA-512 checksum check. Nothing was installed.");
      }
      meter.setup();
    } finally {
      clearTimeout(timeout);
    }

    const executablePath = asset.format === "executable"
      ? join(runtimeDirectory, asset.executable.name)
      : await extractTarGzExecutable(archivePath, runtimeDirectory, asset.executable.name);
    if (asset.format === "executable") {
      await rename(archivePath, executablePath);
    } else {
      await rm(archivePath, { force: true });
    }
    if (process.platform !== "win32") {
      await chmod(executablePath, 0o755);
    }

    const candidate: AntigravityRuntime = {
      executablePath,
      source: "managed",
      version: asset.version,
    };
    await options.validate?.(candidate, asset.version);

    const executableBytes = (await stat(executablePath)).size;
    const record: InstallRecord = {
      releaseId,
      version: asset.version,
      executable: { name: asset.executable.name, bytes: executableBytes },
    };
    await writeFile(join(runtimeDirectory, INSTALL_RECORD), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });

    if (await inspectManagedRelease(destination, releaseId) === null) {
      await removeReleaseDirectory(destination).catch(() => {});
    }
    try {
      await retryOnWindowsFileLock(() => rename(runtimeDirectory, destination));
    } catch (error) {
      const winner = await inspectManagedRelease(destination, releaseId);
      if (!winner) throw error;
    }
    await lockReleaseDirectory(destination, join(destination, asset.executable.name)).catch(() => {});
    const installed = await inspectManagedRelease(destination, releaseId);
    if (!installed) throw new Error("The installed Antigravity runtime is incomplete.");
    writeFileAtomic(activePath, `${JSON.stringify({ releaseId })}\n`, { mode: 0o600 });
    await pruneInactiveReleases(versions, releaseId);
    return installed;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Cleanup must never replace the real error; only this attempt's directory is touched.
    try {
      await removeReleaseDirectory(staging);
    } catch (cleanupError) {
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`antigravity: could not remove the install folder ${staging} (${detail})${failed ? "" : "; the install itself succeeded"}`);
    }
  }
}

export function installAntigravityRuntime(options: AntigravityInstallOptions = {}): Promise<AntigravityRuntime> {
  const key = runtimeRoot(options.baseDir);
  const existing = installs.get(key);
  if (existing) return existing;
  const running = installOnce(options).finally(() => installs.delete(key));
  installs.set(key, running);
  return running;
}

export function antigravityManagedInstallAvailable(): boolean {
  return resolveAntigravityReleaseAsset() !== null;
}
