// the mac app installs its own updates. dusk.bot's signed latest.json names the version and the sha256 of that
// release's SHA256SUMS; the zip for this mac's arch is downloaded from the public downloads repo (or dusk.bot's copy,
// app-update-download.mjs), checked against those sums, and handed to Electron's autoUpdater (Squirrel.Mac) through a
// feed on 127.0.0.1 that only this process knows.
// Squirrel.Mac installs only an app signed with the same Developer ID as the running one (its designated requirement),
// and only one it can replace where it runs, so an unsigned build, or one run from a disk image or a translocated copy,
// is shown how to update by hand instead. Windows downloads its NSIS installer the same way, checked against those sums,
// and runs it silently over the installed app (nsisInstaller); a portable copy, and Linux, are shown a link to their own
// installer.
// a downloaded update installs when the app quits, or at a quiet moment (locked, or no window focused and nobody touched
// the mac for QUIET_IDLE_MS, with no turn, call or dictation running), and the app shows "restart to update" while it waits.
import { execFile, spawn as spawnChild } from "node:child_process";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { accessSync, constants, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, win32 } from "node:path";
import { pipeline } from "node:stream/promises";

import { failReason, resumableDownload, UpdateError } from "./app-update-download.mjs";

export const DESKTOP_MANIFEST_URL = "https://dusk.bot/releases/latest.json";
export const sumsUrl = (version) => `https://dusk.bot/releases/${version}/SHA256SUMS`;
export const zipUrl = (version, name) => `https://github.com/DuskBotAI/duskbot-releases/releases/download/v${version}/${name}`;
/** CI's release keys (apps/cloud-service/src/release-signing.ts pins the same ones; a test keeps them equal) */
export const RELEASE_KEYS = Object.freeze([{ kid: "rel-2026-11", x: "wtwZypDwVPBXZ25XsZOVpd0PZPBbVMhugheUj5_NLIM" }]);
const HOUR_MS = 60 * 60_000;
/** each check lands somewhere in this much more, so every app does not ask dusk.bot in the same minute */
const JITTER_MS = 15 * 60_000;
export const QUIET_IDLE_MS = 10 * 60_000;

/** `{ version, sums }` from a desktop release manifest signed by a pinned key, or null */
export function verifiedRelease(body, keys = RELEASE_KEYS) {
  const parts = typeof body?.signature === "string" ? body.signature.trim().split(".") : [];
  if (parts.length !== 4 || parts[0] !== "r1" || !/^[A-Za-z0-9_-]+$/.test(parts[2]) || !/^[A-Za-z0-9_-]+$/.test(parts[3])) return null;
  const key = keys.find((item) => item.kid === parts[1]);
  if (!key) return null;
  try {
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" });
    if (!verify(null, Buffer.from(parts.slice(0, 3).join(".")), publicKey, Buffer.from(parts[3], "base64url"))) return null;
    const m = JSON.parse(Buffer.from(parts[2], "base64url").toString("utf8"));
    if (m.v !== 1 || m.kind !== "desktop" || !/^\d+\.\d+\.\d+$/.test(m.version ?? "") || !/^[0-9a-f]{64}$/.test(m.sha256 ?? "")) return null;
    return { version: m.version, sums: m.sha256 };
  } catch {
    return null;
  }
}

/** a > b for plain x.y.z versions */
export function newer(a, b) {
  const parse = (value) => /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value))?.slice(1).map(Number);
  const left = parse(a), right = parse(b);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}

function assetIn(sums, name) {
  for (const line of String(sums).split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
    if (match && match[2] === name) return { name, sha256: match[1] };
  }
  return null;
}

/** this arch's zip in a SHA256SUMS text: `{ name, sha256 }`, or null */
export function zipIn(sums, version, arch) {
  return assetIn(sums, `DuskBot-${version}-${arch}.zip`);
}

/** the release's Windows installer in a SHA256SUMS text: `{ name, sha256 }`, or null */
export function setupIn(sums, version) {
  return assetIn(sums, `DuskBot-${version}-setup.exe`);
}

/**
 * whether the running app is signed with a Developer ID (the only kind Squirrel.Mac will update): `codesign -dv` on the
 * bundle names a Developer ID Application authority and a team
 */
