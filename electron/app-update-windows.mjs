// windows installs its own updates with the release's NSIS installer (electron-builder oneClick, per user, so no UAC
// prompt). the updater downloads it and checks its sha256 against the signed manifest's SHA256SUMS; when the app quits,
// after its own shutdown, the installer runs silently: /S, --updated (keeps data and the person's shortcuts, closes what
// is left of the app) and, for "restart to update", --force-run (starts the new version).
// SmartScreen: Windows checks a file's reputation when it is opened through the shell and carries the Mark of the Web
// (a Zone.Identifier stream, which browsers write). this file is written by the app itself, any mark is removed, and it
// is started with CreateProcess (child_process.spawn), so no SmartScreen prompt shows. Smart App Control (Windows 11)
// can still refuse an unsigned installer; the next launch then sees the version did not change (`failed`).
import { spawn as spawnProcess } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { newer } from "./app-update.mjs";

export const TRIED = "installing.json";
export const INSTALL_MAX_AGE_MS = 15 * 60_000;
export const INSTALL_WAIT_MS = 5 * 60_000;
export const RESOURCES_WAIT_MS = 2 * 60_000;
export const UNTRACKED_RESOURCES_WAIT_MS = 30_000;
export const INSTALL_POLL_MS = 500;

/** the installer's arguments: silent, as an update, and starting the app after it when `relaunch` */
export const setupArgs = (relaunch) => ["/S", "--updated", ...(relaunch ? ["--force-run"] : [])];

const writableDir = (dir) => { try { accessSync(dir, constants.W_OK); return true; } catch { return false; } };

/**
 * whether the installer can update the app at `exe`: "portable" for the zip build (no NSIS uninstaller beside it; the
 * installer would add a second copy elsewhere), "readonly" when its folder can't be written, else null
 */
export function windowsPlace(exe, { list = readdirSync, writable = writableDir } = {}) {
  const dir = dirname(exe);
  let names = [];
  try { names = list(dir); } catch { return "portable"; }
  if (!names.some((name) => /^Uninstall .+\.exe$/i.test(name))) return "portable";
  return writable(dir) ? null : "readonly";
}

export function isPidAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function packagedResourcesReady(resourcesPath, exists = existsSync) {
  const serverDir = join(resourcesPath, "server");
  return exists(join(serverDir, "desktop-entry.mjs"))
    && exists(join(serverDir, "index.js"))
    && exists(join(resourcesPath, "ui", "index.html"));
}

