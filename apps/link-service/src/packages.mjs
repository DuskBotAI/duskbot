// our private server build and the bot desktop kit (deploy/bot-desktop as a tgz), handed only to a claimed install
// session (never at a public url). each is <dir>/<sha256>.tgz; <dir>/current.json
// {"sha256","version","signature","desktop":{"sha256","image"}} names the ones new installs get (the signature: CI's release
// key over the build, kind vps-package); <dir>/update-policy.json, when there, is the signed update policy
// (apps/cloud-service/scripts/sign-update-policy.ts) the installer checks every build against;
// scripts/build-vps-package.mjs --publish <data dir> writes both. older tgz files keep serving installs already
// under way, so publishing never breaks one mid-download.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const HEX64 = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
const IMAGE = /^[a-z0-9][a-z0-9._/-]{0,150}(:[A-Za-z0-9._-]{1,64})?$/;
const SIGNATURE = /^r1\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]{1,4000}\.[A-Za-z0-9_-]{40,200}$/;

const SEMVER = /^\d+\.\d+\.\d+$/;
export const FLEET_WINDOW_MS = 24 * 3_600_000;

/**
 * the versions linked servers said they run when they last asked for an update (in memory: a restart forgets them, and
 * every server asks again within its poll): `counts()` is `{ windowMs, servers: [{ version, count }], agents: [...] }`,
 * newest version first, and never names a server
 */
export function createFleet(now = Date.now) {
  const seen = new Map();
  const clean = (value) => (typeof value === "string" && SEMVER.test(value) ? value : null);
  const tally = (rows, key) => {
    const counts = new Map();
    for (const row of rows) counts.set(row[key] ?? "unknown", (counts.get(row[key] ?? "unknown") ?? 0) + 1);
    const order = (v) => (v === "unknown" ? [-1] : v.split(".").map(Number));
    return [...counts].map(([version, count]) => ({ version, count })).sort((a, b) => {
      const x = order(a.version), y = order(b.version);
      for (let i = 0; i < 3; i += 1) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (y[i] ?? -1) - (x[i] ?? -1);
      return 0;
    });
  };
  return {
    saw(id, server, agent) { seen.delete(id); seen.set(id, { server: clean(server), agent: clean(agent), at: now() }); },
    counts() {
      for (const [id, row] of seen) if (now() - row.at > FLEET_WINDOW_MS) seen.delete(id);
      const rows = [...seen.values()];
      return { windowMs: FLEET_WINDOW_MS, servers: tally(rows, "server"), agents: tally(rows, "agent") };
    },
  };
}

/** @param {string | null} dir */
export function createPackages(dir) {
  let cached = null;

  /** the build (and desktop kit, when published) to hand out now, or null when none is published */
  function current() {
    if (!dir) return null;
    let mtime;
    try { mtime = statSync(join(dir, "current.json")).mtimeMs; } catch { return null; }
    if (!cached || cached.mtime !== mtime) {
      let value = null;
      try {
        const manifest = JSON.parse(readFileSync(join(dir, "current.json"), "utf8"));
        if (HEX64.test(manifest?.sha256 ?? "")) {
          const desktop = manifest.desktop;
          value = {
            sha256: manifest.sha256, version: VERSION.test(manifest.version ?? "") ? manifest.version : "",
            signature: SIGNATURE.test(manifest.signature ?? "") ? manifest.signature : null,
            desktop: HEX64.test(desktop?.sha256 ?? "") && IMAGE.test(desktop?.image ?? "") ? { sha256: desktop.sha256, image: desktop.image } : null,
          };
        }
      } catch {
        value = null;
      }
      cached = { mtime, value };
    }
    if (!cached.value) return null;
    const file = find(cached.value.sha256);
    if (!file) return null;
    const kit = cached.value.desktop ? find(cached.value.desktop.sha256) : null;
    return { ...cached.value, size: file.size, desktop: kit ? { ...cached.value.desktop, size: kit.size } : null };
  }

  /** a published tgz by its sha256 */
  function find(sha) {
    if (!dir || !HEX64.test(sha)) return null;
    const path = join(dir, `${sha}.tgz`);
    try {
      const stat = statSync(path);
      return stat.isFile() ? { path, size: stat.size } : null;
    } catch {
      return null;
    }
  }

  /** the signed update policy as the installer takes it: its body base64url (no escaping in a shell) and its signature */
  function policy() {
    if (!dir) return null;
    try {
      const doc = JSON.parse(readFileSync(join(dir, "update-policy.json"), "utf8"));
      if (typeof doc?.body !== "string" || doc.body.length > 16_000 || !SIGNATURE.test(doc?.signature ?? "")) return null;
      return { body: Buffer.from(doc.body, "utf8").toString("base64url"), signature: doc.signature };
    } catch {
      return null;
    }
  }

  /** the operator's own update-policy.json says `paused`: linked servers are offered no build (new installs still are) */
  function paused() {
    if (!dir) return false;
    try { return JSON.parse(JSON.parse(readFileSync(join(dir, "update-policy.json"), "utf8")).body).paused === true; } catch { return false; }
  }

  return { current, find, policy, paused };
}