export function developerIdSigned(bundle, run = (file, args) => new Promise((resolve) => execFile(file, args, { timeout: 15_000 }, (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`)))) {
  return run("/usr/bin/codesign", ["-dv", "--verbose=4", bundle]).then((out) => /^Authority=Developer ID Application: /m.test(out) && /^TeamIdentifier=[A-Z0-9]{10}$/m.test(out), () => false);
}

const writableDir = (dir) => { try { accessSync(dir, constants.W_OK); return true; } catch { return false; } };

/**
 * whether Squirrel.Mac can replace the app at `bundle`: "move" for a copy macOS translocated (opened straight from
 * Downloads or a disk image without being moved) or one on a read-only disk image, "readonly" when its folder can't be
 * written (an admin's /Applications for a standard account), else null
 */
export function updatePlace(bundle, writable = writableDir) {
  if (bundle.includes("/AppTranslocation/")) return "move";
  if (writable(dirname(bundle))) return null;
  return bundle.startsWith("/Volumes/") ? "move" : "readonly";
}

/**
 * Squirrel.Mac fed from 127.0.0.1: a feed and the verified zip at an unguessable path, for one download, closed after.
 * `autoUpdater` is Electron's.
 */
export function squirrelInstaller({ autoUpdater, timeoutMs = 15 * 60_000 }) {
  return {
    async prepare(file, version) {
      const token = randomBytes(16).toString("hex"), size = statSync(file).size;
      let port = 0;
      const server = createServer((req, res) => {
        if (req.method === "GET" && req.url === `/${token}/feed.json`) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ url: `http://127.0.0.1:${port}/${token}/update.zip`, name: version }));
        }
        if (req.method === "GET" && req.url === `/${token}/update.zip`) {
          res.writeHead(200, { "content-type": "application/zip", "content-length": String(size) });
          return void pipeline(createReadStream(file), res).catch(() => {});
        }
        res.writeHead(404).end();
      });
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      port = server.address().port;
      let done, failed;
      const settled = new Promise((resolve, reject) => { done = resolve; failed = reject; });
      const timer = setTimeout(() => failed(new Error("the update did not unpack in time")), timeoutMs);
      autoUpdater.once("update-downloaded", done);
      autoUpdater.once("error", failed);
      try {
        autoUpdater.setFeedURL({ url: `http://127.0.0.1:${port}/${token}/feed.json`, serverType: "json" });
        autoUpdater.checkForUpdates();
        await settled;
      } finally {
        clearTimeout(timer);
        autoUpdater.removeListener("update-downloaded", done);
        autoUpdater.removeListener("error", failed);
        server.close();
      }
    },
    install() { autoUpdater.quitAndInstall(); },
  };
}

/**
 * whether the NSIS installer can update the Windows app whose executable is `exe`: null when it can, "readonly" for a
 * copy it did not install (the portable zip has no uninstaller beside it) or one in a folder this account can't write
 */
export function windowsUpdatePlace(exe, { productName = "Dusk Bot", exists = existsSync, writable = writableDir } = {}) {
  const dir = win32.dirname(exe);
  if (!exists(win32.join(dir, `Uninstall ${productName}.exe`))) return "readonly";
  return writable(dir) ? null : "readonly";
}

/**
 * runs the verified NSIS installer (electron-builder's oneClick, per-user) over this install once the app quits.
 * electron-builder 26's installer.nsh: `/S` installs without a window, `--updated` closes the running app instead of
 * asking, and `--force-run` starts the new version when it is done. `install()` quits and starts the new version;
 * `quitting()` (main calls it on will-quit) installs a waiting update on any quit, and starts the app again only after
 * `install()`. The installer is spawned detached so it outlives this process.
 */
export function nsisInstaller({ quit, spawn = (file, args) => { const child = spawnChild(file, args, { detached: true, stdio: "ignore" }); child.on("error", () => {}); child.unref(); }, log = () => {} }) {
  let file = null, relaunch = false, launched = false;
  return {
    async prepare(downloaded) { file = downloaded; },
    install() { relaunch = true; quit(); },
    quitting() {
      if (!file || launched) return false;
      launched = true;
      const args = ["--updated", "/S", ...(relaunch ? ["--force-run"] : [])];
      try { spawn(file, args); } catch (error) { log(`app update: the installer did not start (${error instanceof Error ? error.message : String(error)})`); return false; }
      return true;
    },
  };
}

/**
 * quiet enough to restart: nothing runs on this computer's server or in a call (update-when-quiet-main.mjs quietSignals),
 * and the screen is locked, or no window of this app is focused and nobody touched this mac or typed in the app for
 * QUIET_IDLE_MS
 */
export async function quietNow(signals, now = Date.now()) {
  if (signals.busy?.()) return false;
  const away = signals.locked() || (!signals.focused?.() && signals.idleMs() >= QUIET_IDLE_MS && now - (signals.typedAt() ?? 0) >= QUIET_IDLE_MS);
  if (!away) return false;
  try { return (await signals.work()) === null; } catch { return false; }
}

/**
 * whether this launch is the first of a newer version (so the window can say "updated to" once); remembers `current`.
 * with nothing remembered (a version before this one did not), `installedHere` says this updater left `current`'s zip.
 */