function readInstalling(tried, read = (file) => readFileSync(file, "utf8")) {
  try {
    const data = JSON.parse(read(tried));
    if (!data || typeof data.version !== "string") return null;
    return {
      version: data.version,
      pid: Number.isInteger(data.pid) && data.pid > 0 ? data.pid : null,
      startedAt: Number.isFinite(data.startedAt) ? data.startedAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * guards packaged Windows startup while a silent NSIS update is still unpacking `resources\server` and `resources\ui`.
 * returns `{ action: "quit", version }` when an older binary is reopened while a newer installer is still running so
 * Windows does not hold an executable lock, else waits until unpacking finishes (within bounded timeouts) and returns
 * `{ action: "continue", waited, complete }`.
 */
export async function waitForWindowsInstall({
  dir,
  resourcesPath,
  current,
  isQuitting = () => false,
  onWaiting = () => {},
  log = () => {},
  exists = existsSync,
  read = (file) => readFileSync(file, "utf8"),
  alive = isPidAlive,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = INSTALL_POLL_MS,
  maxAgeMs = INSTALL_MAX_AGE_MS,
  installWaitMs = INSTALL_WAIT_MS,
  resourcesWaitMs = RESOURCES_WAIT_MS,
  untrackedWaitMs = UNTRACKED_RESOURCES_WAIT_MS,
}) {
  const tried = join(dir, TRIED);
  const readState = () => {
    const pending = readInstalling(tried, read);
    const age = pending?.startedAt === null || pending?.startedAt === undefined ? null : now() - pending.startedAt;
    const freshPid = Boolean(
      pending?.pid
      && age !== null
      && age >= -60_000
      && age <= maxAgeMs
      && alive(pending.pid),
    );
    const resourcesReady = packagedResourcesReady(resourcesPath, exists);
    return { pending, freshPid, resourcesReady };
  };

  const first = readState();
  if (first.freshPid && first.pending && newer(first.pending.version, current)) {
    log(`app update: ${first.pending.version} installer (pid ${first.pending.pid}) is still running; closing older ${current}`);
    return { action: "quit", version: first.pending.version, waited: false, complete: false };
  }
  if (!first.freshPid && first.resourcesReady) {
    return { action: "continue", waited: false, complete: true };
  }

  const targetVersion = first.pending?.version === current ? current : first.freshPid ? (first.pending?.version ?? null) : null;
  const deadline = now() + (first.freshPid ? installWaitMs : targetVersion ? resourcesWaitMs : untrackedWaitMs);
  log(
    `app update: waiting for Windows install to finish unpacking`
    + `${targetVersion ? ` (${targetVersion})` : ""}`
    + `${first.freshPid ? ` [installer pid ${first.pending.pid}]` : ""}`,
  );
  onWaiting(targetVersion);

  while (!isQuitting() && now() < deadline) {
    await sleep(pollMs);
    if (isQuitting()) break;
    const next = readState();
    if (!next.freshPid && next.resourcesReady) {
      log("app update: Windows install finished unpacking; continuing startup");
      return { action: "continue", waited: true, complete: true };
    }
  }
  const finalState = readState();
  if (!finalState.freshPid && finalState.resourcesReady) {
    return { action: "continue", waited: true, complete: true };
  }
  if (!isQuitting()) {
    log("app update: timed out waiting for Windows install to finish unpacking; continuing startup");
  }
  return { action: "continue", waited: true, complete: false };
}

/**
 * `prepare(file, version)` keeps the verified installer for the quit; `install()` quits to run it and start the new
 * version; `quitting({ ending })` (from will-quit) runs it, without starting the app, also on a plain quit, but never while
 * Windows ends the session (it could be killed half way). `failed(version)`: that version's installer ran and this app is
 * still older.
 */
export function nsisInstaller({ dir, current, quit, spawn = spawnProcess, log = () => {}, now = Date.now }) {
  const tried = join(dir, TRIED);
  let file = null, version = null, relaunch = false, ran = false;
  return {
    async prepare(path, next) {
      // a file this app wrote has no Mark of the Web; one added by anything else would bring SmartScreen back
      try { unlinkSync(`${path}:Zone.Identifier`); } catch { /* none */ }
      file = path;
      version = next;
    },
    install() {
      relaunch = true;
      quit();
    },
    quitting({ ending = false } = {}) {
      if (!file || ran || (ending && !relaunch)) return false;
      ran = true;
      try { writeFileSync(tried, JSON.stringify({ version })); } catch { /* failed() can't tell then */ }
      try {
        const child = spawn(file, setupArgs(relaunch), { detached: true, stdio: "ignore", windowsHide: true });
        if (Number.isInteger(child?.pid) && child.pid > 0) {
          try { writeFileSync(tried, JSON.stringify({ version, pid: child.pid, startedAt: now() })); } catch { /* version alone is saved */ }
        }
        child.on?.("error", (error) => log(`app update: the installer did not start (${error?.code ?? error?.message ?? error})`));
        child.unref?.();
        log(`app update: installing ${version}${relaunch ? " and restarting" : ""}`);
        return true;
      } catch (error) {
        log(`app update: the installer did not start (${error?.code ?? error?.message ?? error})`);
        return false;
      }
    },
    failed(next) {
      try {
        const before = JSON.parse(readFileSync(tried, "utf8"))?.version;
        return before === next && newer(next, current);
      } catch {
        return false;
      }
    },
  };
}