export function justUpdated(memory, current, installedHere = () => false) {
  let before = null;
  try { before = memory.read()?.version ?? null; } catch { /* first run, or unreadable */ }
  if (before === current) return false;
  try { memory.write({ version: current }); } catch { /* says it again next time */ }
  return typeof before === "string" ? newer(current, before) : installedHere();
}

export const DOWNLOAD_PAGE = "https://dusk.bot/download";
/** dusk.bot's own copy of a release file, next to its SHA256SUMS (scripts/mirror-release.sh puts it there) */
export const mirrorUrl = (version, name) => `https://dusk.bot/releases/${version}/${name}`;
/** where a release's update zip can come from, in the order they are tried */
export const zipSources = (version, name) => [zipUrl(version, name), mirrorUrl(version, name)];

// the downloads repo keeps the installers under the stable names dusk.bot/download links to
const STABLE = { "setup.exe": "DuskBot-setup.exe", "x86_64.AppImage": "DuskBot.AppImage", "amd64.deb": "DuskBot-amd64.deb" };

/** where a release's Windows installer can come from: the downloads repo keeps it under its stable name on that release */
export const setupSources = (version, name) => [zipUrl(version, STABLE["setup.exe"]), mirrorUrl(version, name)];

/** the installer someone on `platform` runs by hand, named as SHA256SUMS names it, or null */
export function installerIn(sums, version, platform, { appImage = false } = {}) {
  const end = platform === "win32" ? "setup.exe" : platform === "linux" ? (appImage ? "x86_64.AppImage" : "amd64.deb") : null;
  if (!end) return null;
  const name = `DuskBot-${version}-${end}`;
  return String(sums).split("\n").some((line) => /^[0-9a-f]{64} {2}/.test(line.trim()) && line.trim().slice(66) === name) ? name : null;
}

/** a link that downloads `name` itself: dusk.bot's copy when it has one, else the downloads repo's, else the download page */
export async function installerUrl(version, name, fetchImpl = fetch) {
  if (!name) return DOWNLOAD_PAGE;
  try {
    const answer = await fetchImpl(mirrorUrl(version, name), { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    if (answer.ok) return mirrorUrl(version, name);
  } catch { /* the downloads repo then */ }
  const stable = STABLE[name.slice(`DuskBot-${version}-`.length)];
  return stable ? zipUrl(version, stable) : DOWNLOAD_PAGE;
}

/**
 * keeps the app current. on a mac (`installs`) that is Developer ID signed (`signed()`) and runs from a place it may
 * replace (`blocked()` is null), it downloads the update zip and restarts into it; on Windows (`platform` "win32") it
 * downloads the release's installer instead; otherwise the state names what the
 * person can do: `blocked: "move"` (move the app to Applications) or `manual` (`{ version, url }`, a link to download
 * the release by hand). `fallback.check()` (update-notice.mjs) also tells an unsigned build, and any failure.
 * `onState` hears: `available` (a newer version), `progress` (0 to 1) while it downloads, `retrying` while a failed try
 * waits for the next, `ready` once it waits for a restart, `checking` while a check runs, `failed` when the last could
 * not finish. `onFailed(message, { stage, reason })`: `reason` is a short word, never a path.
 */
export function createAppUpdater({ current, arch, dir, fetchImpl = fetch, keys = RELEASE_KEYS, installs = true, platform = "darwin", appImage = false, signed, blocked = async () => null,
  installer, quiet, fallback, onState = () => {}, onFailed = () => {}, log = () => {}, firstDelayMs = 20_000, intervalMs = HOUR_MS, jitterMs = JITTER_MS, random = Math.random,
  quietEveryMs = 60_000, timers = globalThis, download = {} }) {
  let ready = null, available = null, progress = null, timer = null, quietTimer = null, checking = null, installing = false, failed = false, retrying = false, stuck = null, manual = null, kick = null;
  const toldBlocked = new Set();
  const state = () => ({ ready, available, progress, checking: checking !== null, failed, retrying, blocked: stuck, manual });
  const tell = () => onState(state());
  const report = (version, why) => {
    if (toldBlocked.has(`${version}:${why}`)) return;
    toldBlocked.add(`${version}:${why}`);
    try { onFailed(why, { stage: "other", reason: why }); } catch {}
  };

  async function text(url, limit) {
    let response;
    try { response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), cache: "no-store" }); } catch (error) { throw new UpdateError("manifest", failReason(error), String(error?.message ?? error)); }
    if (!response.ok) throw new UpdateError("manifest", `http_${response.status}`, `${new URL(url).pathname} answered ${response.status}`);
    const body = await response.text();
    if (body.length > limit) throw new UpdateError("manifest", "too_large");
    return body;
  }

  /** the newest signed release when it is newer than this app: `{ version, sums }` (the verified SHA256SUMS text) */
  async function lookup() {
    let body;
    try { body = JSON.parse(await text(DESKTOP_MANIFEST_URL, 64 * 1024)); } catch (error) { throw error instanceof UpdateError ? error : new UpdateError("manifest", "bad_json", String(error?.message ?? error)); }
    const release = verifiedRelease(body, keys);
    if (!release) throw new UpdateError("manifest", "not_signed", "the release manifest is not signed by a pinned key");
    if (!newer(release.version, current)) return null;
    const sums = await text(sumsUrl(release.version), 64 * 1024);
    if (createHash("sha256").update(sums).digest("hex") !== release.sums) throw new UpdateError("checksum", "sums_mismatch", "SHA256SUMS does not match the signed manifest");
    return { version: release.version, sums };
  }

  async function run() {
    if (ready) return ready;
    const release = await lookup();
    if (!release) { available = manual = stuck = null; return null; }
    const { version, sums } = release;
    available = version;
    if (!installs) { manual = { version, url: await installerUrl(version, installerIn(sums, version, platform, { appImage }), fetchImpl) }; return null; }
    if (!(await signed())) { manual = { version, url: DOWNLOAD_PAGE }; await fallback.check(); return null; }
    const where = await blocked().catch(() => null);
    if (where === "move") { stuck = "move"; manual = null; report(version, "translocated"); return null; }
    if (where === "readonly") { stuck = null; manual = { version, url: DOWNLOAD_PAGE }; report(version, "read_only"); return null; }
    stuck = manual = null;
    const windows = platform === "win32";
    const zip = windows ? setupIn(sums, version) : zipIn(sums, version, arch);
    if (!zip) throw windows ? new UpdateError("manifest", "no_installer", `release ${version} has no Windows installer`) : new UpdateError("manifest", "no_zip", `release ${version} has no zip for ${arch}`);
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) if (name !== zip.name && name !== `${zip.name}.part`) rmSync(join(dir, name), { recursive: true, force: true });
    const file = join(dir, zip.name);
    progress = 0; retrying = false; tell();
    try {
      await resumableDownload({ sources: (windows ? setupSources : zipSources)(version, zip.name), file, sha256: zip.sha256, fetchImpl, ...download,
        setKick: (fn) => { kick = fn; },
        onProgress: (fraction) => {
          // whole percents, so the window hears at most a hundred changes
          const now = fraction === null ? progress : Math.min(99, Math.floor(fraction * 100)) / 100;
          if (now !== progress || retrying) { progress = now; retrying = false; tell(); }
        },
        onRetry: (error, tries) => { retrying = true; log(`app update: download try ${tries} failed (${failReason(error)}), trying again`); tell(); } });
      try { await installer.prepare(file, version); } catch (error) { throw new UpdateError("install", `install_${failReason(error)}`.slice(0, 40).replace(/_+$/, ""), `the update could not install: ${error instanceof Error ? error.message : String(error)}`); }
    } finally { progress = null; retrying = false; kick = null; }
    ready = version;
    log(`app update: ${ready} is ready; it installs on quit or at a quiet moment`);
    tell();
    watchQuiet();
    return ready;
  }

  function check() {
    if (checking) return checking;
    failed = false;
    checking = run().catch(async (error) => {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      log(`app update: ${message}; telling the person instead`);
      try { onFailed(message, { stage: error instanceof UpdateError ? error.stage : null, reason: failReason(error) }); } catch {}
      await fallback.check();
      return null;
    }).finally(() => { checking = null; tell(); });
    tell();
    return checking;
  }

  function watchQuiet() {
    if (quietTimer) return;
    const look = async () => {
      quietTimer = null;
      if (installing) return;
      if (await quiet().catch(() => false)) return restart();
      quietTimer = timers.setTimeout(look, quietEveryMs);
      quietTimer?.unref?.();
    };
    quietTimer = timers.setTimeout(look, quietEveryMs);
    quietTimer?.unref?.();
  }

  function restart() {
    if (!ready || installing) return false;
    installing = true;
    log(`app update: restarting into ${ready}`);
    installer.install();
    return true;
  }

  const again = (delay) => { timer = timers.setTimeout(() => { void check().finally(() => again(intervalMs + Math.floor(random() * jitterMs))); }, delay); timer?.unref?.(); };
  return {
    check, restart,
    state,
    start() {
      if (timer) return;
      again(firstDelayMs);
    },
    /** the mac woke: a download in flight goes on from where it got (its socket died in the sleep), and the next check
     * comes after `delayMs` (the network needs a moment), then hourly from there */
    soon(delayMs = 30_000) {
      kick?.();
      if (!timer) return;
      timers.clearTimeout(timer);
      again(delayMs);
    },
    stop() { if (timer) timers.clearTimeout(timer); if (quietTimer) timers.clearTimeout(quietTimer); timer = quietTimer = null; },
  };
}
